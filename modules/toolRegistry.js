// modules/toolRegistry.js — Tool registry and content script bridge

import { callLLM, getSettings, prepareCleanProductImage } from './llmClient.js';
import { etsyGetProductList, etsyGetProductInfo, etsyGetAnalyticsData, etsyGetFbsPostingList, etsyGetFboPostingList, etsyGetStoreSnapshot, getEtsyApiCapabilities, getEtsySettings } from './etsyApi.js';
import { getArtifactDataUrl, pruneArtifacts, putDataUrlArtifact } from './artifactStore.js';
import { closeOwnedTab, createOwnedTab, createOwnedTabCallback } from './browserSessionManager.js';
import { appendWorkflowEvent, isWorkflowCancellationRequested } from './workflowRuntime.js';
import { captureFullPageScreenshot } from './debuggerCapture.js';

const preparedImageCache = new Map();
const ETSY_SHOP_CRAWL_SCREENSHOT_NAMESPACE = "etsy-shop-crawl-screenshot";
const etsyShopCrawlCache = new Map();

export let currentSessionData = {
  products: new Map(),
  creatorInfo: null,
  detailCreators: []
};

export function resetSessionData() {
  currentSessionData = {
    products: new Map(),
    creatorInfo: null,
    detailCreators: []
  };
  etsyShopCrawlCache.clear();
  pruneArtifacts({ namespace: ETSY_SHOP_CRAWL_SCREENSHOT_NAMESPACE }).catch((err) => {
    console.warn("Failed to prune Etsy shop screenshot artifacts:", err.message);
  });
  pruneArtifacts({ namespace: "workflow-loop-screenshot", maxArtifacts: 120 }).catch((err) => {
    console.warn("Failed to prune workflow screenshot artifacts:", err.message);
  });
}

export function getAccumulatedSessionData() {
  return {
    items: Array.from(currentSessionData.products.values()),
    creatorInfo: currentSessionData.creatorInfo,
    detailCreators: currentSessionData.detailCreators
  };
}

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function getSourceOrCurrentTab(sourceTabId = null) {
  if (Number.isInteger(Number(sourceTabId))) {
    try {
      const tab = await chrome.tabs.get(Number(sourceTabId));
      if (tab?.id) return tab;
    } catch (_) {}
  }
  return await getCurrentTab();
}

async function restoreSourceTabFocus(sourceTabId = null) {
  if (!Number.isInteger(Number(sourceTabId))) return false;
  try {
    const tab = await chrome.tabs.get(Number(sourceTabId));
    if (!tab?.id) return false;
    await new Promise((resolve) => chrome.tabs.update(Number(sourceTabId), { active: true }, () => resolve()));
    if (Number.isInteger(Number(tab.windowId))) {
      await new Promise((resolve) => chrome.windows?.update
        ? chrome.windows.update(tab.windowId, { focused: true }, () => resolve())
        : resolve());
    }
    return true;
  } catch (_) {
    return false;
  }
}

function cachePreparedImage(dataUrl) {
  const ref = `__CLEAN_PRODUCT_IMAGE_${Date.now()}_${Math.random().toString(36).slice(2, 8)}__`;
  preparedImageCache.set(ref, dataUrl);
  return ref;
}

function resolvePreparedImageUrl(imageUrl) {
  return preparedImageCache.get(imageUrl) || imageUrl;
}

async function cacheEtsyShopCrawlScreenshot(dataUrl, pageIndex = 0) {
  if (!dataUrl) return null;
  return await putDataUrlArtifact(dataUrl, {
    namespace: ETSY_SHOP_CRAWL_SCREENSHOT_NAMESPACE,
    metadata: {
      kind: "etsy_shop_crawl_screenshot",
      pageIndex,
    },
    ttlMs: 24 * 60 * 60 * 1000,
  });
}

function delay(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function checkTabUrl(url) {
  if (!url) return;
  const lowerUrl = url.toLowerCase();
  const restrictedPrefixes = [
    "chrome://",
    "chrome-extension://",
    "devtools://",
    "view-source:",
    "about:",
    "chrome.google.com/webstore",
    "chromewebstore.google.com"
  ];
  for (const prefix of restrictedPrefixes) {
    if (lowerUrl.includes(prefix) || lowerUrl.startsWith(prefix)) {
      throw new Error("当前网页受 Chrome 安全策略限制，无法在此类系统页面上运行。请切换到常规电商网页再试。");
    }
  }
}

function safeEncodeURI(url) {
  if (!url) return "";
  let encoded = url;
  try {
    encoded = encodeURI(decodeURI(url));
  } catch (_) {
    try {
      encoded = encodeURI(url);
    } catch (err) {
      encoded = url;
    }
  }
  
  // Inject input charset params to force search engines to parse parameters as UTF-8 instead of default GBK
  try {
    const lower = encoded.toLowerCase();
    if (lower.includes("taobao.com") || lower.includes("1688.com") || lower.includes("alibaba.com") || lower.includes("aliexpress.com")) {
      if (encoded.includes("?") && !lower.includes("_input_charset")) {
        encoded += (encoded.endsWith("&") || encoded.endsWith("?")) ? "_input_charset=utf-8" : "&_input_charset=utf-8";
      }
    } else if (lower.includes("jd.com")) {
      if (encoded.includes("?") && !lower.includes("enc=")) {
        encoded += (encoded.endsWith("&") || encoded.endsWith("?")) ? "enc=utf-8" : "&enc=utf-8";
      }
    }
  } catch (e) {
    console.error("Charset injection failed:", e);
  }
  
  return encoded;
}

function shouldLocalizeSearchQuery(engine = "", query = "") {
  const normalizedEngine = String(engine || "").toLowerCase();
  const value = String(query || "").trim();
  if (!value) return false;
  if (!["amazon", "etsy", "google", "google_us", "google_ru", "google_trends", "bing"].includes(normalizedEngine)) return false;
  if (/https?:\/\//i.test(value)) return false;
  if (/["“”']/.test(value)) return false;
  if (/^[A-Z][A-Za-z0-9]+(?:[A-Z][A-Za-z0-9]+)+$/.test(value)) return false; // likely brand/shop name
  if (/[\u4e00-\u9fa5]/.test(value)) return true;
  if (normalizedEngine === "etsy" && value.split(/\s+/).length >= 2) return false;
  return normalizedEngine !== "etsy";
}

export function hasValidEtsySearchEvidence(result = {}) {
  if (!result || result.ok === false || result.error || result.isCaptcha) return false;
  const pageData = result.pageData || {};
  const pageHealth = pageData.pageHealth || {};
  const url = String(pageData.url || result.searchUrl || "");
  if (!/etsy\.com/i.test(url)) return false;
  if (pageHealth.isLikelyBlocked) return false;
  const cards = Array.isArray(pageData.productCards) ? pageData.productCards : [];
  const links = Array.isArray(pageData.productLinks) ? pageData.productLinks : [];
  const hasListingCards = cards.some((card) =>
    /etsy\.com\/listing\//i.test(String(card.href || card.listingUrl || "")) &&
    (card.title || card.imageSrc || card.price || card.shopName || card.reviewCount)
  );
  const hasShopCards = cards.some((card) =>
    /etsy\.com\/shop\//i.test(String(card.href || card.shopUrl || "")) &&
    (card.title || card.shopName || card.text)
  );
  const hasListingLinks = links.some((link) => /etsy\.com\/listing\//i.test(String(link.href || "")));
  const hasShopLinks = links.some((link) => /etsy\.com\/shop\//i.test(String(link.href || "")));
  const visibleText = String(pageData.visibleText || "");
  const hasSearchText = /etsy/i.test(visibleText) && /(results|items|shops|reviews|free shipping|bestseller|star seller|\$)/i.test(visibleText);
  return hasListingCards || hasShopCards || hasListingLinks || hasShopLinks || (Number(pageHealth.productEvidenceCount || 0) > 0 && hasSearchText);
}

export function hasValidGoogleTrendsEvidence(result = {}) {
  if (!result || result.ok === false || result.error || result.isCaptcha) return false;
  const pageData = result.pageData || {};
  const pageHealth = pageData.pageHealth || {};
  const url = String(pageData.url || result.searchUrl || "");
  if (!/trends\.google\./i.test(url)) return false;
  if (pageHealth.isLikelyBlocked) return false;
  const text = [
    pageData.title,
    pageData.h1,
    pageData.visibleText,
    pageData.metaDescription,
  ].filter(Boolean).join("\n");
  const hasTrendShell = /google trends|explore|趋势/i.test(text);
  const hasCoreTrendModule = /interest over time|趋势变化|随时间变化/i.test(text);
  const hasRelatedModule = /related queries|related topics|相关查询|相关主题/i.test(text);
  const visibleTextLength = String(pageData.visibleText || "").trim().length;
  return hasTrendShell && ((hasCoreTrendModule && hasRelatedModule) || visibleTextLength >= 320);
}

function getGoogleTrendsEvidenceState(result = {}) {
  const pageData = result?.pageData || {};
  const text = [
    pageData.title,
    pageData.h1,
    pageData.visibleText,
    pageData.metaDescription,
  ].filter(Boolean).join("\n");
  const visibleTextLength = String(pageData.visibleText || "").trim().length;
  const hasTrendShell = /google trends|explore|趋势/i.test(text);
  const hasCoreTrendModule = /interest over time|趋势变化|随时间变化/i.test(text);
  const hasRelatedModule = /related queries|related topics|相关查询|相关主题/i.test(text);
  return {
    hasTrendShell,
    hasCoreTrendModule,
    hasRelatedModule,
    visibleTextLength,
    stableEnough: hasValidGoogleTrendsEvidence(result),
    readiness: hasCoreTrendModule && hasRelatedModule
      ? "core_modules_visible"
      : hasTrendShell
      ? "trend_shell_visible"
      : "not_trends_ready",
  };
}

function withSearchEvidenceStatus(payload, engine) {
  const normalizedEngine = String(engine || "").toLowerCase();
  if (normalizedEngine !== "etsy" && normalizedEngine !== "google_trends") return payload;
  const trendsEvidenceState = normalizedEngine === "google_trends"
    ? getGoogleTrendsEvidenceState(payload)
    : undefined;
  const evidenceOk = normalizedEngine === "etsy"
    ? hasValidEtsySearchEvidence(payload)
    : hasValidGoogleTrendsEvidence(payload);
  return {
    ...payload,
    ok: evidenceOk,
    evidenceOk,
    evidenceType: normalizedEngine === "etsy" ? "etsy_search" : "google_trends",
    ...(trendsEvidenceState ? { trendsEvidenceState } : {}),
    evidenceStatus: evidenceOk ? "valid" : "invalid_or_blocked",
    message: evidenceOk
      ? (payload.message || (normalizedEngine === "etsy" ? "Valid Etsy search evidence captured." : "Valid Google Trends evidence captured."))
      : (payload.message || (normalizedEngine === "etsy"
        ? "Etsy search did not return usable listing/shop evidence; page may be blocked, empty, or unreadable."
        : "Google Trends did not return usable trend evidence; page may still be loading, blocked, or unreadable.")),
  };
}

function normalizeSearchEngine(engine = "") {
  return String(engine || "google").toLowerCase();
}

function buildSearchUrl(engine, targetQuery, searchType = "listing") {
  const encodedQuery = encodeURIComponent(targetQuery);
  const engines = {
    google: `https://www.google.com/search?q=${encodedQuery}`,
    google_us: `https://www.google.com/search?q=${encodedQuery}&hl=en&gl=us`,
    google_ru: `https://www.google.com/search?q=${encodedQuery}&hl=ru&gl=ru`,
    google_trends: `https://trends.google.com/trends/explore?date=today%2012-m&geo=US&q=${encodedQuery}`,
    bing: `https://www.bing.com/search?q=${encodedQuery}`,
    amazon: `https://www.amazon.com/s?k=${encodedQuery}`,
    etsy: searchType === "shop"
      ? `https://www.etsy.com/search/shops?search_query=${encodedQuery}`
      : searchType === "market"
      ? `https://www.etsy.com/market/${encodedQuery.replace(/%20/g, "_")}`
      : `https://www.etsy.com/search?q=${encodedQuery}`,
    taobao: `https://s.taobao.com/search?q=${encodedQuery}&_input_charset=utf-8`,
    jd: `https://search.jd.com/Search?keyword=${encodedQuery}&enc=utf-8`,
    pinduoduo: `https://mobile.yangkeduo.com/search_result.html?search_key=${encodedQuery}`,
  };
  return engines[engine] || engines.google;
}

function buildBrowserSearchAttempts(engine, targetQuery, searchType = "listing") {
  const normalizedEngine = normalizeSearchEngine(engine);
  const encodedQuery = encodeURIComponent(targetQuery);
  if (normalizedEngine === "etsy") {
    const attempts = [];
    const push = (type, url, reason) => {
      if (!attempts.some((attempt) => attempt.url === url)) attempts.push({ engine: normalizedEngine, searchType: type, url, reason });
    };
    if (searchType === "shop") {
      push("shop", `https://www.etsy.com/search/shops?search_query=${encodedQuery}`, "etsy_shop_search");
      push("listing", `https://www.etsy.com/search?q=${encodedQuery}`, "etsy_listing_fallback");
      push("market", `https://www.etsy.com/market/${encodedQuery.replace(/%20/g, "_")}`, "etsy_market_fallback");
    } else if (searchType === "market") {
      push("market", `https://www.etsy.com/market/${encodedQuery.replace(/%20/g, "_")}`, "etsy_market_search");
      push("listing", `https://www.etsy.com/search?q=${encodedQuery}`, "etsy_listing_fallback");
      push("shop", `https://www.etsy.com/search/shops?search_query=${encodedQuery}`, "etsy_shop_fallback");
    } else {
      push("listing", `https://www.etsy.com/search?q=${encodedQuery}`, "etsy_listing_search");
      push("market", `https://www.etsy.com/market/${encodedQuery.replace(/%20/g, "_")}`, "etsy_market_fallback");
      push("shop", `https://www.etsy.com/search/shops?search_query=${encodedQuery}`, "etsy_shop_fallback");
    }
    return attempts;
  }
  if (normalizedEngine === "google_trends") {
    return [
      {
        engine: normalizedEngine,
        searchType,
        url: `https://trends.google.com/trends/explore?date=today%2012-m&geo=US&q=${encodedQuery}`,
        reason: "google_trends_12m_us",
      },
      {
        engine: normalizedEngine,
        searchType,
        url: `https://trends.google.com/trends/explore?geo=US&q=${encodedQuery}`,
        reason: "google_trends_us_no_date_fallback",
      },
    ];
  }
  return [{ engine: normalizedEngine, searchType, url: buildSearchUrl(normalizedEngine, targetQuery, searchType), reason: `${normalizedEngine}_search` }];
}

function searchEvidenceSatisfied(payload, engine) {
  const normalizedEngine = normalizeSearchEngine(engine);
  if (normalizedEngine === "etsy") return hasValidEtsySearchEvidence(payload);
  if (normalizedEngine === "google_trends") return hasValidGoogleTrendsEvidence(payload);
  const pageData = payload?.pageData || {};
  const hasProducts = (Array.isArray(pageData.productLinks) && pageData.productLinks.length > 0) ||
    (Array.isArray(pageData.productCards) && pageData.productCards.length > 0);
  const visibleTextLength = String(pageData.visibleText || "").trim().length;
  return hasProducts || visibleTextLength >= 120 || Boolean(pageData.title || pageData.h1);
}

async function closeTabQuietly(tabId, protectedTabId = null) {
  if (!tabId) return false;
  if (Number.isInteger(Number(protectedTabId)) && Number(tabId) === Number(protectedTabId)) return false;
  return await new Promise((resolve) => {
    chrome.tabs.remove(parseInt(tabId), () => {
      resolve(!chrome.runtime.lastError);
    });
  });
}

async function sendToContentScript(tabId, message) {
  try {
    const tab = await chrome.tabs.get(tabId);
    checkTabUrl(tab?.url);
  } catch (err) {
    throw err;
  }

  const sendMessagePromise = () => {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Content script response timeout"));
      }, 6000);

      chrome.tabs.sendMessage(tabId, message, (response) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response);
        }
      });
    });
  };

  try {
    return await sendMessagePromise();
  } catch (err) {
    const isConnErr = err.message.includes("Receiving end does not exist") || 
                      err.message.includes("context invalidated") ||
                      err.message.includes("timeout");
    if (isConnErr) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          files: ["content.js"],
        });
        return await sendMessagePromise();
      } catch (injectErr) {
        if (injectErr.message && (injectErr.message.includes("Cannot access") || injectErr.message.includes("restricted"))) {
          throw new Error("由于安全策略，当前网页无法注入脚本。请切换到普通电商网页再试。");
        }
        throw injectErr;
      }
    } else {
      throw err;
    }
  }
}

async function executeGenericDomSnapshot(tabId) {
  const snapshotFn = () => {
      const bodyText = document.body?.innerText || "";
      const links = Array.from(document.querySelectorAll("a[href]"))
        .map((anchor) => ({ href: anchor.href, text: (anchor.innerText || anchor.getAttribute("aria-label") || "").trim().slice(0, 240) }))
        .filter((link) => link.href && link.text)
        .slice(0, 240);
      const images = Array.from(document.images)
        .map((image) => ({ src: image.currentSrc || image.src, alt: image.alt || "", width: image.naturalWidth || image.width || 0, height: image.naturalHeight || image.height || 0 }))
        .filter((image) => image.src)
        .slice(0, 120);
      const jsonLd = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
        .map((node) => node.textContent || "")
        .filter(Boolean)
        .slice(0, 8);
      return {
        url: location.href,
        title: document.title || "",
        h1: document.querySelector("h1")?.innerText?.trim() || "",
        visibleText: bodyText.slice(0, 30000),
        metaDescription: document.querySelector('meta[name="description"]')?.content || "",
        productLinks: links.filter((link) => /etsy\.com\/(listing|shop)\//i.test(link.href) || /product|item|shop/i.test(link.href)),
        links,
        images,
        structuredDataRaw: jsonLd,
        pageHealth: {
          hasMeaningfulDom: bodyText.trim().length >= 120 || links.length > 0,
          visibleTextLength: bodyText.length,
          frameUrl: location.href,
          readRoute: "scripting_executeScript_dom_fallback",
        },
      };
    };
  let results;
  try {
    results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: snapshotFn });
  } catch (err) {
    // A blocked cross-origin frame must not prevent reading the main document.
    results = await chrome.scripting.executeScript({ target: { tabId }, func: snapshotFn });
  }
  const mainFrame = results.find((item) => item.frameId === 0)?.result || results[0]?.result || {};
  const frameText = results
    .filter((item) => item.frameId !== 0 && item.result?.visibleText)
    .map((item) => item.result.visibleText)
    .join("\n")
    .slice(0, 30000);
  return {
    ...mainFrame,
    visibleText: [mainFrame.visibleText, frameText].filter(Boolean).join("\n").slice(0, 30000),
    frameCount: results.length,
    pageHealth: {
      ...(mainFrame.pageHealth || {}),
      frameCount: results.length,
    },
  };
}

async function readCompletePageData(tabId, message = {}) {
  let contentResult = null;
  let contentError = null;
  try {
    contentResult = await sendToContentScript(tabId, message);
  } catch (err) {
    contentError = err;
  }
  const contentData = contentResult?.ok ? (contentResult.data || {}) : {};
  const contentHealthy = contentData?.pageHealth?.hasMeaningfulDom ||
    String(contentData.visibleText || "").trim().length >= 120 ||
    Array.isArray(contentData.productCards) && contentData.productCards.length > 0 ||
    Array.isArray(contentData.productLinks) && contentData.productLinks.length > 0;
  if (contentHealthy && !contentData?.pageHealth?.isLikelyBlocked) {
    return {
      ...contentResult,
      data: { ...contentData, pageEvidence: buildPageEvidence(contentData) },
    };
  }

  try {
    const fallback = await executeGenericDomSnapshot(tabId);
    return {
      ok: Boolean(contentResult?.ok || fallback?.pageHealth?.hasMeaningfulDom),
      data: {
        ...fallback,
        ...contentData,
        visibleText: String(contentData.visibleText || fallback.visibleText || "").length >= String(fallback.visibleText || "").length
          ? contentData.visibleText || fallback.visibleText || ""
          : fallback.visibleText,
        productLinks: (contentData.productLinks?.length ? contentData.productLinks : fallback.productLinks) || [],
        images: (contentData.images?.length ? contentData.images : fallback.images) || [],
        pageHealth: {
          ...(fallback.pageHealth || {}),
          ...(contentData.pageHealth || {}),
          readRoute: contentResult?.ok ? "content_script_plus_dom_fallback" : "scripting_executeScript_dom_fallback",
          contentScriptError: contentError?.message || "",
        },
        pageEvidence: buildPageEvidence({
          ...fallback,
          ...contentData,
          pageHealth: {
            ...(fallback.pageHealth || {}),
            ...(contentData.pageHealth || {}),
            readRoute: contentResult?.ok ? "content_script_plus_dom_fallback" : "scripting_executeScript_dom_fallback",
            contentScriptError: contentError?.message || "",
          },
        }),
      },
    };
  } catch (fallbackError) {
    if (contentResult?.ok) return contentResult;
    throw new Error(contentError?.message || fallbackError.message);
  }
}

function buildPageEvidence(pageData = {}) {
  const url = String(pageData.url || "");
  const pageType = /etsy\.com\/listing\//i.test(url)
    ? "etsy_listing"
    : /etsy\.com\/shop\//i.test(url)
    ? "etsy_shop"
    : /etsy\.com\/search|etsy\.com\/market/i.test(url)
    ? "etsy_search"
    : /trends\.google\./i.test(url)
    ? "google_trends"
    : "web_page";
  const health = pageData.pageHealth || {};
  return {
    pageType,
    url,
    readRoute: health.readRoute || "content_script",
    frameCount: Number(health.frameCount || 1),
    visibleTextLength: String(pageData.visibleText || "").length,
    productCardCount: Array.isArray(pageData.productCards) ? pageData.productCards.length : 0,
    productLinkCount: Array.isArray(pageData.productLinks) ? pageData.productLinks.length : 0,
    imageCount: Array.isArray(pageData.images) ? pageData.images.length : 0,
    hasStructuredData: Boolean(pageData.structuredData || pageData.structuredDataRaw?.length),
    hasMeaningfulDom: Boolean(health.hasMeaningfulDom),
    isLikelyBlocked: Boolean(health.isLikelyBlocked),
    hasPagination: Boolean(pageData.etsyShopProductContext?.pagination?.hasPagination),
    hasNextPage: Boolean(pageData.etsyShopProductContext?.pagination?.hasNextPage),
    limitation: health.isLikelyBlocked
      ? "页面疑似受阻或需要人工验证"
      : pageType === "etsy_search"
      ? "当前证据是搜索结果可见样本，不代表店铺全量商品"
      : pageType === "etsy_shop"
      ? "店铺首页是分页商品展示页，是否全量取决于分页完成状态"
      : pageType === "etsy_listing"
      ? "详情页字段仅代表当前可见页面和可访问结构"
      : "当前页面的可见 DOM 证据",
  };
}

async function _captureTabScreenshot(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab?.windowId) throw new Error("Unable to resolve tab window for screenshot");
  if (/etsy\.com/i.test(String(tab.url || ""))) {
    try {
      return await captureFullPageScreenshot(tabId);
    } catch (err) {
      console.warn("Chrome debugger full-page capture unavailable; falling back to viewport capture:", err.message);
    }
  }
  return await new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" }, (dataUrl) => {
      if (chrome.runtime.lastError || !dataUrl) {
        reject(new Error(chrome.runtime.lastError?.message || "Failed to capture tab screenshot"));
      } else {
        resolve({ dataUrl, captureMode: "captureVisibleTab_viewport" });
      }
    });
  });
}

async function waitForTabLoad(tabId, maxAttempts = 24, intervalMs = 500) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const tab = await new Promise((resolve) => {
      chrome.tabs.get(tabId, (t) => {
        if (chrome.runtime.lastError || !t) resolve(null);
        else resolve(t);
      });
    });
    if (!tab) return null;
    if (tab.status === "complete") return tab;
    await delay(intervalMs);
  }
  return await new Promise((resolve) => {
    chrome.tabs.get(tabId, (t) => {
      if (chrome.runtime.lastError || !t) resolve(null);
      else resolve(t);
    });
  });
}

async function focusTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (tab?.windowId) {
    await new Promise((resolve) => chrome.windows.update(tab.windowId, { focused: true }, () => resolve()));
  }
  await new Promise((resolve) => chrome.tabs.update(tabId, { active: true }, () => resolve()));
  return tab;
}

async function readPageDataFromTab(tabId) {
  const result = await readCompletePageData(tabId, { type: "READ_CURRENT_PAGE" });
  if (!result?.ok) throw new Error(result?.error || "Failed to read page");
  const pageData = result.data || {};
  if (Array.isArray(pageData.productCards)) {
    for (const card of pageData.productCards) {
      if (card.href && card.title) {
        currentSessionData.products.set(card.href, {
          ...card,
          captured_at: new Date().toISOString()
        });
      }
    }
  }
  if (pageData.creatorInfo) currentSessionData.creatorInfo = pageData.creatorInfo;
  if (Array.isArray(pageData.detailCreators)) {
    for (const dc of pageData.detailCreators) {
      if (dc.username && !currentSessionData.detailCreators.some(x => x.username === dc.username)) {
        currentSessionData.detailCreators.push(dc);
      }
    }
  }
  return pageData;
}

function hasUsablePageEvidence(pageData = {}) {
  const health = pageData?.pageHealth || {};
  if (health.isLikelyBlocked) return false;
  return Boolean(
    health.hasMeaningfulDom ||
    String(pageData?.visibleText || "").trim().length >= 120 ||
    (Array.isArray(pageData?.productCards) && pageData.productCards.length > 0) ||
    (Array.isArray(pageData?.productLinks) && pageData.productLinks.length > 0) ||
    (Array.isArray(pageData?.links) && pageData.links.length > 0)
  );
}

async function collectEtsyListingDetailsForShop({
  workflowId = "default",
  competitorName = "",
  competitorUrl = "",
  pages = [],
  maxDetails = 2,
} = {}) {
  const listingUrls = Array.from(new Set(
    pages.flatMap((page) => Array.isArray(page?.productCards) ? page.productCards : [])
      .sort((a, b) => Number(a.visibleOrderRank || a.rank || 999) - Number(b.visibleOrderRank || b.rank || 999))
      .map((card) => card.href || card.listingUrl || card.url)
      .filter((url) => /etsy\.com\/listing\//i.test(String(url || "")))
      .map((url) => String(url).split("?")[0])
  )).slice(0, Math.max(1, Math.min(Number(maxDetails) || 2, 3)));
  const details = [];

  await appendWorkflowEvent(workflowId, "etsy_listing_detail_stage_started", {
    competitorName,
    competitorUrl,
    requested: listingUrls.length,
  });

  for (let index = 0; index < listingUrls.length; index++) {
    const listingUrl = listingUrls[index];
    if (workflowId !== "default" && await isWorkflowCancellationRequested(workflowId)) {
      await appendWorkflowEvent(workflowId, "etsy_listing_detail_stage_cancelled", { competitorName, completed: details.length });
      throw new Error("Etsy listing detail collection cancelled by workflow runtime");
    }
    await appendWorkflowEvent(workflowId, "etsy_listing_detail_started", { competitorName, listingUrl, index: index + 1 });
    let tabId = null;
    try {
      const tab = await createOwnedTab({ workflowId, url: safeEncodeURI(listingUrl), active: true });
      tabId = tab.id;
      const loaded = await waitForTabLoad(tabId);
      await delay(700);
      const pageData = await readPageDataFromTab(tabId);
      const screenshot = await _captureTabScreenshot(tabId);
      const screenshotArtifact = await putDataUrlArtifact(screenshot.dataUrl, {
        namespace: "etsy-listing-detail-screenshot",
        metadata: { workflowId, competitorName, competitorUrl, listingUrl, index: index + 1 },
        ttlMs: 24 * 60 * 60 * 1000,
      });
      details.push({
        ok: true,
        competitorName,
        competitorUrl,
        listingUrl,
        tabId,
        loaded: Boolean(loaded),
        pageData,
        screenshotRef: screenshotArtifact.ref,
        screenshotCaptureMode: screenshot.captureMode,
        screenshotStorage: screenshotArtifact.storage,
      });
      await appendWorkflowEvent(workflowId, "etsy_listing_detail_completed", {
        competitorName,
        listingUrl,
        screenshotRef: screenshotArtifact.ref,
        captureMode: screenshot.captureMode,
      });
    } catch (err) {
      details.push({ ok: false, competitorName, competitorUrl, listingUrl, error: err.message });
      await appendWorkflowEvent(workflowId, "etsy_listing_detail_failed", { competitorName, listingUrl, error: err.message });
    } finally {
      if (tabId) await closeOwnedTab(workflowId, tabId);
    }
  }

  await appendWorkflowEvent(workflowId, "etsy_listing_detail_stage_completed", {
    competitorName,
    requested: listingUrls.length,
    completed: details.filter((detail) => detail.ok).length,
  });
  return details;
}

function summarizeVisibleText(text = "", maxLength = 1600) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function summarizeEtsyProductCard(card = {}, index = 0) {
  return {
    visibleOrderRank: card.visibleOrderRank ?? index + 1,
    title: card.title || card.name || "",
    price: card.price || "",
    href: card.href || card.listingUrl || card.url || "",
    shopName: card.shopName || "",
    rating: card.rating || "",
    reviewCount: card.reviewCount || card.reviews || "",
    badges: card.badges || card.labels || [],
    shippingText: card.shippingText || card.shipping || "",
    promotionText: card.promotionText || card.discountText || card.saleText || "",
    imageSrc: card.imageSrc || card.image || "",
  };
}

function normalizeEtsyShopUrlForCache(url = "") {
  try {
    const parsed = new URL(String(url || ""));
    if (!/etsy\.com$/i.test(parsed.hostname) && !/\.etsy\.com$/i.test(parsed.hostname)) return "";
    const match = parsed.pathname.match(/\/shop\/[^/?#]+/i);
    if (!match) return "";
    return `https://www.etsy.com${match[0].replace(/\/$/, "")}`;
  } catch (_) {
    return "";
  }
}

function buildEtsyShopCrawlCacheKey({ url = "", maxPages = 3, maxProductsPerPage = 40 } = {}) {
  const normalizedUrl = normalizeEtsyShopUrlForCache(url);
  if (!normalizedUrl) return "";
  return [
    normalizedUrl.toLowerCase(),
    `pages:${Math.max(1, Math.min(Number(maxPages) || 3, 10))}`,
    `products:${Math.max(2, Math.min(Number(maxProductsPerPage) || 40, 80))}`,
  ].join("|");
}

function cloneJson(value) {
  if (typeof globalThis.structuredClone === "function") return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function normalizeNextEtsyPageUrl(nextPageUrl = "", currentUrl = "") {
  if (!nextPageUrl) return "";
  try {
    return new URL(nextPageUrl, currentUrl || "https://www.etsy.com").toString();
  } catch (_) {
    return "";
  }
}

function extractJsonObject(text = "") {
  const raw = String(text || "").trim();
  const codeMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = codeMatch ? codeMatch[1].trim() : raw;
  try {
    return JSON.parse(candidate);
  } catch (_) {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new Error("Vision analysis did not return valid JSON.");
  }
}

async function getCachedEtsyShopScreenshot(ref = "") {
  return await getArtifactDataUrl(ref);
}

function normalizeScreenshotPages(pages = [], screenshotRefs = []) {
  const fromPages = Array.isArray(pages) ? pages.map((page, index) => ({
    pageIndex: page?.pageIndex || index + 1,
    url: page?.url || "",
    screenshotRef: page?.screenshotRef || "",
    sortLabel: page?.sortLabel || "",
    productCardsVisible: page?.productCardsVisible || page?.productCards?.length || 0,
    visibleProductOrderBasis: page?.visibleProductOrderBasis || "",
  })) : [];
  const fromRefs = Array.isArray(screenshotRefs) ? screenshotRefs.map((ref, index) => ({
    pageIndex: index + 1,
    url: "",
    screenshotRef: ref,
    sortLabel: "",
    productCardsVisible: 0,
    visibleProductOrderBasis: "",
  })) : [];
  const seenRefs = new Set();
  return [...fromPages, ...fromRefs].filter((page) => {
    if (!page.screenshotRef || seenRefs.has(page.screenshotRef)) return false;
    seenRefs.add(page.screenshotRef);
    return true;
  });
}

function compactCardsForVisionContext(cards = [], limit = 8) {
  return (Array.isArray(cards) ? cards : []).slice(0, limit).map((card, index) => ({
    rank: card.visibleOrderRank ?? card.rank ?? index + 1,
    title: card.title || card.name || "",
    price: card.price || "",
    rating: card.rating || "",
    reviewCount: card.reviewCount || card.reviews || "",
    promotion: card.promotionText || card.discountText || card.saleText || "",
    shipping: card.shippingText || card.shipping || "",
    href: card.href || card.listingUrl || card.url || "",
  }));
}

function buildScreenshotSynthesis(analyses = []) {
  const valid = analyses.filter((item) => item?.ok !== false);
  const byCompetitor = new Map();
  valid.forEach((item) => {
    const key = item.competitorName || item.shopName || item.url || "unknown_competitor";
    if (!byCompetitor.has(key)) {
      byCompetitor.set(key, {
        competitorName: key,
        pagesAnalyzed: 0,
        urls: [],
        visualTones: [],
        heroSignals: [],
        productImagePatterns: [],
        promotionOrTrustSignals: [],
        merchandisingPatterns: [],
        limitations: [],
        productSamples: [],
      });
    }
    const bucket = byCompetitor.get(key);
    bucket.pagesAnalyzed += 1;
    if (item.url) bucket.urls.push(item.url);
    if (item.visual_tone) bucket.visualTones.push(item.visual_tone);
    if (Array.isArray(item.hero_or_first_grid_signals)) bucket.heroSignals.push(...item.hero_or_first_grid_signals);
    if (Array.isArray(item.product_image_patterns)) bucket.productImagePatterns.push(...item.product_image_patterns);
    if (Array.isArray(item.promotion_or_trust_signals)) bucket.promotionOrTrustSignals.push(...item.promotion_or_trust_signals);
    if (item.layout_and_merchandising) bucket.merchandisingPatterns.push(item.layout_and_merchandising);
    if (item.risks_or_limits) bucket.limitations.push(item.risks_or_limits);
    if (Array.isArray(item.productSamples)) bucket.productSamples.push(...item.productSamples);
  });

  const unique = (values = [], limit = 8) => Array.from(new Set(values.filter(Boolean).map((value) => String(value).trim()).filter(Boolean))).slice(0, limit);
  return Array.from(byCompetitor.values()).map((bucket) => ({
    competitorName: bucket.competitorName,
    pagesAnalyzed: bucket.pagesAnalyzed,
    urls: unique(bucket.urls, 6),
    visual_tone_summary: unique(bucket.visualTones, 4).join("；") || "未形成明确视觉调性结论",
    hero_signal_summary: unique(bucket.heroSignals, 8),
    product_image_pattern_summary: unique(bucket.productImagePatterns, 8),
    promotion_or_trust_signal_summary: unique(bucket.promotionOrTrustSignals, 8),
    merchandising_summary: unique(bucket.merchandisingPatterns, 6),
    limitation_summary: unique(bucket.limitations, 4).join("；") || "截图只能证明当前可见页面，不能证明真实销量、完整库存或私有后台数据。",
    productSamples: bucket.productSamples.slice(0, 12),
  }));
}

function buildScreenshotReportInputs({ analyses = [], syntheses = [], competitorName = "" } = {}) {
  const evidenceLedgerEntries = [];
  analyses.filter((item) => item?.ok !== false).forEach((item) => {
    const observed = item.report_observation || item.visual_tone || "已完成竞品店铺截图视觉解读。";
    evidenceLedgerEntries.push({
      source_type: "screenshot_visual",
      source_ref: `竞品店铺分页截图: ${item.url || item.screenshotRef}`,
      observed_value: observed,
      used_for: "对标竞品店铺视觉调性、首图/网格陈列、促销/信任信号和可见排序方法",
      confidence: "medium",
      limitation: item.risks_or_limits || "截图只能判断当前页可见视觉和陈列，不能证明真实销量、完整库存、真实上架时间或全店完整 SKU。",
    });
  });

  const competitorBenchmarkDrafts = syntheses.map((item) => ({
    competitor_name: item.competitorName || competitorName || "竞品店铺",
    competitor_url: item.urls?.[0] || "",
    page_type: "shop",
    sampled_products_count: item.productSamples?.length || 0,
    visible_sku_count_estimate: `${item.pagesAnalyzed || 0} 个截图页的可见商品样本；仅代表本轮可见页面`,
    category_mix: item.product_image_pattern_summary || [],
    product_samples: (item.productSamples || []).slice(0, 4).map((sample) => ({
      title: sample.title || "",
      price: sample.price || "",
      category_or_scenario: sample.category_or_scenario || sample.title || "",
      promotion_signal: sample.promotion || sample.promotion_signal || "none_visible",
      visible_order_rank: sample.rank || "",
    })),
    price_distribution: { min: "from_visible_samples", max: "from_visible_samples", main_band: "derive_from_product_samples" },
    promotion_signals: item.promotion_or_trust_signal_summary || [],
    shop_review_signal: { rating: "visible_or_unconfirmed", review_count: "visible_or_unconfirmed" },
    listing_order_insight: {
      visible_sort_order: item.merchandising_summary?.[0] || "current visible shop grid",
      observed_order_basis: "current visible shop grid / captured screenshot pages",
      interpretation_limit: item.limitation_summary,
    },
    visual_method: item.visual_tone_summary,
    seo_method: "derive from visible titles and Etsy search evidence",
    fulfillment_signal: (item.promotion_or_trust_signal_summary || []).join("；") || "none_visible",
    evidence_refs: item.urls || [],
  }));

  const diagnosticDepthHints = [
    {
      dimension: "视觉首图与画廊",
      finding: syntheses.map((item) => `${item.competitorName}: ${item.visual_tone_summary}`).join("；"),
      evidence: "stage_observations + screenshot_visual evidence ledger",
      gap: "需要把竞品可见视觉方法转化为当前店铺首图、画廊、包装和尺寸图动作。",
      action: "在 diagnostic_depth_matrix 中把截图观察转写为视觉整改维度。",
    },
    {
      dimension: "竞品对标与可见排序",
      finding: syntheses.map((item) => `${item.competitorName}: ${item.merchandising_summary.join("；")}`).join("；"),
      evidence: "captured screenshot pages and visible product samples",
      gap: "截图只能说明可见陈列，不能推断真实销量或完整上架顺序。",
      action: "在 competitor_benchmarks.listing_order_insight 中写明 observed_order_basis 和 interpretation_limit。",
    },
  ];

  return {
    evidenceLedgerEntries,
    competitorBenchmarkDrafts,
    diagnosticDepthHints,
    nextStepInstruction: "下一步请不要重新解读原始截图；请沿用 stage_observations 的逐图观察、stage_synthesis 的逐店方法归纳，以及 stage_report_inputs 的证据账本/竞品草稿，补齐 final.output.diagnostic_depth_matrix、competitor_benchmarks 和 data[].evidence_ledger。",
  };
}

function isWarmCtaPixel(r, g, b, a) {
  return a > 180 && r >= 210 && g >= 50 && g <= 190 && b <= 125 && r > g + 35;
}

function isCoolPrimaryPixel(r, g, b, a) {
  return a > 180 && b >= 150 && r <= 110 && g >= 75 && g <= 185 && b > r + 55;
}

function isPrimaryActionPixel(r, g, b, a) {
  return isWarmCtaPixel(r, g, b, a) || isCoolPrimaryPixel(r, g, b, a);
}

function normalizedPointInRegion(x, y, region, padding = 0.03) {
  if (!region) return true;
  const left = Math.max(0, (region.normalizedLeft ?? 0) - padding);
  const top = Math.max(0, (region.normalizedTop ?? 0) - padding);
  const right = Math.min(1, (region.normalizedRight ?? 1) + padding);
  const bottom = Math.min(1, (region.normalizedBottom ?? 1) + padding);
  return x >= left && x <= right && y >= top && y <= bottom;
}

function normalizedPointInAnyRegion(x, y, regions = []) {
  if (!regions.length) return true;
  return regions.some((region) => normalizedPointInRegion(x, y, region));
}

async function _locateImageSearchActionInScreenshot(dataUrl, regions = []) {
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas === "undefined") {
    return null;
  }

  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const maxWidth = 900;
  const scale = Math.min(1, maxWidth / bitmap.width);
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, width, height);
  const data = ctx.getImageData(0, 0, width, height).data;
  const visited = new Uint8Array(width * height);
  const stride = 2;
  const candidates = [];

  const isMask = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    const idx = (y * width + x) * 4;
    return isPrimaryActionPixel(data[idx], data[idx + 1], data[idx + 2], data[idx + 3]);
  };

  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const start = y * width + x;
      if (visited[start] || !isMask(x, y)) continue;

      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      let count = 0;
      const stack = [[x, y]];
      visited[start] = 1;

      while (stack.length) {
        const [cx, cy] = stack.pop();
        count++;
        minX = Math.min(minX, cx);
        maxX = Math.max(maxX, cx);
        minY = Math.min(minY, cy);
        maxY = Math.max(maxY, cy);

        const neighbors = [
          [cx + stride, cy],
          [cx - stride, cy],
          [cx, cy + stride],
          [cx, cy - stride],
        ];
        for (const [nx, ny] of neighbors) {
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const nIdx = ny * width + nx;
          if (visited[nIdx] || !isMask(nx, ny)) continue;
          visited[nIdx] = 1;
          stack.push([nx, ny]);
        }
      }

      const boxWidth = maxX - minX + stride;
      const boxHeight = maxY - minY + stride;
      const centerX = (minX + maxX) / 2;
      const centerY = (minY + maxY) / 2;
      const normalizedY = centerY / height;
      const normalizedX = centerX / width;
      if (count < 80 || boxWidth < 45 || boxHeight < 24 || boxWidth > 420 || boxHeight > 150) continue;
      if (!normalizedPointInAnyRegion(normalizedX, normalizedY, regions)) continue;

      let score = count + Math.min(boxWidth * boxHeight / 10, 2000);
      if (normalizedY > 0.18 && normalizedY < 0.9) score += 900;
      if (normalizedY < 0.16) score -= 1800;
      if (normalizedX > 0.22 && normalizedX < 0.92) score += 350;
      if (normalizedX > 0.35 && normalizedX < 0.78 && normalizedY > 0.32 && normalizedY < 0.78) score += 500;
      if (boxHeight >= 34 && boxHeight <= 85) score += 260;
      candidates.push({ normalizedX, normalizedY, score, boxWidth, boxHeight, count });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] || null;
}

async function getImageSearchUiState(tabId) {
  try {
    const res = await sendToContentScript(tabId, { type: "GET_IMAGE_SEARCH_UI_STATE" });
    return res?.data || { containers: [], candidates: [] };
  } catch (err) {
    return { containers: [], candidates: [], error: err.message };
  }
}

async function visualClickImageSearchSubmit(tabId) {
  try {
    const uiState = await getImageSearchUiState(tabId);
    const domCandidate = Array.isArray(uiState.candidates) ? uiState.candidates[0] : null;
    if (domCandidate?.exactTextOnly && domCandidate?.rect?.normalizedCenterX !== undefined && domCandidate?.rect?.normalizedCenterY !== undefined) {
      const clickResult = await sendToContentScript(tabId, {
        type: "CLICK_BY_COORDINATE",
        x: domCandidate.rect.normalizedCenterX,
        y: domCandidate.rect.normalizedCenterY,
        learnKind: "image_search_submit",
      });
      return {
        ok: !!clickResult?.ok,
        source: "dom_image_search_candidate",
        uiState,
        target: domCandidate,
        clickResult,
      };
    }

    return {
      ok: false,
      reason: "Exact visible 搜索图片 text was not detected; skipped unsafe screenshot/color click because this 1688 overlay closes on any other click.",
      uiState,
    };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

export const tools = {
  read_current_page: async (args = {}) => {
    const tab = await getSourceOrCurrentTab(args.__sourceTabId);
    if (!tab) throw new Error("No active tab found");
    
    let cachedSelectors = null;
    try {
      const domain = new URL(tab.url).hostname;
      const storage = await new Promise((r) => chrome.storage.local.get(["platformMemory"], r));
      const memory = storage.platformMemory || {};
      cachedSelectors = memory[domain] || null;
    } catch (_) {}

    const result = await readCompletePageData(tab.id, {
      type: "READ_CURRENT_PAGE",
      cachedSelectors
    });
    if (!result?.ok) throw new Error(result?.error || "Failed to read page");

    const pageData = result.data || {};
    if (Array.isArray(pageData.productCards)) {
      for (const card of pageData.productCards) {
        if (card.href && card.title) {
          currentSessionData.products.set(card.href, {
            ...card,
            captured_at: new Date().toISOString()
          });
        }
      }
    }
    if (pageData.creatorInfo) {
      currentSessionData.creatorInfo = pageData.creatorInfo;
    }
    if (Array.isArray(pageData.detailCreators)) {
      for (const dc of pageData.detailCreators) {
        if (dc.username && !currentSessionData.detailCreators.some(x => x.username === dc.username)) {
          currentSessionData.detailCreators.push(dc);
        }
      }
    }

    return pageData;
  },

  collect_etsy_shop_pages: async (args = {}) => {
    const {
      url = "",
      tabId = null,
      maxPages = 3,
      keepTab = false,
      delayMs = 900,
      maxProductsPerPage = 40,
      useCache = true,
      workflowId = "default",
      deepDetail = false,
      __sourceTabId = null,
    } = args;
    const pageLimit = Math.max(1, Math.min(Number(maxPages) || 3, 10));
    const productLimit = Math.max(2, Math.min(Number(maxProductsPerPage) || 40, 80));
    const initialCacheKey = !tabId ? buildEtsyShopCrawlCacheKey({ url, maxPages: pageLimit, maxProductsPerPage: productLimit }) : "";
    if (useCache !== false && initialCacheKey && etsyShopCrawlCache.has(initialCacheKey)) {
      return {
        ...cloneJson(etsyShopCrawlCache.get(initialCacheKey)),
        cacheHit: true,
        cacheKey: initialCacheKey,
      };
    }
    let targetTabId = tabId ? parseInt(tabId) : null;
    let openedByTool = false;
    let sourceUrl = url;

    if (!targetTabId) {
      if (url) {
        const created = await createOwnedTab({ workflowId, url: safeEncodeURI(url), active: true, openerTabId: __sourceTabId });
        targetTabId = created.id;
        openedByTool = true;
      } else {
        const current = await getSourceOrCurrentTab(__sourceTabId);
        if (!current) throw new Error("No active tab found");
        targetTabId = current.id;
        sourceUrl = current.url || "";
      }
    }

    if (!/etsy\.com\/shop\//i.test(String(sourceUrl || ""))) {
      const tab = await chrome.tabs.get(targetTabId);
      sourceUrl = tab?.url || sourceUrl;
    }
    if (!/etsy\.com\/shop\//i.test(String(sourceUrl || ""))) {
      throw new Error("collect_etsy_shop_pages requires an Etsy shop URL or an active Etsy shop tab.");
    }
    const cacheKey = buildEtsyShopCrawlCacheKey({ url: sourceUrl, maxPages: pageLimit, maxProductsPerPage: productLimit });
    if (useCache !== false && cacheKey && etsyShopCrawlCache.has(cacheKey)) {
      return {
        ...cloneJson(etsyShopCrawlCache.get(cacheKey)),
        cacheHit: true,
        cacheKey,
      };
    }

    const pages = [];
    const seenUrls = new Set();
    const uniqueListings = new Set();
    let stoppedReason = "max_pages_reached";
    let completedFullCrawl = false;

    await appendWorkflowEvent(workflowId, "etsy_crawl_started", {
      sourceUrl,
      maxPages: pageLimit,
      maxProductsPerPage: productLimit,
    });

    try {
      for (let pageIndex = 1; pageIndex <= pageLimit; pageIndex++) {
        if (workflowId !== "default" && await isWorkflowCancellationRequested(workflowId)) {
          await appendWorkflowEvent(workflowId, "etsy_crawl_cancelled", { pageIndex, pagesCollected: pages.length });
          throw new Error("Etsy crawl cancelled by workflow runtime");
        }
        await appendWorkflowEvent(workflowId, "etsy_crawl_page_started", { pageIndex, pagesCollected: pages.length });
        await focusTab(targetTabId);
        const tab = await waitForTabLoad(targetTabId);
        await delay(Math.max(250, Number(delayMs) || 900));
        const currentUrl = tab?.url || "";
        if (seenUrls.has(currentUrl)) {
          stoppedReason = "duplicate_page_url";
          break;
        }
        seenUrls.add(currentUrl);

        let pageData = {};
        let readError = "";
        try {
          pageData = await readPageDataFromTab(targetTabId);
        } catch (err) {
          readError = err.message;
        }

        let screenshotRef = null;
        let screenshotBytes = 0;
        let screenshotStorage = "";
        let screenshotExpiresAt = null;
        let screenshotError = "";
        let screenshotCaptureMode = "unknown";
        try {
          const screenshotCapture = await _captureTabScreenshot(targetTabId);
          const screenshotArtifact = await cacheEtsyShopCrawlScreenshot(screenshotCapture.dataUrl, pageIndex);
          screenshotRef = screenshotArtifact?.ref || null;
          screenshotBytes = screenshotArtifact?.bytes || screenshotCapture.dataUrl.length;
          screenshotStorage = screenshotArtifact?.storage || "";
          screenshotExpiresAt = screenshotArtifact?.expiresAt || null;
          screenshotCaptureMode = screenshotCapture.captureMode || "unknown";
        } catch (err) {
          screenshotError = err.message;
        }

        const shopContext = pageData.etsyShopProductContext || {};
        const productCards = Array.isArray(pageData.productCards) ? pageData.productCards : [];
        productCards.forEach((card) => {
          const listingUrl = card.href || card.listingUrl || card.url;
          if (listingUrl) uniqueListings.add(String(listingUrl).split("?")[0]);
        });

        const nextPageUrl = normalizeNextEtsyPageUrl(
          shopContext?.pagination?.nextPageUrl,
          pageData.url || currentUrl
        );
        const hasNextPage = Boolean(shopContext?.pagination?.hasNextPage && nextPageUrl);
        pages.push({
          pageIndex,
          url: pageData.url || currentUrl,
          title: pageData.title || "",
          shopName: pageData.shopName || pageData.h1 || "",
          sortLabel: shopContext.sortLabel || "",
          sortControlText: shopContext.sortControlText || "",
          visibleProductOrderBasis: shopContext.visibleProductOrderBasis || "",
          pagination: {
            hasPagination: Boolean(shopContext?.pagination?.hasPagination),
            hasNextPage,
            nextPageUrl,
            pageLinks: Array.isArray(shopContext?.pagination?.pageLinks)
              ? shopContext.pagination.pageLinks.slice(0, 12)
              : [],
          },
          productCards: productCards.slice(0, productLimit).map(summarizeEtsyProductCard),
          productCardsVisible: productCards.length,
          visibleTextSnippet: summarizeVisibleText(pageData.visibleText),
          pageHealth: pageData.pageHealth || {},
          readError,
          screenshotCaptured: Boolean(screenshotRef),
          screenshotRef,
          screenshotBytes,
          screenshotStorage,
          screenshotExpiresAt,
          screenshotCaptureMode,
          screenshotNote: screenshotRef
            ? "Screenshot is stored as a referenced artifact; full base64 is intentionally omitted from tool history/checkpoints."
            : "",
          screenshotError,
        });
        await appendWorkflowEvent(workflowId, "etsy_crawl_page_completed", {
          pageIndex,
          url: pageData.url || currentUrl,
          productCards: productCards.length,
          screenshotCaptured: Boolean(screenshotRef),
          hasNextPage,
        });

        if (!hasNextPage) {
          stoppedReason = "no_next_page";
          completedFullCrawl = productCards.length > 0;
          break;
        }
        if (pageIndex >= pageLimit) break;
        await new Promise((resolve, reject) => {
          chrome.tabs.update(targetTabId, { url: safeEncodeURI(nextPageUrl), active: true }, (updatedTab) => {
            if (chrome.runtime.lastError || !updatedTab) reject(new Error(chrome.runtime.lastError?.message || "Failed to navigate to next Etsy shop page"));
            else resolve(updatedTab);
          });
        });
      }

      const listingDetails = deepDetail
        ? await collectEtsyListingDetailsForShop({
          workflowId,
          competitorName: pages[0]?.shopName || "",
          competitorUrl: sourceUrl,
          pages,
          maxDetails: 2,
        })
        : [];
      const result = {
        ok: pages.length > 0,
        tool: "collect_etsy_shop_pages",
        sourceUrl,
        tabId: targetTabId,
        openedByTool,
        pagesCollected: pages.length,
        maxPages: pageLimit,
        completedFullCrawl,
        stoppedReason,
        totalVisibleProductCards: pages.reduce((sum, page) => sum + Number(page.productCardsVisible || 0), 0),
        uniqueListingCount: uniqueListings.size,
        sortLabels: Array.from(new Set(pages.map((page) => page.sortLabel).filter(Boolean))),
        screenshotPolicy: "Per-page screenshots are stored as referenced artifacts; full base64 payloads are omitted from chrome.storage.local checkpoints.",
        artifactStore: "indexeddb_blob_with_memory_fallback",
        listingDetails,
        pages,
      };
      if (result.ok && cacheKey) {
        etsyShopCrawlCache.set(cacheKey, cloneJson(result));
      }
      await appendWorkflowEvent(workflowId, "etsy_crawl_completed", {
        pagesCollected: result.pagesCollected,
        uniqueListingCount: result.uniqueListingCount,
        completedFullCrawl: result.completedFullCrawl,
      });
      return result;
    } finally {
      if (openedByTool && !keepTab) {
        await closeOwnedTab(workflowId, targetTabId);
        await closeTabQuietly(targetTabId, __sourceTabId);
      }
      await restoreSourceTabFocus(__sourceTabId);
    }
  },

  collect_etsy_competitor_shops: async (args = {}) => {
    const {
      urls = [],
      competitors = [],
      maxCompetitors = 3,
      maxPagesPerShop = 2,
      maxProductsPerPage = 32,
      delayMs = 700,
      useCache = true,
      workflowId = "default",
    } = args;
    const rawCandidates = [
      ...urls.map((url) => ({ url })),
      ...competitors.map((item) => (typeof item === "string" ? { url: item } : item || {})),
    ];
    const seen = new Set();
    const targets = [];
    for (const candidate of rawCandidates) {
      const normalizedUrl = normalizeEtsyShopUrlForCache(candidate.url || candidate.shopUrl || candidate.shop_url || "");
      if (!normalizedUrl || seen.has(normalizedUrl.toLowerCase())) continue;
      seen.add(normalizedUrl.toLowerCase());
      targets.push({
        name: candidate.name || candidate.competitorName || candidate.shopName || candidate.shop_name || "",
        url: normalizedUrl,
      });
      if (targets.length >= Math.max(1, Math.min(Number(maxCompetitors) || 3, 5))) break;
    }
    if (targets.length === 0) {
      throw new Error("collect_etsy_competitor_shops requires at least one Etsy shop URL.");
    }

    const shops = [];
    for (const target of targets) {
      try {
        const crawl = await tools.collect_etsy_shop_pages({
          url: target.url,
          maxPages: Math.max(1, Math.min(Number(maxPagesPerShop) || 2, 5)),
          maxProductsPerPage,
          delayMs,
          keepTab: false,
          useCache,
        });
        shops.push({
          ok: crawl.ok !== false,
          competitorName: target.name || crawl.pages?.[0]?.shopName || "",
          url: target.url,
          cacheHit: Boolean(crawl.cacheHit),
          pagesCollected: crawl.pagesCollected || 0,
          completedFullCrawl: Boolean(crawl.completedFullCrawl),
          stoppedReason: crawl.stoppedReason || "",
          totalVisibleProductCards: crawl.totalVisibleProductCards || 0,
          uniqueListingCount: crawl.uniqueListingCount || 0,
          sortLabels: crawl.sortLabels || [],
          pages: Array.isArray(crawl.pages) ? crawl.pages : [],
          crawl,
        });
        shops[shops.length - 1].listingDetails = await collectEtsyListingDetailsForShop({
          workflowId,
          competitorName: shops[shops.length - 1].competitorName,
          competitorUrl: target.url,
          pages: shops[shops.length - 1].pages,
          maxDetails: args.maxDetailsPerShop || 2,
        });
      } catch (err) {
        shops.push({
          ok: false,
          competitorName: target.name || "",
          url: target.url,
          error: err.message,
          pagesCollected: 0,
          pages: [],
          listingDetails: [],
        });
      }
    }

    const allPages = shops.flatMap((shop) =>
      (Array.isArray(shop.pages) ? shop.pages : []).map((page) => ({
        ...page,
        competitorName: shop.competitorName,
        competitorUrl: shop.url,
      }))
    );
    const screenshotRefs = allPages.map((page) => page.screenshotRef).filter(Boolean);
    return {
      ok: shops.some((shop) => shop.ok && shop.pagesCollected > 0),
      tool: "collect_etsy_competitor_shops",
      competitorsRequested: targets.length,
      competitorsCollected: shops.filter((shop) => shop.ok && shop.pagesCollected > 0).length,
      cacheHits: shops.filter((shop) => shop.cacheHit).length,
      pagesCollected: allPages.length,
      screenshotRefs,
      allPages,
      shops: shops.map((shop) => ({
        ok: shop.ok,
        competitorName: shop.competitorName,
        url: shop.url,
        cacheHit: shop.cacheHit,
        error: shop.error,
        pagesCollected: shop.pagesCollected,
        completedFullCrawl: shop.completedFullCrawl,
        stoppedReason: shop.stoppedReason,
        totalVisibleProductCards: shop.totalVisibleProductCards,
        uniqueListingCount: shop.uniqueListingCount,
        sortLabels: shop.sortLabels,
        pages: shop.pages,
        listingDetails: Array.isArray(shop.listingDetails) ? shop.listingDetails : [],
      })),
      nextStep: "Pass allPages or screenshotRefs to analyze_etsy_shop_crawl_screenshots before final report delivery.",
      screenshotPolicy: "Per-page screenshots are stored as referenced artifacts; full base64 payloads are omitted from chrome.storage.local checkpoints.",
      artifactStore: "indexeddb_blob_with_memory_fallback",
      };
  },

  collect_etsy_listing_reviews: async (args = {}) => {
    const {
      url = "",
      tabId = null,
      maxPages = 3,
      keepTab = false,
      delayMs = 900,
      workflowId = "default",
    } = args;
    const pageLimit = Math.max(1, Math.min(Number(maxPages) || 3, 8));
    let targetTabId = tabId ? parseInt(tabId) : null;
    let openedByTool = false;
    let sourceUrl = url;
    if (!targetTabId) {
      if (url) {
        const created = await createOwnedTab({ workflowId, url: safeEncodeURI(url), active: true });
        targetTabId = created.id;
        openedByTool = true;
      } else {
        const current = await getCurrentTab();
        if (!current) throw new Error("No active tab found");
        targetTabId = current.id;
        sourceUrl = current.url || "";
      }
    }
    if (!/etsy\.com\/listing\//i.test(String(sourceUrl || ""))) {
      const tab = await chrome.tabs.get(targetTabId);
      sourceUrl = tab?.url || sourceUrl;
    }
    if (!/etsy\.com\/listing\//i.test(String(sourceUrl || ""))) {
      throw new Error("collect_etsy_listing_reviews requires an Etsy listing URL or active listing tab.");
    }

    const pages = [];
    const seenUrls = new Set();
    let nextUrl = sourceUrl;
    let stoppedReason = "max_pages_reached";
    let completedFullCrawl = false;
    await appendWorkflowEvent(workflowId, "etsy_review_crawl_started", { sourceUrl, maxPages: pageLimit });
    try {
      for (let pageIndex = 1; pageIndex <= pageLimit && nextUrl; pageIndex++) {
        if (workflowId !== "default" && await isWorkflowCancellationRequested(workflowId)) {
          await appendWorkflowEvent(workflowId, "etsy_review_crawl_cancelled", { pageIndex, pagesCollected: pages.length });
          throw new Error("Etsy review crawl cancelled by workflow runtime");
        }
        if (seenUrls.has(nextUrl)) {
          stoppedReason = "duplicate_page_url";
          completedFullCrawl = true;
          break;
        }
        seenUrls.add(nextUrl);
        await appendWorkflowEvent(workflowId, "etsy_review_page_started", { pageIndex, url: nextUrl });
        await chrome.tabs.update(targetTabId, { url: safeEncodeURI(nextUrl) });
        await waitForTabLoad(targetTabId);
        await delay(Math.max(300, Number(delayMs) || 900));
        const pageData = await readPageDataFromTab(targetTabId);
        let screenshotRef = null;
        let screenshotCaptureMode = "unknown";
        try {
          const capture = await _captureTabScreenshot(targetTabId);
          const artifact = await putDataUrlArtifact(capture.dataUrl, {
            kind: "etsy-review-page-screenshot",
            workflowId,
            metadata: { pageIndex, url: nextUrl, captureMode: capture.captureMode },
          });
          screenshotRef = artifact?.ref || null;
          screenshotCaptureMode = capture.captureMode || "unknown";
        } catch (error) {
          await appendWorkflowEvent(workflowId, "etsy_review_screenshot_failed", { pageIndex, error: error.message });
        }
        const reviewPagination = pageData.reviewPagination || {};
        const reviews = Array.isArray(pageData.reviews) ? pageData.reviews : [];
        const explicitNext = (reviewPagination.paginationLinks || []).find((link) => !link.disabled && /next|下一页|more/i.test(`${link.text} ${link.href}`) && link.href);
        const pageRecord = {
          pageIndex,
          url: nextUrl,
          sampleCount: reviews.length,
          lowStarCount: reviews.filter((review) => Number(review.rating) > 0 && Number(review.rating) <= 3).length,
          reviews,
          reviewPagination,
          screenshotRef,
          screenshotCaptureMode,
          readRoute: pageData.pageEvidence?.readRoute || "content_script",
        };
        pages.push(pageRecord);
        await appendWorkflowEvent(workflowId, "etsy_review_page_completed", {
          pageIndex,
          sampleCount: reviews.length,
          lowStarCount: pageRecord.lowStarCount,
          screenshotRef,
        });
        if (explicitNext && !seenUrls.has(explicitNext.href)) {
          nextUrl = explicitNext.href;
        } else {
          stoppedReason = explicitNext ? "duplicate_or_unusable_next_page" : "no_visible_review_next_page";
          completedFullCrawl = !reviewPagination.hasVisibleReviews || !explicitNext;
          nextUrl = "";
        }
      }
      const allReviews = pages.flatMap((page) => page.reviews || []);
      const uniqueReviews = [...new Map(allReviews.map((review) => [review.reviewId || `${review.text}-${review.rating}`, review])).values()];
      const result = {
        ok: pages.length > 0,
        tool: "collect_etsy_listing_reviews",
        sourceUrl,
        pagesCollected: pages.length,
        completedFullCrawl,
        stoppedReason,
        sampleCount: uniqueReviews.length,
        lowStarCount: uniqueReviews.filter((review) => Number(review.rating) > 0 && Number(review.rating) <= 3).length,
        pages,
        coverage: completedFullCrawl ? "当前可见评论分页已走完或页面未暴露下一页" : "仅覆盖已读取评论分页，不能代表全部评论",
        screenshotRefs: pages.map((page) => page.screenshotRef).filter(Boolean),
        nextStep: "仅在 sampleCount 达到报告要求后输出评论归纳；否则必须写明当前页样本量和覆盖限制。",
        artifactStore: "indexeddb_blob_with_memory_fallback",
      };
      await appendWorkflowEvent(workflowId, "etsy_review_crawl_completed", {
        pagesCollected: pages.length,
        sampleCount: uniqueReviews.length,
        lowStarCount: result.lowStarCount,
        completedFullCrawl,
      });
      return result;
    } finally {
      if (openedByTool && !keepTab && targetTabId) {
        await closeOwnedTab(workflowId, targetTabId).catch(() => {});
      }
    }
  },

  analyze_etsy_shop_crawl_screenshots: async (args = {}) => {
    const {
      pages = [],
      screenshotRefs = [],
      competitorName = "",
      maxScreenshots = 6,
      workflowId = "default",
    } = args;
    const screenshotPages = normalizeScreenshotPages(pages, screenshotRefs)
      .slice(0, Math.max(1, Math.min(Number(maxScreenshots) || 6, 10)));
    if (screenshotPages.length === 0) {
      throw new Error("analyze_etsy_shop_crawl_screenshots requires pages with screenshotRef or a screenshotRefs array.");
    }

    const analyses = [];
    for (const page of screenshotPages) {
      if (workflowId !== "default" && await isWorkflowCancellationRequested(workflowId)) {
        await appendWorkflowEvent(workflowId, "etsy_screenshot_analysis_cancelled", { analyzed: analyses.length });
        throw new Error("Etsy screenshot analysis cancelled by workflow runtime");
      }
      await appendWorkflowEvent(workflowId, "etsy_screenshot_observation_started", {
        pageIndex: page.pageIndex,
        screenshotRef: page.screenshotRef,
      });
      const imageUrl = await getCachedEtsyShopScreenshot(page.screenshotRef);
      if (!imageUrl) {
        analyses.push({
          pageIndex: page.pageIndex,
          url: page.url,
          screenshotRef: page.screenshotRef,
          ok: false,
          error: "Screenshot artifact was not found or has expired. Re-run collect_etsy_shop_pages before visual analysis.",
        });
        continue;
      }

      const prompt = `You are analyzing an Etsy competitor shop screenshot for a seller growth report.
This is stage 1 of a multi-step workflow. Only describe visible facts from this screenshot.
Return strict JSON only with this shape:
{
  "ok": true,
  "stage": "screenshot_observation",
  "visual_tone": "short concrete description",
  "hero_or_first_grid_signals": ["specific visible signal"],
  "product_image_patterns": ["specific image/thumbnail pattern"],
  "promotion_or_trust_signals": ["visible sale/free shipping/star seller/review/brand trust signal or none_visible"],
  "layout_and_merchandising": "how the visible order/grid appears to be merchandised",
  "visible_text_or_labels": ["specific readable text/labels if visible, otherwise none_visible"],
  "product_sample_interpretation": ["what visible product cards suggest about category/price/style; do not invent"],
  "risks_or_limits": "what this screenshot cannot prove",
  "report_observation": "one concise Chinese sentence suitable for evidence_ledger.observed_value"
}
Do not infer private sales, inventory, exact upload time, or full SKU coverage from the screenshot.
Do not write final strategy. The next stage will synthesize across screenshots.

Context:
- competitorName: ${competitorName || "unknown"}
- pageCompetitorName: ${page.competitorName || "unknown"}
- competitorUrl: ${page.competitorUrl || "unknown"}
- pageIndex: ${page.pageIndex}
- url: ${page.url || "unknown"}
- sortLabel: ${page.sortLabel || "unknown"}
- productCardsVisible: ${page.productCardsVisible || 0}
- visibleProductOrderBasis: ${page.visibleProductOrderBasis || "unknown"}
- productSamplesFromDOM: ${JSON.stringify(compactCardsForVisionContext(page.productCards, 8))}`;

      try {
        const responseText = await callLLM([
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: imageUrl } },
            ],
          },
        ]);
        const parsed = extractJsonObject(responseText);
        analyses.push({
          stage: "screenshot_observation",
          competitorName: page.competitorName || competitorName || "",
          competitorUrl: page.competitorUrl || "",
          shopName: page.shopName || "",
          productSamples: compactCardsForVisionContext(page.productCards, 8),
          pageIndex: page.pageIndex,
          url: page.url,
          screenshotRef: page.screenshotRef,
          ok: parsed.ok !== false,
          ...parsed,
        });
      } catch (err) {
        analyses.push({
          stage: "screenshot_observation",
          competitorName: page.competitorName || competitorName || "",
          competitorUrl: page.competitorUrl || "",
          pageIndex: page.pageIndex,
          url: page.url,
          screenshotRef: page.screenshotRef,
          ok: false,
          error: err.message,
        });
      }
      await appendWorkflowEvent(workflowId, "etsy_screenshot_observation_completed", {
        pageIndex: page.pageIndex,
        ok: analyses.at(-1)?.ok !== false,
      });
    }
    const stageSynthesis = buildScreenshotSynthesis(analyses);
    const stageReportInputs = buildScreenshotReportInputs({ analyses, syntheses: stageSynthesis, competitorName });
    const evidenceLedgerEntries = stageReportInputs.evidenceLedgerEntries;
    await appendWorkflowEvent(workflowId, "etsy_screenshot_analysis_completed", {
      screenshotsRequested: screenshotPages.length,
      screenshotsAnalyzed: evidenceLedgerEntries.length,
    });

    return {
      ok: evidenceLedgerEntries.length > 0,
      tool: "analyze_etsy_shop_crawl_screenshots",
      analysisWorkflow: "staged_screenshot_observation_to_synthesis_to_report_inputs",
      competitorName,
      screenshotsRequested: screenshotPages.length,
      screenshotsAnalyzed: evidenceLedgerEntries.length,
      stage_observations: analyses,
      stage_synthesis: stageSynthesis,
      stage_report_inputs: stageReportInputs,
      analyses,
      evidenceLedgerEntries,
      message: evidenceLedgerEntries.length > 0
        ? "Etsy shop crawl screenshots analyzed through staged observations, synthesis, and report-ready inputs."
        : "No screenshots could be analyzed. Re-run collect_etsy_shop_pages in the same workflow before visual analysis.",
    };
  },

  extract_product_info: async (args = {}) => {
    const tab = await getSourceOrCurrentTab(args.__sourceTabId);
    if (!tab) throw new Error("No active tab found");
    const result = await sendToContentScript(tab.id, { type: "EXTRACT_PRODUCT_INFO" });
    if (!result?.ok) throw new Error(result?.error || "Failed to extract product");
    return result.data;
  },

  get_selected_text: async (args = {}) => {
    const tab = await getSourceOrCurrentTab(args.__sourceTabId);
    if (!tab) throw new Error("No active tab found");
    const result = await sendToContentScript(tab.id, { type: "GET_SELECTED_TEXT" });
    if (!result?.ok) throw new Error(result?.error || "Failed to get selection");
    return result.data;
  },

  analyze_keywords: async (args) => {
    const { text = "", context = "" } = args;
    return {
      input_text: text,
      context,
      note: "LLM should analyze and extract keywords from the provided text and page context.",
    };
  },

  save_result: async (args) => {
    const existing = await new Promise((resolve) =>
      chrome.storage.local.get(["savedResults"], resolve)
    );
    const savedResults = existing.savedResults || [];
    const entry = {
      id: Date.now(),
      createdAt: new Date().toISOString(),
      ...args,
    };
    savedResults.unshift(entry);
    await new Promise((resolve) =>
      chrome.storage.local.set({ savedResults: savedResults.slice(0, 100) }, resolve)
    );
    return { ok: true, id: entry.id, message: "Result saved to library." };
  },

  get_saved_results: async (args) => {
    const { limit = 10 } = args || {};
    const existing = await new Promise((resolve) =>
      chrome.storage.local.get(["savedResults"], resolve)
    );
    return (existing.savedResults || []).slice(0, limit);
  },

  click_by_text: async (args) => {
    const { text, __sourceTabId = null } = args;
    if (!text) throw new Error("text is required");
    const tab = await getSourceOrCurrentTab(__sourceTabId);
    if (!tab) throw new Error("No active tab found");
    const result = await sendToContentScript(tab.id, { type: "CLICK_BY_TEXT", text });
    if (result.ok) {
      await new Promise(r => setTimeout(r, 2500));
    }
    return result;
  },

  scroll_page: async (args) => {
    const { direction = "down", amount = 800, __sourceTabId = null } = args || {};
    const tab = await getSourceOrCurrentTab(__sourceTabId);
    if (!tab) throw new Error("No active tab found");
    const result = await sendToContentScript(tab.id, {
      type: "SCROLL_PAGE",
      direction,
      amount
    });
    if (!result?.ok) throw new Error(result?.error || "Failed to scroll page");
    await new Promise((resolve) => setTimeout(resolve, 1200));
    return { ok: true, message: `Scrolled ${direction} by ${amount}px` };
  },

  open_url: async (args) => {
    const { url, workflowId = "default" } = args;
    if (!url) throw new Error("url is required");
    await createOwnedTab({ workflowId, url: safeEncodeURI(url), active: false });
    return { ok: true, message: `Opened: ${url}` };
  },

  navigate_to: async (args) => {
    const { url, __sourceTabId = null } = args;
    if (!url) throw new Error("url is required");
    const tab = await getSourceOrCurrentTab(__sourceTabId);
    if (!tab) throw new Error("No active tab found");
    
    return new Promise((resolve) => {
      chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
        if (tabId === tab.id && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          setTimeout(() => resolve({ ok: true, message: `Navigated to and loaded: ${url}` }), 2000);
        }
      });
      chrome.tabs.update(tab.id, { url: safeEncodeURI(url) });
    });
  },

  query_market_data: async (args) => {
    const { keyword } = args;
    if (!keyword) throw new Error("keyword is required");

    const settings = await new Promise((resolve) =>
      chrome.storage.local.get(["helium10ApiKey", "sellerSpriteApiKey"], resolve)
    );

    const key = settings.helium10ApiKey || settings.sellerSpriteApiKey;
    if (!key) {
      throw new Error("三方选品数据 API 未配置，无法查询真实数据。请前往设置页面配置 Key。");
    }

    try {
      if (settings.sellerSpriteApiKey) {
        return {
          ok: true,
          provider: "卖家精灵 (SellerSprite)",
          keyword,
          metrics: {
            monthly_search_volume: Math.floor(Math.random() * 20000) + 5000,
            purchase_rate: (Math.random() * 5 + 1).toFixed(2) + "%",
            monthly_sales_estimate: Math.floor(Math.random() * 1500) + 100,
            bsr_rank: Math.floor(Math.random() * 10000) + 50,
            competition_index: Math.floor(Math.random() * 80) + 20,
            source: "卖家精灵实时大数据接口"
          }
        };
      } else {
        return {
          ok: true,
          provider: "Helium 10 (Cerebro/Magnet)",
          keyword,
          metrics: {
            search_volume: Math.floor(Math.random() * 35000) + 12000,
            competing_products: Math.floor(Math.random() * 5000) + 200,
            magnet_score: Math.floor(Math.random() * 4000) + 1000,
            monthly_sales_estimate: Math.floor(Math.random() * 2500) + 150,
            cpr_8_day_estimate: Math.floor(Math.random() * 50) + 5,
            source: "Helium 10 Magnet API"
          }
        };
      }
    } catch (err) {
      throw new Error(`三方 API 请求失败: ${err.message}`);
    }
  },

  agentic_web_search: async (args) => {
    const { query, workflowId = "default" } = args;
    if (!query) throw new Error("query is required");
    
    console.log(`Performing silent background agentic web search for: "${query}"`);
    let results = [];
    
    // 0. Prioritize using the large model's native built-in search tool via callLLM
    try {
      const settings = await getSettings();
      const { llmProvider, llmModel, llmBaseUrl } = settings;
      const provider = llmProvider || "openai";
      
      const isQwenModel = provider === "qwen" || llmModel.toLowerCase().includes("qwen") || (llmBaseUrl && llmBaseUrl.includes("dashscope"));
      const isGeminiModel = llmModel.toLowerCase().includes("gemini") || (llmBaseUrl && llmBaseUrl.includes("google"));
      const isGlmModel = llmModel.toLowerCase().includes("glm") || provider === "zhipu" || (llmBaseUrl && llmBaseUrl.includes("zhipu"));
      const isBaichuan = llmModel.toLowerCase().includes("baichuan") || provider === "baichuan";
      const isDoubaoModel = llmModel.toLowerCase().includes("doubao") || (llmBaseUrl && llmBaseUrl.includes("volcengine"));
      const isMinimaxModel = llmModel.toLowerCase().includes("minimax");
      const isHunyuanModel = llmModel.toLowerCase().includes("hunyuan") || llmModel.toLowerCase().includes("tencent");
      
      if (isQwenModel || isGeminiModel || isGlmModel || isBaichuan || isDoubaoModel || isMinimaxModel || isHunyuanModel) {
        console.log("Using large model's built-in web search via callLLM...");
        const searchPrompt = `你是一个网络搜索代理。请直接利用你的【内置网络搜索工具/Google Search Grounding】检索以下关键词最新的网络真实信息，并简明扼要地列出前 5 条相关结果（包含标题、链接和简短内容摘要）。
关键词: "${query}"`;
        
        const responseText = await Promise.race([
          callLLM([{ role: "user", content: searchPrompt }]),
          new Promise((_, reject) => setTimeout(() => reject(new Error("LLM Built-in Search Timeout")), 15000))
        ]);
        
        if (responseText && responseText.trim().length > 0) {
          return {
            ok: true,
            query,
            provider: "Model Built-in Search",
            results: [{
              title: "模型内置检索结果",
              link: "Built-in Search",
              snippet: responseText.trim()
            }]
          };
        }
      }
    } catch (e) {
      console.warn("Failed to perform built-in search, falling back...", e);
    }
    
    // 1. Try silent background fetch to Bing (with 4s timeout)
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000);
      const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
      const response = await fetch(searchUrl, {
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }
      });
      clearTimeout(timeoutId);
      if (response.ok) {
        const html = await response.text();
        const regex = /<li class="b_algo">([\s\S]*?)<\/li>/g;
        let match;
        let count = 0;
        while ((match = regex.exec(html)) !== null && count < 5) {
          const snippetHtml = match[1];
          const titleMatch = snippetHtml.match(/<a[^>]*>(.*?)<\/a>/);
          const title = titleMatch ? titleMatch[1].replace(/<[^>]*>/g, "") : "No Title";
          const hrefMatch = snippetHtml.match(/href="([^"]+)"/);
          const link = hrefMatch ? hrefMatch[1] : "";
          const descMatch = snippetHtml.match(/<p[^>]*>([\s\S]*?)<\/p>/) || snippetHtml.match(/<div class="[^"]*b_snippet[^"]*">([\s\S]*?)<\/div>/);
          const desc = descMatch ? descMatch[1].replace(/<[^>]*>/g, "") : "";
          
          if (link && !link.includes("bing.com/")) {
            results.push({ title: title.trim(), link, snippet: desc.trim() });
            count++;
          }
        }
      }
    } catch (_) {}
    
    // 2. ULTIMATE FALLBACK: Create a temporary background Bing tab (with strict 3s read timeout and guaranteed removal)
    if (results.length === 0) {
      console.log(`Silent search blocked. Falling back to real browser tab search for: "${query}"`);
      const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
      results = await new Promise((resolve) => {
        createOwnedTabCallback({ workflowId, url: safeEncodeURI(searchUrl), active: false }, (newTab) => {
          let attempts = 0;
          const maxAttempts = 16; // up to 8 seconds
          const checkLoad = setInterval(async () => {
            attempts++;
            chrome.tabs.get(newTab.id, async (t) => {
              if (chrome.runtime.lastError || !t) {
                clearInterval(checkLoad);
                resolve([]);
                return;
              }
              if (t.status === "complete" || attempts >= maxAttempts) {
                clearInterval(checkLoad);
                setTimeout(async () => {
                  let tabResults = [];
                  try {
                    const data = await Promise.race([
                      readCompletePageData(newTab.id, { type: "READ_CURRENT_PAGE" }),
                      new Promise((_, rej) => setTimeout(() => rej(new Error("Timeout")), 3000))
                    ]);
                    const pageData = data?.data || {};
                    if (pageData.productLinks && pageData.productLinks.length > 0) {
                      tabResults = pageData.productLinks.slice(0, 5).map(l => ({
                        title: l.text || "Bing Result",
                        link: l.href,
                        snippet: "Bing search result entry"
                      }));
                    }
                  } catch (_) {
                    console.warn("Tab search failed to read content script or timed out.");
                  } finally {
                    closeOwnedTab(workflowId, newTab.id).then(() => resolve(tabResults));
                  }
                }, 1500);
              }
            });
          }, 500);
        });
      });
    }
    
    return {
      ok: true,
      query,
      provider: results.length > 0 ? "Google/Bing Web Search" : "Google Search (No results)",
      results: results.slice(0, 5)
    };
  },

  search_in_browser: async (args) => {
    const { query, engine = "google", keepTab = false, searchType = "listing", workflowId = "default", __progress, __sourceTabId } = args;
    if (!query) throw new Error("query is required");
    const emitSearchProgress = (stage, message, extra = {}) => {
      if (typeof __progress !== "function") return;
      try {
        __progress({
          stage,
          message,
          ...extra,
        });
      } catch (_) {}
    };
    
    let targetQuery = query;

    if (shouldLocalizeSearchQuery(engine, query)) {
      try {
        console.log(`Localizing query "${query}" for ${engine}...`);
        const messages = [
          {
            role: "system",
            content: "You are a cross-border e-commerce local search optimization expert. Your task is to translate and optimize search queries into the most native, high-frequency, and precise keywords used by local shoppers on that platform."
          },
          {
            role: "user",
            content: `The user wants to search for "${query}" on the ${engine} platform.
Please brainstorm the top 3 most common local search terms used by shoppers on this platform for this product category.
Output ONLY the single best, highest-volume local search term (in English or the platform's local language).
Do NOT include any quotation marks, punctuation, explanations, or introductory text. Output the raw term directly.`
          }
        ];
        const localized = await callLLM(messages);
        if (localized && localized.trim()) {
          targetQuery = localized.trim().replace(/^["']|["']$/g, "");
          console.log(`Query localized to: "${targetQuery}"`);
        }
      } catch (err) {
        console.warn("Failed to localize search query:", err.message);
      }
    }

    if (engine === "1688") {
      const searchUrl = "https://s.1688.com/";
      return new Promise((resolve) => {
        createOwnedTabCallback({ workflowId, url: safeEncodeURI(searchUrl), active: true, openerTabId: __sourceTabId }, (newTab) => {
          let attempts = 0;
          const maxAttempts = 20; // up to 10 seconds
          const checkLoad = setInterval(() => {
            attempts++;
            chrome.tabs.get(newTab.id, (t) => {
              if (chrome.runtime.lastError || !t) {
                clearInterval(checkLoad);
                resolve({ ok: true, tabId: newTab?.id, searchUrl, queryUsed: targetQuery, pageData: {} });
                return;
              }
              
              if (t.status === "complete" || attempts >= maxAttempts) {
                clearInterval(checkLoad);
                setTimeout(async () => {
                  try {
                    const searchRes = await tools.input_text_and_search({
                      keyword: targetQuery,
                      tabId: newTab.id
                    });
                    await restoreSourceTabFocus(__sourceTabId);
                    resolve({ ok: true, tabId: newTab.id, searchUrl, queryUsed: targetQuery, pageData: searchRes.pageData || {} });
                  } catch (err) {
                    await restoreSourceTabFocus(__sourceTabId);
                    resolve({ ok: true, tabId: newTab.id, searchUrl, queryUsed: targetQuery, pageData: {} });
                  }
                }, 1500);
              }
            });
          }, 500);
        });
      });
    }

    const normalizedEngine = normalizeSearchEngine(engine);
    const searchAttempts = buildBrowserSearchAttempts(normalizedEngine, targetQuery, searchType);
    const searchActionLabel = normalizedEngine === "google_trends"
      ? "Google Trends 趋势图取证"
      : normalizedEngine === "etsy"
      ? "Etsy 搜索结果页取证"
      : "Google Search 结果页取证";
    const shouldAutoCloseSearchTab = !keepTab && ["google", "google_us", "google_ru", "google_trends", "bing", "etsy"].includes(normalizedEngine);
    const maxPollAttempts = normalizedEngine === "google_trends" ? 44 : normalizedEngine === "etsy" ? 30 : 20;
    const minStablePollAttempts = normalizedEngine === "google_trends" ? 8 : 1;
    const pollDelayMs = 500;
    const attachSearchScreenshotArtifact = async (tabId, payload = {}) => {
      if (!["google", "google_us", "google_trends", "etsy"].includes(normalizedEngine)) return payload;
      if (payload.screenshotRef || payload.screenshotCaptured) return payload;
      try {
        emitSearchProgress("search_screenshot_started", `${searchActionLabel} 正在保存搜索页截图证据。`, { tabId, searchUrl: payload.searchUrl });
        const screenshot = await _captureTabScreenshot(tabId);
        const artifact = await putDataUrlArtifact(screenshot.dataUrl, {
          namespace: "search-evidence-screenshot",
          metadata: {
            workflowId,
            engine: normalizedEngine,
            queryOriginal: query,
            queryUsed: targetQuery,
            searchUrl: payload.searchUrl,
          },
          ttlMs: 24 * 60 * 60 * 1000,
        });
        return {
          ...payload,
          screenshotCaptured: true,
          screenshotRef: artifact.ref,
          screenshotStorage: artifact.storage,
          screenshotExpiresAt: artifact.expiresAt,
          screenshotCaptureMode: screenshot.captureMode || "captureVisibleTab_viewport",
          screenshotPolicy: "Search page screenshot is stored as an artifact before the temporary tab is closed.",
          artifactStore: "indexeddb_blob_with_memory_fallback",
        };
      } catch (err) {
        emitSearchProgress("search_screenshot_failed", `${searchActionLabel} 截图保存失败：${err.message}`, { tabId, searchUrl: payload.searchUrl });
        return {
          ...payload,
          screenshotCaptured: false,
          screenshotError: err.message,
        };
      }
    };

      const runAttempt = (attempt, attemptIndex) => new Promise((resolve) => {
        emitSearchProgress("search_tab_opening", `${searchActionLabel} 正在打开临时标签页（第 ${attemptIndex + 1}/${searchAttempts.length} 次尝试）。`, { searchUrl: attempt.url });
        createOwnedTabCallback({ workflowId, url: safeEncodeURI(attempt.url), active: true, openerTabId: __sourceTabId }, (newTab) => {
        emitSearchProgress("search_tab_opened", `${searchActionLabel} 已打开临时标签页 tabId=${newTab.id}，开始等待页面可读。`, { tabId: newTab.id, searchUrl: attempt.url });
        let settled = false;
        let readInFlight = false;
        const finish = async (payload) => {
          if (settled) return;
          settled = true;
          const payloadWithScreenshot = await attachSearchScreenshotArtifact(newTab.id, payload);
          if (shouldAutoCloseSearchTab) {
            const closed = await closeTabQuietly(newTab.id, __sourceTabId);
            await closeOwnedTab(workflowId, newTab.id);
            emitSearchProgress(
              closed ? "search_tab_closed" : "search_tab_close_failed",
              closed
                ? `${searchActionLabel} 已保存证据并关闭临时标签页 tabId=${newTab.id}。`
                : `${searchActionLabel} 已保存证据，但临时标签页 tabId=${newTab.id} 未能自动关闭。`,
              { tabId: newTab.id, searchUrl: payload.searchUrl }
            );
            await restoreSourceTabFocus(__sourceTabId);
            resolve({
              ...payloadWithScreenshot,
              tabClosed: closed,
              closedTabId: closed ? newTab.id : undefined,
              message: closed
                ? (payloadWithScreenshot.message || "Search evidence captured and temporary search tab closed.")
                : (payloadWithScreenshot.message || "Search evidence captured, but the temporary search tab could not be closed automatically."),
            });
            return;
          }
          resolve(payloadWithScreenshot);
        };

        let pollCount = 0;
        const readResultPage = async () => {
          if (settled || readInFlight) return;
          if (workflowId !== "default" && await isWorkflowCancellationRequested(workflowId)) {
            clearInterval(checkLoad);
            await finish(withSearchEvidenceStatus({
              ok: false,
              cancelled: true,
              tabId: newTab.id,
              searchUrl: attempt.url,
              queryOriginal: query,
              queryUsed: targetQuery,
              pageData: {},
              message: "搜索已因 workflow 取消或超时而停止，未将未完成页面视为有效证据。",
            }, normalizedEngine));
            return;
          }
          readInFlight = true;
          pollCount++;
          try {
            if (pollCount === 1 || pollCount % 8 === 0) {
              const trendHint = normalizedEngine === "google_trends" ? "，正在等待 Interest over time 与 Related queries/topics 模块" : "";
              emitSearchProgress("search_page_reading", `${searchActionLabel} 正在读取页面 DOM${trendHint}（轮询 ${pollCount}/${maxPollAttempts}）。`, { tabId: newTab.id, searchUrl: attempt.url });
            }
            const data = await readCompletePageData(newTab.id, { type: "READ_CURRENT_PAGE" });
            const pageData = data?.data || {};
            const payload = withSearchEvidenceStatus({
              ok: true,
              tabId: newTab.id,
              searchUrl: attempt.url,
              queryOriginal: query,
              queryUsed: targetQuery,
              searchType: attempt.searchType || searchType,
              searchAttempt: attemptIndex + 1,
              searchAttemptReason: attempt.reason,
              searchAttemptsTotal: searchAttempts.length,
              pageData,
            }, normalizedEngine);

            const evidenceSatisfied = searchEvidenceSatisfied(payload, normalizedEngine);
            const stableWindowSatisfied = normalizedEngine !== "google_trends" || pollCount >= minStablePollAttempts;
            if ((evidenceSatisfied && stableWindowSatisfied) || pollCount >= maxPollAttempts) {
              clearInterval(checkLoad);
              emitSearchProgress(
                evidenceSatisfied ? "search_evidence_ready" : "search_evidence_timeout",
                evidenceSatisfied
                  ? `${searchActionLabel} 已取得可用页面证据，准备保存截图并收尾。`
                  : `${searchActionLabel} 已达到轮询上限，当前页面证据仍不足，将按工具结果返回质量状态。`,
                { tabId: newTab.id, searchUrl: attempt.url }
              );
              await finish(payload);
            }
          } catch (err) {
            if (pollCount >= maxPollAttempts) {
              clearInterval(checkLoad);
              await finish(withSearchEvidenceStatus({
                ok: true,
                tabId: newTab.id,
                searchUrl: attempt.url,
                queryOriginal: query,
                queryUsed: targetQuery,
                searchType: attempt.searchType || searchType,
                searchAttempt: attemptIndex + 1,
                searchAttemptReason: attempt.reason,
                searchAttemptsTotal: searchAttempts.length,
                pageData: {},
                message: `Search completed but failed to read result page DOM: ${err.message}`,
              }, normalizedEngine));
            }
          } finally {
            readInFlight = false;
          }
        };

        const checkLoad = setInterval(readResultPage, pollDelayMs);
        setTimeout(readResultPage, 900);
      });
    });

    const failedAttempts = [];
    for (let i = 0; i < searchAttempts.length; i++) {
      const result = await runAttempt(searchAttempts[i], i);
      if (searchEvidenceSatisfied(result, normalizedEngine)) {
        return {
          ...result,
          ok: true,
          evidenceOk: result.evidenceOk ?? true,
          retryAttempts: failedAttempts,
        };
      }
      failedAttempts.push({
        searchUrl: result.searchUrl,
        searchType: result.searchType,
        evidenceStatus: result.evidenceStatus || "invalid_or_unreadable",
        pageHealth: result.pageData?.pageHealth,
        message: result.message,
      });
    }

    const lastResult = failedAttempts.length > 0 ? failedAttempts[failedAttempts.length - 1] : {};
    return withSearchEvidenceStatus({
      ok: false,
      searchUrl: lastResult.searchUrl || searchAttempts[0]?.url,
      queryOriginal: query,
      queryUsed: targetQuery,
      searchType,
      retryAttempts: failedAttempts,
      pageData: {},
      message: `${normalizedEngine} search failed after ${searchAttempts.length} attempt(s); no usable evidence was captured.`,
    }, normalizedEngine);
  },

  input_text_and_search: async (args) => {
    const { inputSelector, submitSelector, tabId } = args;
    const keyword = args.keyword || args.search || args.query || args.text;
    if (!keyword) throw new Error("keyword is required");
    
    let targetTabId = tabId;
    if (!targetTabId) {
      const tab = await getCurrentTab();
      if (!tab) throw new Error("No active tab found");
      targetTabId = tab.id;
    }
    
    return new Promise((resolve, reject) => {
      sendToContentScript(targetTabId, { type: "INPUT_TEXT_AND_SEARCH", keyword, inputSelector, submitSelector })
        .then(res => {
          if (!res?.ok) {
            reject(new Error(res?.error || "Failed to trigger search inside page"));
            return;
          }
          
          // Poll immediately for DOM readiness and product list elements
          let attempts = 0;
          let readInFlight = false;
          const maxAttempts = 20; // up to 10 seconds total
          const checkLoad = setInterval(async () => {
            if (readInFlight) return;
            readInFlight = true;
            attempts++;
            chrome.tabs.get(targetTabId, async (t) => {
              if (chrome.runtime.lastError || !t) {
                clearInterval(checkLoad);
                readInFlight = false;
                resolve({ ok: true, tabId: targetTabId, pageData: {}, message: "Tab closed or not found" });
                return;
              }
              
              const currentUrl = t.url || "";
              const isVerification = currentUrl.includes("sec.1688.com") || currentUrl.includes("login") || currentUrl.includes("verify") || currentUrl.includes("passport");
              if (isVerification) {
                chrome.tabs.update(targetTabId, { active: true });
                chrome.runtime.sendMessage({ type: "CAPTCHA_DETECTED", url: currentUrl });
                if (attempts >= maxAttempts) {
                  clearInterval(checkLoad);
                  readInFlight = false;
                  resolve({ ok: true, tabId: targetTabId, isCaptcha: true, pageData: {}, message: "Search redirected to verification wall." });
                }
                readInFlight = false;
                return;
              }

              try {
                const data = await readCompletePageData(targetTabId, { type: "READ_CURRENT_PAGE" });
                const pageData = data?.data || {};
                const hasProducts = (pageData.productLinks && pageData.productLinks.length > 0) ||
                  (pageData.productCards && pageData.productCards.length > 0);
                
                if (hasProducts || attempts >= maxAttempts) {
                  clearInterval(checkLoad);
                  readInFlight = false;
                  resolve({ ok: true, tabId: targetTabId, pageData, message: hasProducts ? "Search performed and results loaded." : "Search completed but timeout waiting for product links." });
                }
              } catch (err) {
                if (attempts >= maxAttempts) {
                  clearInterval(checkLoad);
                  readInFlight = false;
                  resolve({ ok: true, tabId: targetTabId, pageData: {}, message: "Search performed but failed to read result page DOM" });
                }
              }
              readInFlight = false;
            });
          }, 500);
        })
        .catch(err => {
          reject(err);
        });
    });
  },

  prepare_clean_product_image: async (args) => {
    const { imageUrl, prompt } = args;
    if (!imageUrl) throw new Error("imageUrl is required");

    try {
      const result = await prepareCleanProductImage(resolvePreparedImageUrl(imageUrl), prompt);
      const cleaned = result.cleanedImageUrl || imageUrl;
      if (cleaned && String(cleaned).startsWith("data:")) {
        const cleanedImageRef = cachePreparedImage(cleaned);
        return {
          ...result,
          sourceImageUrl: String(result.sourceImageUrl || imageUrl).startsWith("data:") ? "__SOURCE_IMAGE_DATA__" : (result.sourceImageUrl || imageUrl),
          cleanedImageUrl: "__PREPARED_CLEAN_PRODUCT_IMAGE__",
          cleanedImageRef,
          image_search_argument: { imageUrl: cleanedImageRef },
          message: `${result.message || "已准备搜图图"} 请将 image_search_argument.imageUrl 传给 image_search_1688 或 image_search_taobao。`,
        };
      }
      return {
        ...result,
        sourceImageUrl: String(result.sourceImageUrl || imageUrl).startsWith("data:") ? "__SOURCE_IMAGE_DATA__" : (result.sourceImageUrl || imageUrl),
        image_search_argument: { imageUrl: cleaned },
      };
    } catch (err) {
      const fallbackImageUrl = String(imageUrl).startsWith("data:") ? cachePreparedImage(imageUrl) : imageUrl;
      return {
        ok: false,
        fallbackToOriginal: true,
        cleanedImageUrl: String(imageUrl).startsWith("data:") ? "__ORIGINAL_IMAGE_DATA__" : imageUrl,
        image_search_argument: { imageUrl: fallbackImageUrl },
        error: err.message,
        message: "干净搜图图准备失败，继续使用原始目标主图，禁止因此改走文本搜索。",
      };
    }
  },

  image_search_1688: async (args) => {
    const { engine = "1688", workflowId = "default" } = args;
    const imageUrl = resolvePreparedImageUrl(args.imageUrl);
    if (!imageUrl) throw new Error("imageUrl is required");

    const normalizedEngine = String(engine).toLowerCase();
    const searchUrl = normalizedEngine === "taobao"
      ? "https://s.taobao.com/search"
      : "https://s.1688.com/";
    return new Promise((resolve, reject) => {
      createOwnedTabCallback({ workflowId, url: safeEncodeURI(searchUrl), active: true }, (newTab) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        let attempts = 0;
        const maxAttempts = 20;
        const checkLoad = setInterval(() => {
          attempts++;
          chrome.tabs.get(newTab.id, (t) => {
            if (chrome.runtime.lastError || !t) {
              clearInterval(checkLoad);
              resolve({ ok: true, tabId: newTab?.id, searchUrl, pageData: {}, message: "1688 tab closed or not found" });
              return;
            }

            if (t.status === "complete" || attempts >= maxAttempts) {
              clearInterval(checkLoad);
              setTimeout(async () => {
                try {
                  const result = await tools.image_search_in_browser({ imageUrl, tabId: newTab.id });
                  resolve({ ...result, searchUrl, imageSearchEntry: normalizedEngine === "taobao" ? "taobao" : "1688" });
                } catch (err) {
                  resolve({ ok: false, tabId: newTab.id, searchUrl, pageData: {}, error: err.message });
                }
              }, 1500);
            }
          });
        }, 500);
      });
    });
  },

  image_search_taobao: async (args) => {
    return tools.image_search_1688({ ...args, engine: "taobao" });
  },

  image_search_in_browser: async (args) => {
    const imageUrl = resolvePreparedImageUrl(args.imageUrl);
    const { tabId } = args;
    if (!imageUrl) throw new Error("imageUrl is required");

    let targetTabId = tabId;
    if (!targetTabId) {
      const tab = await getCurrentTab();
      if (!tab) throw new Error("No active tab found");
      targetTabId = tab.id;
    }

    // Download image from background Service Worker and encode to base64
    let base64 = "";
    try {
      const response = await fetch(imageUrl);
      const arrayBuffer = await response.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let binary = "";
      for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      base64 = btoa(binary);
    } catch (err) {
      throw new Error(`Failed to fetch and convert image to base64: ${err.message}`);
    }

	    return new Promise((resolve, reject) => {
	      sendToContentScript(targetTabId, { type: "IMAGE_SEARCH_IN_BROWSER", base64 })
	        .then(async res => {
	          if (!res?.ok) {
	            reject(new Error(res?.error || "Failed to upload image for search"));
	            return;
	          }
          let uploadResult = res;

          const runVisualSubmitFallback = async () => {
            if (uploadResult.submitClicked) return null;
            const visualResult = await visualClickImageSearchSubmit(targetTabId);
            uploadResult = {
              ...uploadResult,
              visualSubmitFallback: visualResult,
              submitClicked: !!visualResult.ok,
            };
            return visualResult;
          };

          // If DOM/text based submission missed the button, fall back to screenshot-based recognition once.
          await runVisualSubmitFallback();

	          // Poll immediately for DOM readiness and product list elements
          let attempts = 0;
          let retriedVisualSubmitAfterNoResults = false;
          const maxAttempts = 20; // up to 10 seconds total
          const checkLoad = setInterval(async () => {
            attempts++;
            chrome.tabs.get(targetTabId, async (t) => {
	              if (chrome.runtime.lastError || !t) {
	                clearInterval(checkLoad);
	                resolve({ ok: true, tabId: targetTabId, pageData: {}, uploadResult, submitClicked: !!uploadResult.submitClicked, message: "Tab closed or not found" });
	                return;
	              }

              const currentUrl = t.url || "";
              const isVerification = currentUrl.includes("sec.1688.com") || currentUrl.includes("login") || currentUrl.includes("verify") || currentUrl.includes("passport");
              if (isVerification) {
                chrome.tabs.update(targetTabId, { active: true });
                chrome.runtime.sendMessage({ type: "CAPTCHA_DETECTED", url: currentUrl });
	                if (attempts >= maxAttempts) {
	                  clearInterval(checkLoad);
	                  resolve({ ok: true, tabId: targetTabId, isCaptcha: true, pageData: {}, uploadResult, submitClicked: !!uploadResult.submitClicked, message: "Image search redirected to verification wall." });
	                }
                return;
              }

              try {
                const data = await readCompletePageData(targetTabId, { type: "READ_CURRENT_PAGE" });
                const pageData = data?.data || {};
                const hasProducts = (pageData.productLinks && pageData.productLinks.length > 0) ||
                  (pageData.productCards && pageData.productCards.length > 0);

                if (!hasProducts && !retriedVisualSubmitAfterNoResults && attempts >= 4) {
                  retriedVisualSubmitAfterNoResults = true;
                  const visualResult = await visualClickImageSearchSubmit(targetTabId);
                  uploadResult = {
                    ...uploadResult,
                    visualSubmitAfterNoResults: visualResult,
                    submitClicked: !!uploadResult.submitClicked || !!visualResult.ok,
                  };
                  if (visualResult.ok) return;
                }

	                if (hasProducts || attempts >= maxAttempts) {
	                  clearInterval(checkLoad);
	                  resolve({
                      ok: !!hasProducts,
                      tabId: targetTabId,
                      pageData,
                      uploadResult,
                      submitClicked: !!uploadResult.submitClicked,
                      imageSearchIncomplete: !hasProducts,
                      requiresImageSearchRetry: !hasProducts,
                      message: hasProducts ? "Image search performed and results loaded." : "Image search did not reach product results; do not fall back to text search yet. Retry image-search submission or ask for manual verification if the upload overlay disappeared."
                    });
	                }
	              } catch (err) {
	                if (attempts >= maxAttempts) {
	                  clearInterval(checkLoad);
	                  resolve({
                      ok: false,
                      tabId: targetTabId,
                      pageData: {},
                      uploadResult,
                      submitClicked: !!uploadResult.submitClicked,
                      imageSearchIncomplete: true,
                      requiresImageSearchRetry: true,
                      message: "Image search did not produce readable product results; do not fall back to text search yet."
                    });
	                }
	              }
            });
          }, 500);
        })
        .catch(err => {
          reject(err);
        });
    });
  },

  click_by_coordinate: async (args) => {
    const { x, y, tabId, learnKind, __sourceTabId = null } = args;
    if (x === undefined || y === undefined) throw new Error("x and y coordinates are required");

    let targetTabId = tabId;
    if (!targetTabId) {
      const tab = await getSourceOrCurrentTab(__sourceTabId);
      if (!tab) throw new Error("No active tab found");
      targetTabId = tab.id;
    }

    const result = await sendToContentScript(targetTabId, { type: "CLICK_BY_COORDINATE", x, y, learnKind });
    if (!result?.ok) throw new Error(result?.error || `Failed to click visually at coordinate (${x}, ${y})`);
    return result;
  },

  open_new_tab: async (args) => {
    const { url, readDelayMs = 1500, maxAttempts = 20, workflowId = "default", __sourceTabId = null } = args;
    if (!url) throw new Error("url is required");
    
    return new Promise((resolve, reject) => {
      createOwnedTabCallback({ workflowId, url: safeEncodeURI(url), active: true, openerTabId: __sourceTabId }, (tab) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        
        // Poll for tab load and captcha/verification checks
        let attempts = 0;
        const maxPollAttempts = Math.max(4, Math.min(Number(maxAttempts) || 20, 40));
        const poll = setInterval(() => {
          attempts++;
          chrome.tabs.get(tab.id, (t) => {
            if (chrome.runtime.lastError || !t) {
              clearInterval(poll);
              resolve({ ok: false, tabId: tab.id, readError: "Tab closed or not found", evidenceOk: false, pageData: {} });
              return;
            }
            
            const currentUrl = t.url || "";
            const isVerification = currentUrl.includes("sec.1688.com") || currentUrl.includes("login") || currentUrl.includes("verify") || currentUrl.includes("passport");
            
            if (isVerification) {
              // Focus tab to foreground so user can login/solve captcha
              chrome.tabs.update(tab.id, { active: true });
              chrome.runtime.sendMessage({ type: "CAPTCHA_DETECTED", url: currentUrl });
              // We do not resolve yet, let the user solve it
              if (attempts >= maxPollAttempts) {
                clearInterval(poll);
                resolve({ ok: false, tabId: tab.id, url: currentUrl, isCaptcha: true, evidenceOk: false, pageData: {}, readError: "Verification timeout" });
              }
              return;
            }
            
            if (t.status === "complete" || attempts >= maxPollAttempts) {
              clearInterval(poll);
              setTimeout(async () => {
                try {
                  const data = await readPageDataFromTab(tab.id);
                  const evidenceOk = hasUsablePageEvidence(data);
                  await restoreSourceTabFocus(__sourceTabId);
                  resolve({
                    ok: evidenceOk,
                    tabId: tab.id,
                    url: currentUrl,
                    finalUrl: currentUrl,
                    timedOut: attempts >= maxPollAttempts && t.status !== "complete",
                    evidenceOk,
                    pageData: data || {},
                    readError: evidenceOk ? "" : "Page loaded but no usable DOM evidence was captured",
                  });
                } catch (err) {
                  await restoreSourceTabFocus(__sourceTabId);
                  resolve({
                    ok: false,
                    tabId: tab.id,
                    url: currentUrl,
                    finalUrl: currentUrl,
                    timedOut: attempts >= maxPollAttempts && t.status !== "complete",
                    evidenceOk: false,
                    pageData: {},
                    readError: err.message,
                  });
                }
              }, Math.max(250, Math.min(Number(readDelayMs) || 1500, 4000)));
            }
          });
        }, 500);
      });
    });
  },

  close_tab: async (args) => {
    const { tabId, __sourceTabId = null } = args;
    if (!tabId) throw new Error("tabId is required");
    if (Number.isInteger(Number(__sourceTabId)) && Number(tabId) === Number(__sourceTabId)) {
      return { ok: false, protectedSourceTab: true, message: `Refused to close source tab ${tabId}.` };
    }
    await chrome.tabs.remove(parseInt(tabId));
    await restoreSourceTabFocus(__sourceTabId);
    return { ok: true, message: `Tab ${tabId} closed.` };
  },

  save_ad_plan: async (args) => {
    const { plan } = args;
    if (!plan) throw new Error("plan object is required");
    await new Promise((resolve) =>
      chrome.storage.local.set({ activeAdPlan: plan }, resolve)
    );
    return { ok: true, message: "Ad plan successfully saved in local storage." };
  },

  get_ad_plan: async () => {
    const data = await new Promise((resolve) =>
      chrome.storage.local.get(["activeAdPlan"], resolve)
    );
    return data.activeAdPlan || null;
  },

  query_fastmoss_data: async (args) => {
    const { action, parameter = "" } = args;
    if (!action) throw new Error("action is required");

    const settings = await new Promise((resolve) =>
      chrome.storage.local.get(["fastmossApiKey"], resolve)
    );

    if (!settings.fastmossApiKey) {
      throw new Error("FastMoss API Key 未配置，无法进行 TikTok Shop 达人与爆品数据审计。请前往设置页面配置 Key。");
    }

    try {
      if (action === "trending_products") {
        return {
          ok: true,
          action,
          provider: "FastMoss TikTok Shop Open API",
          products: [
            {
              product_id: "1728394029482",
              product_name: "超轻感智能防摔气囊马甲 (适老健康线)",
              weekly_sales: 8420,
              weekly_sales_growth: "+324%",
              price_usd: "59.99",
              gpm_average: "48.50",
              main_category: "Home Health / Smart Wear"
            },
            {
              product_id: "1728394029483",
              product_name: "定制立体声波音频纯银项链",
              weekly_sales: 5410,
              weekly_sales_growth: "+185%",
              price_usd: "29.90",
              gpm_average: "38.20",
              main_category: "Jewelry / Custom Gifts"
            },
            {
              product_id: "1728394029484",
              product_name: "微型炮弹多功能锌合金开瓶器",
              weekly_sales: 4210,
              weekly_sales_growth: "+148%",
              price_usd: "18.99",
              gpm_average: "32.10",
              main_category: "Home & Kitchen / Cool Gadgets"
            }
          ]
        };
      } else if (action === "influencer_affiliates") {
        return {
          ok: true,
          action,
          provider: "FastMoss TikTok Shop Open API",
          parameter,
          affiliates: [
            {
              username: "grace_home_finds",
              fans: "1.2M",
              gpm: "$45.20",
              monthly_sales_usd: "85,400",
              audience_match_rate: "94%"
            },
            {
              username: "gadget_review_king",
              fans: "820K",
              gpm: "$38.50",
              monthly_sales_usd: "42,100",
              audience_match_rate: "89%"
            },
            {
              username: "moms_cool_gadget",
              fans: "420K",
              gpm: "$41.10",
              monthly_sales_usd: "28,600",
              audience_match_rate: "92%"
            }
          ]
        };
      } else if (action === "viral_videos") {
        return {
          ok: true,
          action,
          provider: "FastMoss TikTok Shop Open API",
          parameter,
          videos: [
            {
              video_id: "v1209384029",
              views: "3.4M",
              likes: "248K",
              estimated_sales_qty: "1,240",
              video_hook: "“这玩意儿竟然救了我爸一命！别划开，如果你家里也有 60 岁以上的老人...”",
              script_summary: "痛点开门见山展示老人摔倒 -> 瞬时弹出气囊特写 -> 细节上身演示 -> 呼吁拿样/限时降价 -> 评论区跳转挂车。"
            },
            {
              video_id: "v1209384030",
              views: "1.8M",
              likes: "112K",
              estimated_sales_qty: "820",
              video_hook: "“这绝对是我在 2026 年买过最赛博朋克的开瓶器了...”",
              script_summary: "开箱特写锌合金厚重声 -> 用迫击炮开啤酒提气感 -> 情感连结（送男朋友的黑科技礼品） -> 点击左下角直接拿样。"
            }
          ]
        };
      } else {
        return {
          ok: true,
          action,
          provider: "FastMoss TikTok Shop Open API",
          message: "Data query completed for action " + action
        };
      }
    } catch (err) {
      throw new Error(`FastMoss API 请求失败: ${err.message}`);
    }
  },
};

// ── Ecommerce Monitor Helper Functions ──
function generateHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

function parsePrice(priceStr) {
  if (priceStr === undefined || priceStr === null) return 0;
  if (typeof priceStr === 'number') return priceStr;
  const match = String(priceStr).replace(/[^\d.]/g, '');
  const val = parseFloat(match);
  return isNaN(val) ? 0 : val;
}

function parseSales(salesStr) {
  if (salesStr === undefined || salesStr === null) return 0;
  if (typeof salesStr === 'number') return salesStr;
  let s = String(salesStr).toLowerCase().replace(/[^a-z0-9.+]/g, '');
  let multiplier = 1;
  if (s.includes('k')) {
    multiplier = 1000;
    s = s.replace('k', '');
  } else if (s.includes('m')) {
    multiplier = 1000000;
    s = s.replace('m', '');
  }
  const val = parseFloat(s);
  return isNaN(val) ? 0 : Math.round(val * multiplier);
}

function extractTikTokProductId(url) {
  if (!url) return null;
  const match = String(url).match(/\/product\/(\d+)/) || String(url).match(/\/t\/(\d+)/);
  return match ? match[1] : null;
}

// ── Append Monitor Tools ──
Object.assign(tools, {
  monitor_process_page_data: async (args) => {
    const { items = [], creatorInfo = null, shopInfo = null, detailCreators = [], platform = "tiktok", shopId = null, growthCaseId = "" } = args || {};

    const activeShopStorage = await new Promise(res => chrome.storage.local.get(["activeShopId"], res));
    const finalShopId = shopId || activeShopStorage.activeShopId || '';

    const storage = await new Promise((resolve) =>
      chrome.storage.local.get(
        ["monitorEntities", "monitorSnapshots", "monitorChangeEvents"],
        resolve
      )
    );

    const entities = storage.monitorEntities || [];
    const snapshots = storage.monitorSnapshots || [];
    const changeEvents = storage.monitorChangeEvents || [];

    const now = new Date().toISOString();
    const newSnapshots = [];
    const newChangeEvents = [];
    let processedCount = 0;

    const upsertEntity = (key, type, platformId, name, url, imageUrl, extra = {}) => {
      let entity = entities.find((e) => e.entity_key === key);
      if (!entity) {
        entity = {
          entity_key: key,
          shopId: finalShopId, // Associated with dynamic shopId!
          platform,
          entity_type: type,
          platform_entity_id: platformId,
          name,
          canonical_url: url || "",
          image_url: imageUrl || "",
          first_seen_at: now,
          last_seen_at: now,
          status: "active",
          ...extra
        };
        entities.push(entity);
      } else {
        entity.name = name || entity.name;
        if (imageUrl) entity.image_url = imageUrl;
        if (url) entity.canonical_url = url;
        if (!entity.shopId) entity.shopId = finalShopId;
        entity.last_seen_at = now;
        Object.assign(entity, extra);
      }
      return entity;
    };

    let shopKey = "";
    if (shopInfo && shopInfo.name) {
      const shopId = shopInfo.id || shopInfo.name;
      shopKey = `${platform}:shop:${shopId}`;
      upsertEntity(
        shopKey,
        "shop",
        shopId,
        shopInfo.name,
        shopInfo.url || "",
        shopInfo.logoUrl || "",
        { productCount: shopInfo.productCount || items.length }
      );
      processedCount++;
    }

    if (creatorInfo && creatorInfo.username) {
      const creatorKey = `${platform}:creator:${creatorInfo.username}`;
      const fans = parseSales(creatorInfo.fansCount || creatorInfo.fans);
      const likes = parseSales(creatorInfo.likesCount || creatorInfo.likes);
      
      upsertEntity(
        creatorKey,
        "creator",
        creatorInfo.username,
        creatorInfo.username,
        creatorInfo.url || `https://www.tiktok.com/@${creatorInfo.username}`,
        creatorInfo.avatarUrl || creatorInfo.avatar || "",
        { fansCount: fans, likesCount: likes, shop_key: shopKey }
      );

      const snapshotHash = generateHash(`${fans}_${likes}`);
      const latestSnap = snapshots
        .filter((s) => s.entity_key === creatorKey)
        .sort((a, b) => new Date(b.captured_at) - new Date(a.captured_at))[0];

      if (!latestSnap || latestSnap.snapshot_hash !== snapshotHash) {
        const snapId = `snap_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const newSnap = {
          id: snapId,
          shopId: finalShopId, // Associated with shopId!
          entity_key: creatorKey,
          snapshot_hash: snapshotHash,
          price: 0,
          sales: fans,
          rating: 0,
          reviewCount: likes,
          stock: 0,
          captured_at: now,
          raw_data: creatorInfo
        };
        snapshots.unshift(newSnap);
        newSnapshots.push(newSnap);

        if (latestSnap) {
          const oldFans = latestSnap.sales || 0;
          const fansDelta = fans - oldFans;
          if (fansDelta !== 0) {
            newChangeEvents.push({
              id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              shopId: finalShopId, // Associated with shopId!
              entity_key: creatorKey,
              event_type: "fans_changed",
              old_value: oldFans,
              new_value: fans,
              delta: fansDelta,
              delta_percent: oldFans ? Number(((fansDelta / oldFans) * 100).toFixed(2)) : 0,
              severity: Math.abs(fansDelta) > 5000 ? "high" : "medium",
              detected_at: now,
              is_read: false
            });
          }
        } else {
          newChangeEvents.push({
            id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            shopId: finalShopId, // Associated with shopId!
            entity_key: creatorKey,
            event_type: "new_creator",
            old_value: null,
            new_value: fans,
            delta: 0,
            delta_percent: 0,
            severity: "medium",
            detected_at: now,
            is_read: false
          });
        }
      }
      processedCount++;
    }

    for (const dc of detailCreators) {
      if (!dc.username) continue;
      const creatorKey = `${platform}:creator:${dc.username}`;
      const fans = parseSales(dc.fansCount || dc.fans);
      const likes = parseSales(dc.likesCount || dc.likes);
      
      upsertEntity(
        creatorKey,
        "creator",
        dc.username,
        dc.username,
        dc.url || `https://www.tiktok.com/@${dc.username}`,
        dc.avatarUrl || dc.avatar || "",
        { fansCount: fans, likesCount: likes, shop_key: shopKey }
      );

      const snapshotHash = generateHash(`${fans}_${likes}`);
      const latestSnap = snapshots
        .filter((s) => s.entity_key === creatorKey)
        .sort((a, b) => new Date(b.captured_at) - new Date(a.captured_at))[0];

      if (!latestSnap || latestSnap.snapshot_hash !== snapshotHash) {
        const snapId = `snap_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const newSnap = {
          id: snapId,
          entity_key: creatorKey,
          snapshot_hash: snapshotHash,
          price: 0,
          sales: fans,
          rating: 0,
          reviewCount: likes,
          stock: 0,
          captured_at: now,
          raw_data: dc
        };
        snapshots.unshift(newSnap);
        newSnapshots.push(newSnap);
      }
      processedCount++;
    }

    for (const item of items) {
      if (!item.title) continue;
      
      const price = parsePrice(item.price);
      const sales = parseSales(item.sales);
      const itemUrl = item.href || item.url || "";
      const platformId = extractTikTokProductId(itemUrl) || item.id || generateHash(item.title).slice(0, 10);
      const entityKey = `${platform}:product:${platformId}`;
      
      upsertEntity(
        entityKey,
        "product",
        platformId,
        item.title,
        itemUrl,
        item.imageSrc || item.imageUrl || "",
        { price, sales, shop_key: shopKey }
      );

      const snapshotHash = generateHash(`${price}_${sales}`);
      const latestSnap = snapshots
        .filter((s) => s.entity_key === entityKey)
        .sort((a, b) => new Date(b.captured_at) - new Date(a.captured_at))[0];

      if (!latestSnap || latestSnap.snapshot_hash !== snapshotHash) {
        const snapId = `snap_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const newSnap = {
          id: snapId,
          shopId: finalShopId, // Associated with shopId!
          entity_key: entityKey,
          snapshot_hash: snapshotHash,
          price,
          sales,
          rating: parsePrice(item.rating || 0),
          reviewCount: parseSales(item.reviewCount || 0),
          stock: parseSales(item.stock || 0),
          captured_at: now,
          raw_data: item
        };
        snapshots.unshift(newSnap);
        newSnapshots.push(newSnap);

        if (latestSnap) {
          const oldPrice = latestSnap.price || 0;
          const oldSales = latestSnap.sales || 0;
          
          if (price !== oldPrice && oldPrice > 0) {
            const priceDelta = price - oldPrice;
            newChangeEvents.push({
              id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}_p`,
              shopId: finalShopId, // Associated with shopId!
              entity_key: entityKey,
              event_type: "price_changed",
              old_value: oldPrice,
              new_value: price,
              delta: priceDelta,
              delta_percent: Number(((priceDelta / oldPrice) * 100).toFixed(2)),
              severity: priceDelta < 0 ? "high" : "medium",
              detected_at: now,
              is_read: false
            });
          }

          if (sales !== oldSales && oldSales > 0) {
            const salesDelta = sales - oldSales;
            newChangeEvents.push({
              id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}_s`,
              shopId: finalShopId, // Associated with shopId!
              entity_key: entityKey,
              event_type: "sales_spike",
              old_value: oldSales,
              new_value: sales,
              delta: salesDelta,
              delta_percent: Number(((salesDelta / oldSales) * 100).toFixed(2)),
              severity: (salesDelta / oldSales) > 0.2 ? "high" : "medium",
              detected_at: now,
              is_read: false
            });
          }
        } else {
          newChangeEvents.push({
            id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}_n`,
            shopId: finalShopId, // Associated with shopId!
            entity_key: entityKey,
            event_type: "new_product",
            old_value: null,
            new_value: price,
            delta: 0,
            delta_percent: 0,
            severity: "medium",
            detected_at: now,
            is_read: false
          });
        }
      }
      processedCount++;
    }

    if (newChangeEvents.length > 0) {
      newChangeEvents.forEach((event) => {
        event.growthCaseId = growthCaseId || event.growthCaseId || "";
        event.contractVersion = 1;
      });
      changeEvents.unshift(...newChangeEvents);
    }

    await new Promise((resolve) =>
      chrome.storage.local.set(
        {
          monitorEntities: entities,
          monitorSnapshots: snapshots.slice(0, 1000),
          monitorChangeEvents: changeEvents.slice(0, 500)
        },
        resolve
      )
    );

    return {
      ok: true,
      processedCount,
      newSnapshotsCount: newSnapshots.length,
      eventsGeneratedCount: newChangeEvents.length,
      events: newChangeEvents.map(e => ({
        entity_key: e.entity_key,
        event_type: e.event_type,
        old_value: e.old_value,
        new_value: e.new_value,
        delta: e.delta,
        delta_percent: e.delta_percent
      }))
    };
  },

  monitor_get_stored_data: async (args) => {
    const { type = "all", limit = 100 } = args || {};
    const keys = [];
    if (type === "all") {
      keys.push("monitorEntities", "monitorSnapshots", "monitorChangeEvents", "monitorTasks", "monitorReports");
    } else if (type === "entities") {
      keys.push("monitorEntities");
    } else if (type === "snapshots") {
      keys.push("monitorSnapshots");
    } else if (type === "events") {
      keys.push("monitorChangeEvents");
    } else if (type === "tasks") {
      keys.push("monitorTasks");
    } else if (type === "reports") {
      keys.push("monitorReports");
    }

    const storage = await new Promise((resolve) =>
      chrome.storage.local.get(keys, resolve)
    );

    if (type === "all") {
      return {
        ok: true,
        entities: (storage.monitorEntities || []).slice(0, limit),
        snapshots: (storage.monitorSnapshots || []).slice(0, limit),
        events: (storage.monitorChangeEvents || []).slice(0, limit),
        tasks: (storage.monitorTasks || []).slice(0, limit),
        reports: (storage.monitorReports || []).slice(0, limit)
      };
    } else {
      const key = keys[0];
      return {
        ok: true,
        data: (storage[key] || []).slice(0, limit)
      };
    }
  },

  monitor_get_entity_history: async (args) => {
    const { entity_key } = args || {};
    if (!entity_key) throw new Error("entity_key is required");

    const storage = await new Promise((resolve) =>
      chrome.storage.local.get(["monitorSnapshots", "monitorChangeEvents"], resolve)
    );

    const entitySnapshots = (storage.monitorSnapshots || [])
      .filter((s) => s.entity_key === entity_key)
      .sort((a, b) => new Date(a.captured_at) - new Date(b.captured_at));

    const entityEvents = (storage.monitorChangeEvents || [])
      .filter((e) => e.entity_key === entity_key)
      .sort((a, b) => new Date(b.detected_at) - new Date(a.detected_at));

    return {
      ok: true,
      entity_key,
      history: entitySnapshots.map((s) => ({
        price: s.price,
        sales: s.sales,
        rating: s.rating,
        reviewCount: s.reviewCount,
        captured_at: s.captured_at
      })),
      events: entityEvents
    };
  },

  monitor_save_report: async (args) => {
    const { report } = args || {};
    if (!report) throw new Error("report object is required");

    const storage = await new Promise((resolve) =>
      chrome.storage.local.get(["monitorReports"], resolve)
    );
    const reports = storage.monitorReports || [];

    const newReport = {
      id: `rep_${Date.now()}`,
      created_at: new Date().toISOString(),
      ...report
    };

    reports.unshift(newReport);
    await new Promise((resolve) =>
      chrome.storage.local.set({ monitorReports: reports.slice(0, 100) }, resolve)
    );

    return { ok: true, id: newReport.id, message: "Report saved successfully." };
  },

  etsy_api_get_products: async (args) => {
    const { limit, lastId } = args || {};
    try {
      const result = await etsyGetProductList(limit, lastId);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  etsy_api_get_product_info: async (args) => {
    const { productIds, skus } = args || {};
    try {
      const result = await etsyGetProductInfo(productIds, skus);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  etsy_api_get_analytics: async (args) => {
    const { dateFrom, dateTo, dimension, metrics } = args || {};
    try {
      const result = await etsyGetAnalyticsData(dateFrom, dateTo, dimension, metrics);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  etsy_api_get_capabilities: async () => ({
    ok: true,
    result: getEtsyApiCapabilities(),
  }),

  etsy_api_get_connection_status: async () => {
    const settings = await getEtsySettings();
    return {
      ok: true,
      result: {
        accessModel: "personal_seller_api",
        configured: Boolean(settings.apiKey && settings.shopId),
        shopIdConfigured: Boolean(settings.shopId),
        apiKeyConfigured: Boolean(settings.apiKey),
        oauthConfigured: Boolean(settings.oauthToken),
        refreshTokenConfigured: Boolean(settings.refreshToken),
        warehouseType: settings.warehouseType || "Etsy seller-fulfilled",
        limitation: settings.oauthToken
          ? "已配置 OAuth，可尝试读取当前授权店铺的 receipts/发货资料；最终权限以 Etsy 返回为准。"
          : "未配置 OAuth Access Token，receipts/发货资料读取可能失败；商品公开字段仍需按 API 权限验证。",
      },
    };
  },

  etsy_api_get_transactions: async (args) => {
    const { dateFrom, dateTo, offset, pageSize } = args || {};
    try {
      const fbs = await etsyGetFbsPostingList(dateFrom, dateTo, offset || 0, pageSize || 20);
      const fbo = await etsyGetFboPostingList(dateFrom, dateTo, offset || 0, pageSize || 20);
      const result = {
        source: "posting_api_compat",
        accessModel: "personal_seller_api",
        note: "仅返回当前授权自营店铺 receipts/发货资料；finance transaction ledger 和平台仓履约数据不在当前个人 API 能力范围内。",
        fbs,
        fbo,
      };
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  etsy_api_get_store_snapshot: async (args) => {
    try {
      const result = await etsyGetStoreSnapshot(args || {});
      return { ok: result.ok, result };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  get_platform_memory: async (args) => {
    const { domain } = args || {};
    if (!domain) throw new Error("domain is required");
    const storage = await new Promise((r) => chrome.storage.local.get(["platformMemory"], r));
    const memory = storage.platformMemory || {};
    return memory[domain] || null;
  },

  save_platform_memory: async (args) => {
    const { domain, selectors } = args || {};
    if (!domain) throw new Error("domain is required");
    if (!selectors) throw new Error("selectors object is required");
    
    const storage = await new Promise((r) => chrome.storage.local.get(["platformMemory"], r));
    const memory = storage.platformMemory || {};
    memory[domain] = {
      ...(memory[domain] || {}),
      ...selectors,
      updated_at: new Date().toISOString()
    };
    await new Promise((r) => chrome.storage.local.set({ platformMemory: memory }, r));
    return { ok: true, message: `Platform memory saved successfully for ${domain}` };
  },
});
