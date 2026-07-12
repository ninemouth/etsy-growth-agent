// modules/agentLoop.js — The Agent reasoning & tool loop logic

import { callLLM, getSettings } from './llmClient.js';
import { tools, hasValidEtsySearchEvidence } from './toolRegistry.js';
import { isWorkflowCancellationRequested, isWorkflowGenerationCurrent } from './workflowRuntime.js';
import { putDataUrlArtifact } from './artifactStore.js';
import { captureFullPageScreenshot } from './debuggerCapture.js';

const globalSessionCache = {};
const CHECKPOINT_PREFIX = "etsyAgentCheckpoint:";
const CHECKPOINT_LATEST_KEY = "etsyAgentCheckpointLatest";
const CHECKPOINT_IMAGE_PLACEHOLDER = "__CHECKPOINT_IMAGE_OMITTED__";
const MAX_LLM_TEXT_FIELD = 900;
const MAX_LLM_PRODUCT_CARDS = 8;
const MAX_LLM_CRAWL_PRODUCT_CARDS = 16;
const MAX_LLM_CRAWL_PAGES = 6;
const MAX_LLM_MESSAGE_CHARS = 26000;
const MAX_LLM_HISTORY_MESSAGES = 24;
const MAX_LLM_TOTAL_CHARS = 140000;
const MAX_CONTINUOUS_RUNTIME_MS = 15 * 60 * 1000;

function checkpointStorageAvailable() {
  return typeof chrome !== "undefined" && chrome.storage?.local;
}

function checkpointKey(sessionKey) {
  return `${CHECKPOINT_PREFIX}${sessionKey}`;
}

function stripCheckpointImages(content) {
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (part?.type === "image_url") {
        return {
          ...part,
          image_url: {
            ...(part.image_url || {}),
            url: CHECKPOINT_IMAGE_PLACEHOLDER,
          },
        };
      }
      return part;
    });
  }
  return content;
}

function restoreCheckpointContent(content) {
  if (!Array.isArray(content)) return content;
  return content.filter((part) => part?.type !== "image_url" || part?.image_url?.url !== CHECKPOINT_IMAGE_PLACEHOLDER);
}

function serializeMessagesForCheckpoint(messages = []) {
  return messages.map((message) => ({
    ...message,
    content: stripCheckpointImages(message.content),
  }));
}

function stripCheckpointDataUrls(value) {
  if (typeof value === "string") {
    return /^data:image\//i.test(value) ? CHECKPOINT_IMAGE_PLACEHOLDER : value;
  }
  if (Array.isArray(value)) return value.map(stripCheckpointDataUrls);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, stripCheckpointDataUrls(nested)]));
  }
  return value;
}

function serializeToolHistoryForCheckpoint(toolHistory = []) {
  return toolHistory.map((entry) => stripCheckpointDataUrls(entry));
}

function hydrateMessagesFromCheckpoint(messages = []) {
  return messages.map((message) => ({
    ...message,
    content: restoreCheckpointContent(message.content),
  }));
}

function truncateText(value = "", maxLength = MAX_LLM_TEXT_FIELD) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}... [truncated ${text.length - maxLength} chars]`;
}

function compactProductCardForLLM(card = {}, index = 0) {
  return {
    rank: card.visibleOrderRank ?? card.index ?? index + 1,
    title: truncateText(card.title || card.name || "", 160),
    price: card.price || "",
    href: card.href || card.listingUrl || card.url || "",
    shopName: card.shopName || "",
    reviewCount: card.reviewCount || card.reviews || "",
    rating: card.rating || "",
    badges: Array.isArray(card.badges) ? card.badges.slice(0, 4) : card.badges,
    shippingText: truncateText(card.shippingText || card.shipping || "", 120),
    promotionText: truncateText(card.promotionText || card.discountText || card.saleText || "", 120),
    hasImage: Boolean(card.imageSrc || card.image || card.imageUrl || card.candidate_image_url),
  };
}

function compactCrawlPageForLLM(page = {}, productLimit = MAX_LLM_CRAWL_PRODUCT_CARDS, textLimit = 900) {
  return {
    competitorName: page.competitorName,
    competitorUrl: page.competitorUrl,
    pageIndex: page.pageIndex,
    url: page.url,
    title: page.title,
    shopName: page.shopName,
    sortLabel: page.sortLabel,
    visibleProductOrderBasis: page.visibleProductOrderBasis,
    pagination: page.pagination,
    productCardsVisible: page.productCardsVisible,
    productCards: Array.isArray(page.productCards) ? page.productCards.slice(0, productLimit).map(compactProductCardForLLM) : [],
    visibleTextSnippet: truncateText(page.visibleTextSnippet || "", textLimit),
    pageHealth: page.pageHealth,
    screenshotCaptured: page.screenshotCaptured,
    screenshotRef: page.screenshotRef,
    screenshotStorage: page.screenshotStorage,
    screenshotExpiresAt: page.screenshotExpiresAt,
    screenshotError: page.screenshotError,
  };
}

function summarizeShopPagesForLLM(pages = []) {
  const cards = pages.flatMap((page) => Array.isArray(page?.productCards) ? page.productCards : []);
  const sampleCards = cards.slice(0, 24).map(compactProductCardForLLM);
  const values = (selector, limit = 12) => Array.from(new Set(
    cards.map(selector).filter(Boolean).map((value) => String(value).trim()).filter(Boolean)
  )).slice(0, limit);
  return {
    pages: pages.length,
    visibleProducts: pages.reduce((sum, page) => sum + Number(page?.productCardsVisible || 0), 0),
    sortLabels: Array.from(new Set(pages.map((page) => page?.sortLabel).filter(Boolean))),
    priceSamples: values((card) => card.price, 16),
    ratingSamples: values((card) => card.rating, 8),
    reviewSamples: values((card) => card.reviewCount || card.reviews, 8),
    promotionSamples: values((card) => card.promotionText || card.discountText || card.saleText, 12),
    shippingSamples: values((card) => card.shippingText || card.shipping, 12),
    titleSamples: sampleCards.map((card) => card.title).filter(Boolean).slice(0, 16),
    productSamples: sampleCards,
  };
}

function compactPageDataForLLM(pageData = {}) {
  if (!pageData || typeof pageData !== "object") return pageData;
  const cards = Array.isArray(pageData.productCards) ? pageData.productCards : [];
  const links = Array.isArray(pageData.productLinks) ? pageData.productLinks : [];
  return {
    url: pageData.url || pageData.currentPageUrl || "",
    title: pageData.title || "",
    h1: pageData.h1 || "",
    shopName: pageData.shopName || "",
    visibleText: truncateText(pageData.visibleText || pageData.text || "", 1400),
    metaDescription: truncateText(pageData.metaDescription || "", 400),
    pageHealth: pageData.pageHealth,
    pageEvidence: pageData.pageEvidence,
    etsyShopProductContext: pageData.etsyShopProductContext,
    productCardsCount: cards.length,
    productCards: cards.slice(0, MAX_LLM_PRODUCT_CARDS).map(compactProductCardForLLM),
    productLinksCount: links.length,
    productLinks: links.slice(0, MAX_LLM_PRODUCT_CARDS).map((link) => ({
      href: link.href || "",
      text: truncateText(link.text || link.title || "", 160),
    })),
  };
}

function compactToolResultForLLM(toolName = "", result = {}) {
  if (!result || typeof result !== "object") return result;
  const base = {
    ok: result.ok,
    error: result.error,
    message: truncateText(result.message || "", 500),
    tabId: result.tabId,
    url: result.url,
    finalUrl: result.finalUrl,
    searchUrl: result.searchUrl,
    queryUsed: result.queryUsed,
    evidenceOk: result.evidenceOk,
    evidenceStatus: result.evidenceStatus,
    isCaptcha: result.isCaptcha,
    timedOut: result.timedOut,
    readError: result.readError,
  };

  if (result.pageData && typeof result.pageData === "object") {
    base.pageData = compactPageDataForLLM(result.pageData);
  } else if (typeof result.pageData === "string") {
    base.pageData = truncateText(result.pageData, 500);
  }

  if (Array.isArray(result.retryAttempts)) {
    base.retryAttempts = result.retryAttempts.slice(-4).map((attempt) => ({
      searchUrl: attempt.searchUrl,
      searchType: attempt.searchType,
      evidenceStatus: attempt.evidenceStatus,
      message: truncateText(attempt.message || "", 220),
    }));
  }

  if (toolName === "collect_etsy_shop_pages" && Array.isArray(result.pages)) {
    base.tool = result.tool;
    base.sourceUrl = result.sourceUrl;
    base.pagesCollected = result.pagesCollected;
    base.maxPages = result.maxPages;
    base.completedFullCrawl = result.completedFullCrawl;
    base.stoppedReason = result.stoppedReason;
    base.totalVisibleProductCards = result.totalVisibleProductCards;
    base.uniqueListingCount = result.uniqueListingCount;
    base.sortLabels = result.sortLabels;
    base.artifactStore = result.artifactStore;
    base.screenshotPolicy = result.screenshotPolicy;
    base.listingDetails = Array.isArray(result.listingDetails) ? result.listingDetails.slice(0, 3).map((detail) => ({
      ok: detail.ok,
      listingUrl: detail.listingUrl,
      screenshotRef: detail.screenshotRef,
      screenshotCaptureMode: detail.screenshotCaptureMode,
      pageData: detail.pageData ? compactPageDataForLLM(detail.pageData) : undefined,
      error: truncateText(detail.error || "", 180),
    })) : [];
    base.productEvidenceSummary = summarizeShopPagesForLLM(result.pages);
    base.pages = result.pages.slice(0, MAX_LLM_CRAWL_PAGES).map((page) => compactCrawlPageForLLM(page));
    if (result.pages.length > MAX_LLM_CRAWL_PAGES) {
      base.omittedPages = result.pages.length - MAX_LLM_CRAWL_PAGES;
    }
  }

  if (toolName === "collect_etsy_competitor_shops" && Array.isArray(result.shops)) {
    base.tool = result.tool;
    base.competitorsRequested = result.competitorsRequested;
    base.competitorsCollected = result.competitorsCollected;
    base.cacheHits = result.cacheHits;
    base.pagesCollected = result.pagesCollected;
    base.screenshotRefs = Array.isArray(result.screenshotRefs) ? result.screenshotRefs.slice(0, 12) : [];
    base.artifactStore = result.artifactStore;
    base.screenshotPolicy = result.screenshotPolicy;
    base.nextStep = result.nextStep;
    base.allPages = Array.isArray(result.allPages)
      ? result.allPages.slice(0, 12).map((page) => compactCrawlPageForLLM(page, 10, 500))
      : [];
    base.shops = result.shops.slice(0, 4).map((shop) => ({
      ok: shop.ok,
      competitorName: shop.competitorName,
      url: shop.url,
      cacheHit: shop.cacheHit,
      error: truncateText(shop.error || "", 180),
      pagesCollected: shop.pagesCollected,
      completedFullCrawl: shop.completedFullCrawl,
      stoppedReason: shop.stoppedReason,
      totalVisibleProductCards: shop.totalVisibleProductCards,
      uniqueListingCount: shop.uniqueListingCount,
      sortLabels: shop.sortLabels,
      productEvidenceSummary: summarizeShopPagesForLLM(Array.isArray(shop.pages) ? shop.pages : []),
      pages: Array.isArray(shop.pages) ? shop.pages.slice(0, MAX_LLM_CRAWL_PAGES).map((page) => compactCrawlPageForLLM(page)) : [],
      listingDetails: Array.isArray(shop.listingDetails) ? shop.listingDetails.slice(0, 3).map((detail) => ({
        ok: detail.ok,
        listingUrl: detail.listingUrl,
        screenshotRef: detail.screenshotRef,
        screenshotCaptureMode: detail.screenshotCaptureMode,
        pageData: detail.pageData ? compactPageDataForLLM(detail.pageData) : undefined,
        error: truncateText(detail.error || "", 180),
      })) : [],
    }));
    if (Array.isArray(result.allPages) && result.allPages.length > MAX_LLM_CRAWL_PAGES) {
      base.omittedPages = result.allPages.length - MAX_LLM_CRAWL_PAGES;
    }
  }

  if (toolName === "analyze_etsy_shop_crawl_screenshots") {
    base.tool = result.tool;
    base.analysisWorkflow = result.analysisWorkflow;
    base.competitorName = result.competitorName;
    base.screenshotsRequested = result.screenshotsRequested;
    base.screenshotsAnalyzed = result.screenshotsAnalyzed;
    base.stage_observations = Array.isArray(result.stage_observations) ? result.stage_observations.slice(0, 8).map((analysis) => ({
      stage: analysis.stage,
      competitorName: analysis.competitorName,
      competitorUrl: analysis.competitorUrl,
      pageIndex: analysis.pageIndex,
      url: analysis.url,
      screenshotRef: analysis.screenshotRef,
      ok: analysis.ok,
      visual_tone: truncateText(analysis.visual_tone || "", 180),
      hero_or_first_grid_signals: Array.isArray(analysis.hero_or_first_grid_signals) ? analysis.hero_or_first_grid_signals.slice(0, 6) : analysis.hero_or_first_grid_signals,
      product_image_patterns: Array.isArray(analysis.product_image_patterns) ? analysis.product_image_patterns.slice(0, 6) : analysis.product_image_patterns,
      promotion_or_trust_signals: Array.isArray(analysis.promotion_or_trust_signals) ? analysis.promotion_or_trust_signals.slice(0, 6) : analysis.promotion_or_trust_signals,
      layout_and_merchandising: truncateText(analysis.layout_and_merchandising || "", 260),
      report_observation: truncateText(analysis.report_observation || "", 260),
      risks_or_limits: truncateText(analysis.risks_or_limits || "", 220),
    })) : [];
    base.stage_synthesis = Array.isArray(result.stage_synthesis) ? result.stage_synthesis.slice(0, 6).map((item) => ({
      competitorName: item.competitorName,
      pagesAnalyzed: item.pagesAnalyzed,
      urls: item.urls,
      visual_tone_summary: truncateText(item.visual_tone_summary || "", 260),
      hero_signal_summary: Array.isArray(item.hero_signal_summary) ? item.hero_signal_summary.slice(0, 8) : item.hero_signal_summary,
      product_image_pattern_summary: Array.isArray(item.product_image_pattern_summary) ? item.product_image_pattern_summary.slice(0, 8) : item.product_image_pattern_summary,
      promotion_or_trust_signal_summary: Array.isArray(item.promotion_or_trust_signal_summary) ? item.promotion_or_trust_signal_summary.slice(0, 8) : item.promotion_or_trust_signal_summary,
      merchandising_summary: Array.isArray(item.merchandising_summary) ? item.merchandising_summary.slice(0, 6) : item.merchandising_summary,
      limitation_summary: truncateText(item.limitation_summary || "", 260),
      productSamples: Array.isArray(item.productSamples) ? item.productSamples.slice(0, 8) : [],
    })) : [];
    if (result.stage_report_inputs) {
      base.stage_report_inputs = {
        evidenceLedgerEntries: Array.isArray(result.stage_report_inputs.evidenceLedgerEntries)
          ? result.stage_report_inputs.evidenceLedgerEntries.slice(0, 8)
          : [],
        competitorBenchmarkDrafts: Array.isArray(result.stage_report_inputs.competitorBenchmarkDrafts)
          ? result.stage_report_inputs.competitorBenchmarkDrafts.slice(0, 4)
          : [],
        diagnosticDepthHints: Array.isArray(result.stage_report_inputs.diagnosticDepthHints)
          ? result.stage_report_inputs.diagnosticDepthHints.slice(0, 4)
          : [],
        nextStepInstruction: truncateText(result.stage_report_inputs.nextStepInstruction || "", 500),
      };
    }
    base.analyses = Array.isArray(result.analyses) ? result.analyses.slice(0, 6).map((analysis) => ({
      pageIndex: analysis.pageIndex,
      url: analysis.url,
      screenshotRef: analysis.screenshotRef,
      ok: analysis.ok,
      visual_tone: truncateText(analysis.visual_tone || "", 160),
      report_observation: truncateText(analysis.report_observation || "", 260),
      error: truncateText(analysis.error || "", 180),
    })) : [];
    base.evidenceLedgerEntries = Array.isArray(result.evidenceLedgerEntries)
      ? result.evidenceLedgerEntries.slice(0, 6)
      : [];
  }

  if (Array.isArray(result.productCards)) {
    base.productCardsCount = result.productCards.length;
    base.productCards = result.productCards.slice(0, MAX_LLM_PRODUCT_CARDS).map(compactProductCardForLLM);
  }
  return Object.fromEntries(Object.entries(base).filter(([, value]) => value !== undefined && value !== "" && value !== null));
}

function compactJsonStringForLLM(payload) {
  const json = JSON.stringify(payload);
  if (json.length <= MAX_LLM_MESSAGE_CHARS) return json;
  return JSON.stringify({
    type: payload?.type || "compressed_payload",
    tool: payload?.tool,
    note: `Payload compressed from ${json.length} chars to avoid LLM request-size limits.`,
    result: compactToolResultForLLM(payload?.tool, payload?.result || {}),
  });
}

function compactMessageContentForLLM(content) {
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (part?.type !== "text" || typeof part.text !== "string") return part;
      if (part.text.length <= MAX_LLM_MESSAGE_CHARS) return part;
      return {
        ...part,
        text: `${part.text.slice(0, MAX_LLM_MESSAGE_CHARS)}\n...[message truncated ${part.text.length - MAX_LLM_MESSAGE_CHARS} chars before LLM call]`,
      };
    });
  }
  if (typeof content === "string" && content.length > MAX_LLM_MESSAGE_CHARS) {
    return `${content.slice(0, MAX_LLM_MESSAGE_CHARS)}\n...[message truncated ${content.length - MAX_LLM_MESSAGE_CHARS} chars before LLM call]`;
  }
  return content;
}

function compactMessagesForLLM(messages = []) {
  const preserved = messages.length > MAX_LLM_HISTORY_MESSAGES
    ? [messages[0], ...messages.slice(-(MAX_LLM_HISTORY_MESSAGES - 1))]
    : messages;
  const compacted = preserved.map((message) => ({
    ...message,
    content: compactMessageContentForLLM(message.content),
  }));
  // A screenshot is evidence for the current decision, not conversation
  // history. Keep only the newest image part so every turn does not resend all
  // prior full-size data URLs to the model.
  let newestImageMessage = -1;
  compacted.forEach((message, index) => {
    if (Array.isArray(message.content) && message.content.some((part) => part?.type === "image_url")) {
      newestImageMessage = index;
    }
  });
  if (newestImageMessage >= 0) {
    compacted.forEach((message, index) => {
      if (index >= newestImageMessage || !Array.isArray(message.content)) return;
      message.content = message.content.filter((part) => part?.type !== "image_url");
    });
  }
  let totalChars = compacted.reduce((sum, message) => sum + JSON.stringify(message).length, 0);
  if (totalChars <= MAX_LLM_TOTAL_CHARS) return compacted;

  // Keep the system prompt, the initial request, and the newest evidence. Older
  // tool turns are already persisted in toolHistory/checkpoints and should not
  // make every later planning request grow without bound.
  const result = [];
  const pinned = new Set([0, Math.min(1, compacted.length - 1)]);
  const newestFirst = compacted.map((message, index) => ({ message, index })).reverse();
  const selected = new Set(pinned);
  let budget = MAX_LLM_TOTAL_CHARS;
  for (const { message, index } of newestFirst) {
    if (selected.has(index)) continue;
    const size = JSON.stringify(message).length;
    if (size <= budget) {
      selected.add(index);
      budget -= size;
    }
  }
  for (const index of pinned) {
    budget -= JSON.stringify(compacted[index]).length;
  }
  for (const index of [...selected].sort((a, b) => a - b)) {
    result.push(compacted[index]);
  }
  totalChars = result.reduce((sum, message) => sum + JSON.stringify(message).length, 0);
  return totalChars <= MAX_LLM_TOTAL_CHARS ? result : result.map((message, index) => {
    if (index < 2 || typeof message.content !== "string") return message;
    const available = Math.max(1000, Math.floor(MAX_LLM_TOTAL_CHARS / result.length));
    return { ...message, content: message.content.slice(0, available) + "\n...[older evidence compacted]" };
  });
}

export const __testInternals = {
  compactToolResultForLLM,
  compactMessagesForLLM,
};

async function saveAgentCheckpoint(sessionKey, checkpoint = {}) {
  if (!checkpointStorageAvailable()) return;
  const payload = {
    ...checkpoint,
    sessionKey,
    updatedAt: new Date().toISOString(),
    messages: serializeMessagesForCheckpoint(checkpoint.messages || []),
    toolHistory: serializeToolHistoryForCheckpoint(checkpoint.toolHistory || []),
  };
  await new Promise((resolve) => {
    chrome.storage.local.set({
      [checkpointKey(sessionKey)]: payload,
      [CHECKPOINT_LATEST_KEY]: payload,
    }, resolve);
  });
}

async function loadAgentCheckpoint(sessionKey) {
  if (!checkpointStorageAvailable()) return null;
  const data = await new Promise((resolve) => {
    chrome.storage.local.get([checkpointKey(sessionKey), CHECKPOINT_LATEST_KEY], resolve);
  });
  const checkpoint = data[checkpointKey(sessionKey)] || data[CHECKPOINT_LATEST_KEY] || null;
  if (!checkpoint) return null;
  return {
    ...checkpoint,
    messages: hydrateMessagesFromCheckpoint(checkpoint.messages || []),
  };
}

async function clearAgentCheckpoint(sessionKey) {
  if (!checkpointStorageAvailable()) return;
  await new Promise((resolve) => {
    chrome.storage.local.remove([checkpointKey(sessionKey), CHECKPOINT_LATEST_KEY], resolve);
  });
}

function hasConcreteVisualTerms(text) {
  return /颜色|配色|材质|金属|铁艺|铜|铝|钢|塑料|木|硅胶|玻璃|陶瓷|布|皮革|亚克力|轮廓|造型|形状|结构|弧形|圆形|方形|边缘|纹理|表面|光泽|磨砂|透明|图案|花纹|主体|比例|开孔|把手|支架|外观|细节|同模|相似|差异/i.test(String(text || ""));
}

function hasVisualScore(value) {
  if (value === undefined || value === null || value === "") return false;
  if (typeof value === "number") return Number.isFinite(value);
  return /\d/.test(String(value));
}

function summarizeProductCards(cards = []) {
  return cards.slice(0, 12).map((card) => ({
    index: card.index,
    title: card.title,
    price: card.price,
    href: card.href,
    imageSrc: card.imageSrc,
    cardRect: card.cardRect,
    imageRect: card.imageRect,
    extractionConfidence: card.extractionConfidence,
  }));
}

const SOURCING_SKILL_RE = /domestic_sourcing_finder|etsy_sourcing_finder/;
const IMAGE_SEARCH_TOOLS = ["image_search_1688", "image_search_taobao", "image_search_in_browser"];
const COMPLIANCE_SKILL_RE = /etsy_compliance_auditor/;

export function isComplianceSkill(skillId = "") {
  return COMPLIANCE_SKILL_RE.test(String(skillId || ""));
}

const COMPLIANCE_ALLOWED_TOOLS = new Set([
  "read_current_page",
  "open_new_tab",
  "close_tab",
  "navigate_to",
  "search_in_browser",
  "collect_etsy_shop_pages",
  "collect_etsy_competitor_shops",
  "analyze_etsy_shop_crawl_screenshots",
  "collect_etsy_listing_reviews",
  "etsy_api_get_capabilities",
  "etsy_api_get_store_snapshot",
  "etsy_api_get_products",
  "etsy_api_get_product_info",
]);

function isSourcingSkill(skillId = "") {
  return SOURCING_SKILL_RE.test(String(skillId || ""));
}

function isReviewSkill(skillId = "") {
  return /etsy_review_analyzer/.test(String(skillId || ""));
}

function isOperationsSkill(skillId = "") {
  return /etsy_operations_tracker/.test(String(skillId || ""));
}

function hasSupportedEtsyAnalytics(toolHistory = []) {
  return hasSuccessfulToolCall(toolHistory, (entry) => {
    if (entry.tool === "etsy_api_get_analytics") return entry.result?.result?.supported === true;
    if (entry.tool === "etsy_api_get_store_snapshot") return entry.result?.result?.analytics?.supported === true;
    return false;
  });
}

function getReviewEvidenceSummary(toolHistory = [], pageContext = {}) {
  const sources = [
    ...(Array.isArray(pageContext?.reviews) ? [{ result: { reviews: pageContext.reviews, reviewPagination: pageContext.reviewPagination } }] : []),
    ...toolHistory.filter((entry) => entry?.tool === "collect_etsy_listing_reviews" && entry?.result?.ok !== false),
  ];
  const reviews = sources.flatMap((entry) => {
    const result = entry.result || {};
    if (Array.isArray(result.reviews)) return result.reviews;
    return Array.isArray(result.pages) ? result.pages.flatMap((page) => page.reviews || []) : [];
  });
  const unique = [...new Map(reviews.map((review) => [review.reviewId || `${review.text}-${review.rating}`, review])).values()];
  return {
    sampleCount: unique.length,
    lowStarCount: unique.filter((review) => Number(review.rating) > 0 && Number(review.rating) <= 3).length,
    hasCollection: toolHistory.some((entry) => entry?.tool === "collect_etsy_listing_reviews" && entry?.result?.ok !== false),
  };
}

function isImageSearchTool(toolName = "") {
  return IMAGE_SEARCH_TOOLS.includes(toolName);
}

function lastIncompleteImageSearch(toolHistory = []) {
  for (let i = toolHistory.length - 1; i >= 0; i--) {
    const entry = toolHistory[i];
    if (!isImageSearchTool(entry.tool)) continue;
    const result = entry.result || {};
    const hasProducts = (result.pageData?.productLinks || []).length > 0 || (result.pageData?.productCards || []).length > 0;
    if (result.imageSearchIncomplete || result.requiresImageSearchRetry || (!result.ok && !hasProducts && !result.isCaptcha)) {
      return entry;
    }
    return null;
  }
  return null;
}

function hasImageSearchAttempt(toolHistory = []) {
  return toolHistory.some((entry) => isImageSearchTool(entry.tool));
}

function hasPreparedCleanImageAttempt(toolHistory = []) {
  return toolHistory.some((entry) => entry.tool === "prepare_clean_product_image");
}

function countToolCalls(toolHistory = [], toolName) {
  return toolHistory.filter((entry) => entry.tool === toolName).length;
}

function isExplicitTextFallbackAllowed(userInstruction = "") {
  return /允许文本|文本兜底|关键词兜底|文字搜索|文本搜索|标品|standard/i.test(String(userInstruction || ""));
}

function isExplicitSourcingRequested(userInstruction = "") {
  return /1688|寻源|货源|采购|供应商|源头|工厂|拿样|比价|套利|采购直达|供货|批发|起批/i.test(String(userInstruction || ""));
}

function hasProductCandidates(result = {}) {
  const pageData = result.pageData || result;
  const cards = pageData.productCards || result.productCards || [];
  const links = pageData.productLinks || result.productLinks || [];
  return (Array.isArray(cards) && cards.length > 0) || (Array.isArray(links) && links.length > 0);
}

function lastSuccessfulSourcingSearchWithProducts(toolHistory = []) {
  for (let i = toolHistory.length - 1; i >= 0; i--) {
    const entry = toolHistory[i] || {};
    const engine = String(entry.arguments?.engine || "").toLowerCase();
    const isSearchTool = isImageSearchTool(entry.tool) ||
      (entry.tool === "search_in_browser" && ["1688", "taobao"].includes(engine)) ||
      entry.tool === "input_text_and_search";
    if (!isSearchTool) continue;
    const result = entry.result || {};
    if (result.ok === false || result.error || result.isCaptcha) continue;
    if (hasProductCandidates(result)) return entry;
  }
  return null;
}

function isSupplierDetailUrl(url = "") {
  return /detail\.1688\.com\/offer\/|item\.taobao\.com\/item\.htm|detail\.tmall\.com/i.test(String(url || ""));
}

function hasSupplierDetailPageEvidence(toolHistory = [], pageContext = {}) {
  if (isSupplierDetailUrl(pageContext?.url)) return true;
  return toolHistory.some((entry) => {
    const urls = [
      entry.arguments?.url,
      entry.result?.url,
      entry.result?.finalUrl,
      entry.result?.pageData?.url,
      entry.result?.pageData?.canonicalUrl,
    ];
    return urls.some(isSupplierDetailUrl);
  });
}

function isSourcingSearchToolCall(toolName = "", toolArgs = {}) {
  if (isImageSearchTool(toolName) || toolName === "input_text_and_search") return true;
  if (toolName !== "search_in_browser") return false;
  const engine = String(toolArgs.engine || "").toLowerCase();
  const query = String(toolArgs.query || toolArgs.keyword || "");
  return ["1688", "taobao"].includes(engine) || /1688|淘宝|货源|供应商|采购|批发|起批|工厂/i.test(query);
}

export function getSourcingWorkflowGuardError({
  skillId,
  toolName,
  toolArgs = {},
  userInstruction = "",
  toolHistory = [],
  pageContext = {},
} = {}) {
  if (!isSourcingSkill(skillId)) return null;
  if (!isSourcingSearchToolCall(toolName, toolArgs)) return null;

  const completedSearch = lastSuccessfulSourcingSearchWithProducts(toolHistory);
  if (!completedSearch) return null;
  if (hasSupplierDetailPageEvidence(toolHistory, pageContext)) return null;

  const incompleteImageSearch = lastIncompleteImageSearch(toolHistory);
  if (incompleteImageSearch) return null;
  if (isExplicitTextFallbackAllowed(userInstruction)) return null;

  const productCards = completedSearch.result?.pageData?.productCards || completedSearch.result?.productCards || [];
  const productLinks = completedSearch.result?.pageData?.productLinks || completedSearch.result?.productLinks || [];
  return {
    type: "tool_error",
    tool: toolName,
    error: "当前已经拿到 1688/淘宝结果页候选商品卡片，不允许继续换关键词、重新图搜或切换淘宝搜索。下一步必须基于现有 productCards/productLinks 做视觉初筛，按目标主图的外观、材质、结构和细节排序，打开 1-3 个最相似的详情页审计价格、MOQ、规格和供应商资质；只有当前结果明确为空、验证码/登录墙阻断，或用户明确要求文本兜底时，才允许重新搜索。",
    previousSearch: {
      tool: completedSearch.tool,
      productCards: Array.isArray(productCards) ? summarizeProductCards(productCards) : [],
      productLinks: Array.isArray(productLinks) ? productLinks.slice(0, 12) : [],
    },
  };
}

function isLogisticsOrPolicySearchQuery(query = "") {
  return /运费|物流|空派|海运|快递|货代|FBA|配送费|佣金|费率|关税|税率|清关|政策|认证|合规|freight|shipping|logistics|fulfillment|tariff|customs|duty|fee|commission|policy/i.test(String(query || ""));
}

function isShopOptimizerOnly(skillId = "") {
  const id = String(skillId || "");
  return id.includes("etsy_global_shop_optimizer") && !id.includes("etsy_sourcing_finder") && !id.includes("domestic_sourcing_finder");
}

function isEtsyBusinessSkill(skillId = "") {
  return String(skillId || "").includes("etsy_");
}

function hasSuccessfulToolCall(toolHistory = [], predicate) {
  return toolHistory.some((entry) => {
    if (!predicate(entry)) return false;
    const result = entry.result || {};
    return result.ok !== false && !result.error;
  });
}

function normalizeUrlForWorkflow(url = "") {
  try {
    const parsed = new URL(String(url || ""));
    parsed.hash = "";
    parsed.searchParams.sort?.();
    return `${parsed.origin}${parsed.pathname.replace(/\/$/, "")}${parsed.search}`;
  } catch (_) {
    return String(url || "").replace(/#.*$/, "").replace(/\/$/, "");
  }
}

function getOpenTabEvidence(toolHistory = []) {
  return toolHistory.filter((entry) => entry?.tool === "open_new_tab" && entry?.result?.ok !== false && !entry?.result?.error);
}

function getClosedTabIds(toolHistory = []) {
  const ids = new Set();
  toolHistory.forEach((entry) => {
    if (entry?.tool !== "close_tab" || entry?.result?.ok === false || entry?.result?.error) return;
    const tabId = entry.arguments?.tabId;
    if (tabId !== undefined && tabId !== null) ids.add(String(tabId));
  });
  return ids;
}

function getUnclosedEvidenceTabs(toolHistory = []) {
  const closedIds = getClosedTabIds(toolHistory);
  return getOpenTabEvidence(toolHistory).filter((entry) => {
    const tabId = entry.result?.tabId;
    if (tabId === undefined || tabId === null) return false;
    if (entry.result?.isCaptcha) return false;
    if (entry.arguments?.keepTab || entry.result?.keepTab) return false;
    return !closedIds.has(String(tabId));
  });
}

function getRepeatedOpenEvidence(toolHistory = [], url = "") {
  const normalizedTarget = normalizeUrlForWorkflow(url);
  if (!normalizedTarget) return [];
  return getOpenTabEvidence(toolHistory).filter((entry) => {
    const openedUrl = entry.result?.finalUrl || entry.result?.url || entry.result?.pageData?.url || entry.arguments?.url;
    return normalizeUrlForWorkflow(openedUrl) === normalizedTarget;
  });
}

function getEtsyBrowserWorkflowGuardError({ skillId = "", toolName = "", toolArgs = {}, toolHistory = [] } = {}) {
  if (!isEtsyBusinessSkill(skillId)) return null;
  if (toolName !== "open_new_tab") return null;

  const targetUrl = String(toolArgs.url || "");
  const repeated = getRepeatedOpenEvidence(toolHistory, targetUrl);
  if (repeated.length > 0) {
    const latest = repeated[repeated.length - 1];
    return {
      type: "tool_error",
      tool: toolName,
      error: "该 URL 本轮已经打开并读取过，不能重复 open_new_tab 卡住流程。请复用已有 pageData/toolHistory 证据；若是 Etsy 店铺页且需要更深竞品数据，下一步调用 collect_etsy_shop_pages；若已完成取证，请调用 close_tab 关闭 tabId 后继续分析。",
      url: targetUrl,
      existingTabId: latest.result?.tabId,
      existingPageDataSummary: {
        url: latest.result?.pageData?.url || latest.result?.finalUrl || latest.result?.url,
        title: latest.result?.pageData?.title,
        productCards: Array.isArray(latest.result?.pageData?.productCards) ? latest.result.pageData.productCards.length : 0,
      },
    };
  }

  const unclosedTabs = getUnclosedEvidenceTabs(toolHistory);
  if (unclosedTabs.length >= 3) {
    return {
      type: "tool_error",
      tool: toolName,
      error: "本轮已有 3 个或以上已完成取证但未关闭的新标签页。请先对已打开页面做采集/截图分析，并调用 close_tab 关闭不再需要的 tabId，避免持续开新标签页导致 workflow 卡住。",
      openTabIds: unclosedTabs.map((entry) => entry.result?.tabId).filter(Boolean),
    };
  }

  if (/etsy\.com\/shop\//i.test(targetUrl)) {
    const shopOpenCount = getOpenTabEvidence(toolHistory).filter((entry) =>
      /etsy\.com\/shop\//i.test(String(entry.arguments?.url || entry.result?.url || entry.result?.finalUrl || entry.result?.pageData?.url || ""))
    ).length;
    const crawlCount = countToolCalls(toolHistory, "collect_etsy_shop_pages");
    const batchCrawlCount = countToolCalls(toolHistory, "collect_etsy_competitor_shops");
    if (shopOpenCount >= 2 && crawlCount === 0 && batchCrawlCount === 0) {
      return {
        type: "tool_error",
        tool: toolName,
        error: "已经打开过多个 Etsy 店铺页，但还没有执行分页采集。下一步不要继续 open_new_tab；如果已有 2-3 个店铺 URL，请调用 collect_etsy_competitor_shops 批量采集，并随后调用 analyze_etsy_shop_crawl_screenshots。",
        openedShopPages: shopOpenCount,
      };
    }
  }

  return null;
}

function getToolTimeoutMs(toolName = "") {
  if (["open_new_tab", "close_tab", "read_current_page"].includes(toolName)) return 45_000;
  if (["search_in_browser", "collect_etsy_shop_pages"].includes(toolName)) return 120_000;
  if (toolName === "collect_etsy_competitor_shops") return 300_000;
  if (toolName === "analyze_etsy_shop_crawl_screenshots") return 180_000;
  if (/image_search|prepare_clean_product_image/i.test(toolName)) return 180_000;
  return 120_000;
}

async function runToolWithTimeout(toolName, toolArgs) {
  const timeoutMs = getToolTimeoutMs(toolName);
  let timeoutId = null;
  try {
    return await Promise.race([
      tools[toolName](toolArgs),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`${toolName} timed out after ${Math.round(timeoutMs / 1000)} seconds`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function snapshotTabIds() {
  if (typeof chrome === "undefined" || !chrome.tabs?.query) return new Set();
  const tabs = await new Promise((resolve) => chrome.tabs.query({}, (items) => resolve(items || [])));
  return new Set(tabs.map((tab) => tab.id).filter((id) => Number.isInteger(id)));
}

async function closeTabsCreatedDuringTimedOutTool(beforeTabIds = new Set()) {
  if (typeof chrome === "undefined" || !chrome.tabs?.query) return [];
  const tabs = await new Promise((resolve) => chrome.tabs.query({}, (items) => resolve(items || [])));
  const candidates = tabs.filter((tab) => {
    if (!Number.isInteger(tab.id) || beforeTabIds.has(tab.id)) return false;
    const url = String(tab.url || "");
    return /etsy\.com|google\.|bing\.com|1688\.com|taobao\.com/i.test(url);
  });
  await Promise.all(candidates.map((tab) => new Promise((resolve) => {
    chrome.tabs.remove(tab.id, () => resolve());
  })));
  return candidates.map((tab) => tab.id);
}

function hasMeaningfulPageDom(pageContext = {}) {
  const pageHealth = pageContext?.pageHealth || {};
  if (pageHealth.isLikelyBlocked) return false;
  if (pageHealth.hasMeaningfulDom) return true;
  if (String(pageContext?.visibleText || pageContext?.text || "").trim().length >= 120) return true;
  if (Array.isArray(pageContext?.productCards) && pageContext.productCards.length > 0) return true;
  if (Array.isArray(pageContext?.productLinks) && pageContext.productLinks.length > 0) return true;
  const title = String(pageContext?.title || "").trim();
  const h1 = String(pageContext?.h1 || "").trim();
  return Boolean((title && title.toLowerCase() !== "etsy.com") || h1);
}

function getToolPageDataCandidates(toolHistory = []) {
  const candidates = [];
  toolHistory.forEach((entry) => {
    if (!entry || entry.result?.ok === false || entry.result?.error) return;
    if (entry.tool === "read_current_page") {
      candidates.push({
        sourceRef: entry.result?.url || entry.result?.currentPageUrl || "read_current_page",
        pageData: entry.result,
      });
    }
    if (["open_new_tab", "navigate_to", "search_in_browser"].includes(entry.tool) && entry.result?.pageData) {
      candidates.push({
        sourceRef: entry.result.pageData.url || entry.result?.url || entry.arguments?.url || entry.tool,
        pageData: entry.result.pageData,
      });
    }
    const crawlPages = [];
    if (entry.tool === "collect_etsy_shop_pages" && Array.isArray(entry.result?.pages)) {
      crawlPages.push(...entry.result.pages);
    }
    if (entry.tool === "collect_etsy_competitor_shops" && Array.isArray(entry.result?.allPages)) {
      crawlPages.push(...entry.result.allPages);
    }
    if (crawlPages.length > 0) {
      crawlPages.forEach((page) => {
        candidates.push({
          sourceRef: page?.url || entry.result?.sourceUrl || entry.result?.tool || "collect_etsy_shop_pages",
          pageData: {
            url: page?.url,
            title: page?.title,
            visibleText: page?.visibleTextSnippet,
            productCards: page?.productCards,
            pageHealth: page?.pageHealth,
            etsyShopProductContext: {
              sortLabel: page?.sortLabel,
              visibleProductOrderBasis: page?.visibleProductOrderBasis,
              pagination: page?.pagination,
            },
          },
        });
      });
    }
  });
  return candidates;
}

function hasMeaningfulToolPageDom(toolHistory = []) {
  return getToolPageDataCandidates(toolHistory).some(({ pageData }) => hasMeaningfulPageDom(pageData));
}

function getBestPageDomEvidence(toolHistory = [], pageContext = {}) {
  const candidates = [
    { sourceRef: pageContext?.url || "当前 Etsy 页面", pageData: pageContext },
    ...getToolPageDataCandidates(toolHistory),
  ];
  const best = candidates.find(({ pageData }) => hasMeaningfulPageDom(pageData));
  if (!best) return null;
  const pageData = best.pageData || {};
  const productCount = Array.isArray(pageData.productCards) ? pageData.productCards.length : 0;
  const shopContext = pageData.etsyShopProductContext || {};
  const observed = [
    pageData.title || pageData.h1 || "",
    productCount ? `可见商品样本 ${productCount} 个` : "",
    shopContext.sortLabel ? `排序口径 ${shopContext.sortLabel}` : "",
    String(pageData.visibleText || pageData.text || "").replace(/\s+/g, " ").trim().slice(0, 180),
  ].filter(Boolean).join("；");
  return {
    sourceRef: best.sourceRef || pageData.url || "当前 Etsy 页面",
    observedValue: observed || "已读取当前 Etsy 页面文本、标题、商品卡片或店铺上下文。",
  };
}

function hasEvidenceSource(toolHistory = [], pageContext = {}, sourceType = "") {
  const normalized = String(sourceType || "").toLowerCase();
  if (normalized === "page_dom") {
    return hasMeaningfulPageDom(pageContext) || hasMeaningfulToolPageDom(toolHistory);
  }
  if (normalized === "screenshot_visual") {
    return Boolean(pageContext?.screenshot) || hasSuccessfulToolCall(toolHistory, (entry) =>
      entry.tool === "analyze_etsy_shop_crawl_screenshots" &&
      Number(entry.result?.screenshotsAnalyzed || 0) > 0
    );
  }
  if (normalized === "etsy_api") {
    return hasSuccessfulToolCall(toolHistory, (entry) => String(entry.tool || "").startsWith("etsy_api_"));
  }
  if (normalized === "etsy_search") {
    return hasSuccessfulToolCall(toolHistory, (entry) =>
      entry.tool === "search_in_browser" &&
      String(entry.arguments?.engine || "").toLowerCase() === "etsy" &&
      hasValidEtsySearchEvidence(entry.result)
    );
  }
  if (normalized === "google_search") {
    return hasSuccessfulToolCall(toolHistory, (entry) => {
      const engine = String(entry.arguments?.engine || "").toLowerCase();
      return entry.tool === "search_in_browser" && (engine === "google" || engine === "google_us");
    });
  }
  if (normalized === "google_trends") {
    return hasSuccessfulToolCall(toolHistory, (entry) =>
      entry.tool === "search_in_browser" && String(entry.arguments?.engine || "").toLowerCase() === "google_trends"
    );
  }
  if (normalized === "sourcing_search") {
    return hasSuccessfulToolCall(toolHistory, (entry) =>
      isImageSearchTool(entry.tool) ||
      (entry.tool === "search_in_browser" && ["1688", "taobao"].includes(String(entry.arguments?.engine || "").toLowerCase()))
    );
  }
  if (normalized === "supplier_page") {
    return /1688\.com|taobao\.com|tmall\.com/i.test(String(pageContext?.url || "")) ||
      hasSuccessfulToolCall(toolHistory, (entry) => {
        const url = String(entry.result?.url || entry.result?.pageData?.url || entry.arguments?.url || "");
        return /detail\.1688\.com|item\.taobao\.com|tmall\.com/i.test(url);
      });
  }
  if (normalized === "official_policy" || normalized === "official_regulation") {
    const evidenceText = JSON.stringify({ toolHistory, pageContext });
    const officialPolicy = /etsy\.com\/(?:help|legal|seller-handbook|policies)\b/i.test(evidenceText);
    const officialRegulation = /(?:fda\.gov|cpsc\.gov|ftc\.gov|ec\.europa\.eu|europa\.eu|gov\.uk|gov\.cn|iso\.org|unece\.org|legislation\.gov|law\.cornell\.edu)\b/i.test(evidenceText);
    return normalized === "official_policy" ? officialPolicy : officialRegulation;
  }
  if (normalized === "user_input") return true;
  if (normalized === "assumption") return true;
  return false;
}

function hasLedgerType(ledger = [], sourceType = "") {
  return ledger.some((entry) => String(entry?.source_type || "").toLowerCase() === sourceType);
}

function hasAnyLedgerType(ledger = [], sourceTypes = []) {
  const normalizedTypes = sourceTypes.map((type) => String(type || "").toLowerCase());
  return ledger.some((entry) => normalizedTypes.includes(String(entry?.source_type || "").toLowerCase()));
}

function hasLedgerTypeTopic(ledger = [], sourceTypes = [], topicRegex) {
  const normalizedTypes = sourceTypes.map((type) => String(type || "").toLowerCase());
  return ledger.some((entry) => {
    const sourceType = String(entry?.source_type || "").toLowerCase();
    if (!normalizedTypes.includes(sourceType)) return false;
    const text = [
      entry?.source_ref,
      entry?.observed_value,
      entry?.used_for,
      entry?.limitation,
    ].filter(Boolean).join(" ");
    return topicRegex.test(text);
  });
}

function hasCompetitorVisualLedger(ledger = []) {
  return ledger.some((entry) => {
    if (String(entry?.source_type || "").toLowerCase() !== "screenshot_visual") return false;
    const text = [
      entry?.source_ref,
      entry?.observed_value,
      entry?.used_for,
      entry?.limitation,
    ].filter(Boolean).join(" ");
    return /竞品|头部|高排名|高销|对标|benchmark|competitor|top shop|best[-\s]?seller|listing|shop|店铺详情|商品详情/i.test(text);
  });
}

function hasEtsyShopCrawlScreenshotEvidence(toolHistory = []) {
  return toolHistory.some((entry) => {
    if (!["collect_etsy_shop_pages", "collect_etsy_competitor_shops"].includes(entry?.tool) || entry?.result?.ok === false) return false;
    const pages = entry.tool === "collect_etsy_competitor_shops"
      ? entry.result?.allPages
      : entry.result?.pages;
    return Array.isArray(pages) && pages.some((page) => page?.screenshotCaptured && page?.screenshotRef);
  });
}

function hasPageLevelCompetitorVisualEvidence(toolHistory = []) {
  return toolHistory.some((entry) => {
    if (entry?.tool === "analyze_etsy_shop_crawl_screenshots") {
      return Number(entry.result?.screenshotsAnalyzed || 0) > 0 ||
        (Array.isArray(entry.result?.analyses) && entry.result.analyses.some((item) => item?.ok !== false && item?.screenshotRef));
    }
    if (["open_new_tab", "collect_etsy_shop_pages", "collect_etsy_competitor_shops"].includes(entry?.tool)) {
      if (entry.result?.screenshotRef) return true;
      const pages = entry.tool === "collect_etsy_competitor_shops" ? entry.result?.allPages : entry.result?.pages;
      return Array.isArray(pages) && pages.some((page) => page?.screenshotCaptured && page?.screenshotRef);
    }
    return false;
  });
}

function validateEvidenceCoverageConsistency(out, toolHistory = []) {
  const errors = [];
  const fullText = `${out.overview || ""}\n${out.analysis || ""}\n${out.summary || ""}\n${JSON.stringify(out.data || [])}\n${JSON.stringify(out.competitor_benchmarks || [])}`;
  const admitsIncompleteCompetitorCapture = /未能|无法|未完成|未完整|只能基于.*搜索结果|完整.*竞品.*(?:文本|截图)|竞品.*(?:页面文本|全屏截图).*(?:缺失|未获得|无法)/i.test(fullText);
  const makesPageLevelClaims = /竞品.{0,30}(?:画廊|首图|内里|包装|模特|视觉调性|页面结构|店铺公告|发货承诺|详情页)|(?:竞品|头部店铺).{0,30}(?:反向工程|完整分析|深度分析|方法学习)/i.test(fullText);
  if (admitsIncompleteCompetitorCapture && makesPageLevelClaims && !hasPageLevelCompetitorVisualEvidence(toolHistory)) {
    errors.push("报告承认竞品店铺页面/截图未完整获取，却继续输出竞品画廊、首图、视觉调性或详情页方法结论。必须先完成竞品页面级 DOM + 截图取证；否则只能输出搜索结果初筛和明确待验证项。");
  }
  return errors;
}

function getUnanalyzedEtsyShopCrawlScreenshotRefs(toolHistory = []) {
  const capturedRefs = new Set();
  const analyzedRefs = new Set();
  toolHistory.forEach((entry) => {
    const pages = entry?.tool === "collect_etsy_competitor_shops"
      ? entry.result?.allPages
      : entry.result?.pages;
    if (["collect_etsy_shop_pages", "collect_etsy_competitor_shops"].includes(entry?.tool) && entry?.result?.ok !== false && Array.isArray(pages)) {
      pages.forEach((page) => {
        if (page?.screenshotCaptured && page?.screenshotRef) capturedRefs.add(page.screenshotRef);
      });
    }
    if (entry?.tool === "analyze_etsy_shop_crawl_screenshots" && entry?.result?.ok !== false && Array.isArray(entry.result?.analyses)) {
      entry.result.analyses.forEach((analysis) => {
        if (analysis?.ok !== false && analysis?.screenshotRef) analyzedRefs.add(analysis.screenshotRef);
      });
    }
  });
  return Array.from(capturedRefs).filter((ref) => !analyzedRefs.has(ref));
}

function normalizeEtsyCompetitorUrl(url = "") {
  try {
    const parsed = new URL(String(url || ""));
    if (!/etsy\.com$/i.test(parsed.hostname) && !/\.etsy\.com$/i.test(parsed.hostname)) return "";
    const match = parsed.pathname.match(/\/(?:shop|listing)\/[^/?#]+/i);
    return match ? `${parsed.hostname.toLowerCase()}${match[0].replace(/\/$/, "")}` : "";
  } catch (_) {
    return "";
  }
}

function getOpenedEtsyCompetitorUrls(toolHistory = [], currentUrl = "") {
  const current = normalizeEtsyCompetitorUrl(currentUrl);
  const urls = new Set();
  toolHistory.forEach((entry) => {
    const candidateUrls = [];
    if (["open_new_tab", "navigate_to"].includes(entry?.tool)) {
      candidateUrls.push(
        entry.arguments?.url,
        entry.result?.url,
        entry.result?.finalUrl,
        entry.result?.pageData?.url,
      );
    }
    if (entry?.tool === "collect_etsy_shop_pages") {
      candidateUrls.push(entry.arguments?.url, entry.result?.sourceUrl);
      if (Array.isArray(entry.result?.pages)) {
        entry.result.pages.forEach((page) => candidateUrls.push(page?.url));
      }
    }
    if (entry?.tool === "collect_etsy_competitor_shops") {
      if (Array.isArray(entry.arguments?.urls)) candidateUrls.push(...entry.arguments.urls);
      if (Array.isArray(entry.arguments?.competitors)) {
        entry.arguments.competitors.forEach((item) => candidateUrls.push(typeof item === "string" ? item : item?.url || item?.shopUrl || item?.shop_url));
      }
      if (Array.isArray(entry.result?.shops)) {
        entry.result.shops.forEach((shop) => candidateUrls.push(shop?.url));
      }
      if (Array.isArray(entry.result?.allPages)) {
        entry.result.allPages.forEach((page) => candidateUrls.push(page?.url || page?.competitorUrl));
      }
    }
    candidateUrls.filter(Boolean).map(normalizeEtsyCompetitorUrl).forEach((url) => {
      if (url && (!current || url !== current)) urls.add(url);
    });
  });
  return urls;
}

function getCompetitorListingDetailEvidence(toolHistory = []) {
  const urls = new Set();
  toolHistory.forEach((entry) => {
    if (["collect_etsy_competitor_shops", "collect_etsy_shop_pages"].includes(entry?.tool) && entry.result?.ok !== false) {
      const shops = entry.tool === "collect_etsy_competitor_shops"
        ? (Array.isArray(entry.result?.shops) ? entry.result.shops : [])
        : [entry.result];
      shops.forEach((shop) => {
        (Array.isArray(shop.listingDetails) ? shop.listingDetails : []).forEach((detail) => {
          if (detail?.ok && detail?.screenshotRef && /etsy\.com\/listing\//i.test(String(detail.listingUrl || ""))) {
            urls.add(String(detail.listingUrl).split("?")[0]);
          }
        });
      });
    }
    if (entry?.tool === "open_new_tab" && entry.result?.ok !== false && entry.result?.screenshotRef && /etsy\.com\/listing\//i.test(String(entry.result?.finalUrl || entry.result?.url || entry.result?.pageData?.url || entry.arguments?.url || ""))) {
      urls.add(String(entry.result.finalUrl || entry.result.url || entry.result.pageData?.url || entry.arguments.url).split("?")[0]);
    }
  });
  return urls;
}

function countCompetitorVisualLedgerEntries(ledger = []) {
  const refs = new Set();
  ledger.forEach((entry) => {
    if (String(entry?.source_type || "").toLowerCase() !== "screenshot_visual") return;
    const text = [
      entry?.source_ref,
      entry?.observed_value,
      entry?.used_for,
      entry?.limitation,
    ].filter(Boolean).join(" ");
    if (!/竞品|头部|高排名|高销|对标|benchmark|competitor|top shop|best[-\s]?seller|listing|shop|店铺详情|商品详情/i.test(text)) return;
    const urlMatch = text.match(/https?:\/\/(?:www\.)?etsy\.com\/(?:shop|listing)\/[^)\s，。；,]+/i);
    refs.add(urlMatch ? normalizeEtsyCompetitorUrl(urlMatch[0]) : text.slice(0, 160));
  });
  return refs.size;
}

function hasBlockedCompetitorDepthExplanation(text = "") {
  return /竞品.*(?:阻断|验证码|登录|无法访问|空白页|未获得|页面不可读|blocked|captcha|unavailable)|(?:只能|仅).*打开.*1\s*个竞品|不足\s*2\s*个竞品/i.test(String(text || ""));
}

function hasValue(value) {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.values(value).some(hasValue);
  return String(value).trim().length > 0;
}

function validateCompetitorBenchmarks(out, toolHistory = [], pageContext = {}) {
  const errors = [];
  const benchmarks = Array.isArray(out.competitor_benchmarks) ? out.competitor_benchmarks : [];
  const fullText = `${out.overview || ""}\n${out.analysis || ""}\n${out.summary || ""}\n${JSON.stringify(out.data || [])}`;
  const hasBlocker = hasBlockedCompetitorDepthExplanation(fullText);
  const openedUrls = getOpenedEtsyCompetitorUrls(toolHistory, pageContext?.url);
  const minCompetitors = hasBlocker ? 1 : 2;

  if (benchmarks.length < minCompetitors) {
    errors.push(`店铺优化报告缺少逐店铺竞品深度分析 competitor_benchmarks。默认至少需要 ${minCompetitors} 个已打开的 Etsy 竞品店铺/商品对象；每个对象必须包含商品样本、价格分布、类目/SKU 数量估计、促销、评论评分和可见排序解读。`);
    return errors;
  }

  benchmarks.forEach((benchmark, idx) => {
    const label = `竞品深度分析第 ${idx + 1} 项`;
    const url = benchmark?.competitor_url || benchmark?.url || benchmark?.shop_url || benchmark?.listing_url;
    const normalizedUrl = normalizeEtsyCompetitorUrl(url);
    if (!benchmark?.competitor_name && !benchmark?.shop_name && !benchmark?.name) {
      errors.push(`${label} 缺少 competitor_name / shop_name。`);
    }
    if (!normalizedUrl) {
      errors.push(`${label} 缺少有效 Etsy competitor_url / shop_url / listing_url。`);
    } else if (openedUrls.size > 0 && !openedUrls.has(normalizedUrl)) {
      errors.push(`${label} 的 URL 未出现在本轮 open_new_tab/navigate_to/collect_etsy_shop_pages 已打开或分页读取的竞品页证据中，不能把未打开页面写入竞品深度分析。`);
    }
    const productSamples = benchmark?.product_samples || benchmark?.sample_products || benchmark?.visible_products;
    if (!Array.isArray(productSamples) || productSamples.length < 2) {
      errors.push(`${label} 缺少 product_samples，至少列出 2 个可见商品样本，用于核对标题、价格、类目/场景和促销信号。`);
    } else {
      productSamples.forEach((product, productIdx) => {
        if (!hasValue(product?.title || product?.name) || !hasValue(product?.price)) {
          errors.push(`${label} 的 product_samples 第 ${productIdx + 1} 项缺少商品标题或价格。`);
        }
      });
    }
    const price = benchmark?.price_distribution || benchmark?.price_range;
    if (!price || !hasValue(price.min) || !hasValue(price.max) || !hasValue(price.main_band || price.primary_band || price.median)) {
      errors.push(`${label} 缺少 price_distribution.min / max / main_band，不能只写泛泛价格带。`);
    }
    if (!hasValue(benchmark?.category_mix) && !hasValue(benchmark?.category_structure)) {
      errors.push(`${label} 缺少 category_mix / category_structure，必须说明竞品商品类别或场景结构。`);
    }
    if (!hasValue(benchmark?.sampled_products_count) || !hasValue(benchmark?.visible_sku_count_estimate)) {
      errors.push(`${label} 缺少 sampled_products_count 或 visible_sku_count_estimate，必须说明本轮可见样本量与 SKU 数量估计口径。`);
    }
    if (!hasValue(benchmark?.promotion_signals)) {
      errors.push(`${label} 缺少 promotion_signals，必须列出 sale / free shipping / bestseller / star seller / coupon 等可见促销或信任信号；若没有看到也要写 none_visible。`);
    }
    const review = benchmark?.shop_review_signal || benchmark?.review_signal || benchmark?.rating_signal;
    if (!review || !hasValue(review.rating) || !hasValue(review.review_count)) {
      errors.push(`${label} 缺少 shop_review_signal.rating / review_count，必须输出店铺或样本商品可见评分与评论门槛。`);
    }
    const order = benchmark?.listing_order_insight || benchmark?.visible_order_insight || benchmark?.product_order_insight;
    if (!order || !hasValue(order.visible_sort_order) || !hasValue(order.observed_order_basis) || !hasValue(order.interpretation_limit)) {
      errors.push(`${label} 缺少 listing_order_insight.visible_sort_order / observed_order_basis / interpretation_limit。Etsy 可见商品顺序只能用于判断店铺陈列/排序信号，不能直接推断真实上架时间、销量或完整 SKU 排序。`);
    }
    if (!hasValue(benchmark?.evidence_refs || benchmark?.evidence_ledger_refs)) {
      errors.push(`${label} 缺少 evidence_refs / evidence_ledger_refs，必须指向 etsy_search、page_dom、screenshot_visual 等证据。`);
    }
  });
  return errors;
}

function validateDiagnosticDepthMatrix(out) {
  const errors = [];
  const matrix = out.diagnostic_depth_matrix || out.depth_matrix || out.diagnosis_dimensions;
  if (!Array.isArray(matrix) || matrix.length < 6) {
    errors.push("店铺优化报告缺少 diagnostic_depth_matrix 深度诊断矩阵，至少需要覆盖定位/阶段、视觉、SEO/文本、商品矩阵、竞品对标、站外需求、信任/履约等 6 个以上维度，避免报告只停留在浅层建议。");
    return errors;
  }
  const combinedDimensions = matrix.map((item) => [
    item?.dimension,
    item?.name,
    item?.topic,
    item?.finding,
    item?.current_state,
    item?.diagnosis,
  ].filter(Boolean).join(" ")).join(" ");
  const requiredTopics = [
    [/定位|阶段|stage|position/i, "定位/阶段"],
    [/视觉|首图|画廊|visual|image|gallery/i, "视觉/首图"],
    [/SEO|标题|关键词|描述|attribute|text/i, "SEO/文本"],
    [/商品矩阵|SKU|价格|price|product mix|category/i, "商品矩阵/价格"],
    [/竞品|对标|competitor|benchmark/i, "竞品对标"],
    [/Google|趋势|站外|需求|trend|search/i, "站外需求/趋势"],
    [/信任|履约|物流|评价|policy|shipping|review|trust/i, "信任/履约"],
  ];
  requiredTopics.forEach(([regex, label]) => {
    if (!regex.test(combinedDimensions)) {
      errors.push(`diagnostic_depth_matrix 缺少 ${label} 维度。店铺体检必须展示维度、证据、缺口和动作，而不是只输出泛化建议。`);
    }
  });
  matrix.forEach((item, index) => {
    const prefix = `diagnostic_depth_matrix 第 ${index + 1} 项`;
    if (!hasValue(item?.dimension || item?.name || item?.topic)) errors.push(`${prefix} 缺少 dimension / name / topic。`);
    if (!hasValue(item?.finding || item?.current_state || item?.diagnosis)) errors.push(`${prefix} 缺少 finding / current_state / diagnosis。`);
    if (!hasValue(item?.evidence || item?.evidence_ref || item?.source)) errors.push(`${prefix} 缺少 evidence / evidence_ref / source。`);
    if (!hasValue(item?.gap || item?.risk || item?.issue)) errors.push(`${prefix} 缺少 gap / risk / issue。`);
    if (!hasValue(item?.action || item?.recommendation || item?.next_step)) errors.push(`${prefix} 缺少 action / recommendation / next_step。`);
  });
  return errors;
}

function hasFullShopProductCrawlEvidence(toolHistory = [], pageContext = {}) {
  if (hasEvidenceSource(toolHistory, pageContext, "etsy_api")) return true;
  const currentShopUrl = normalizeEtsyCompetitorUrl(pageContext?.url || pageContext?.etsyShopProductContext?.currentPageUrl || "");
  if (toolHistory.some((entry) => {
    if (entry?.tool !== "collect_etsy_shop_pages" || entry?.result?.completedFullCrawl !== true || Number(entry?.result?.pagesCollected || 0) < 1) return false;
    if (!currentShopUrl) return true;
    const crawlUrls = [
      entry.arguments?.url,
      entry.result?.sourceUrl,
      ...(Array.isArray(entry.result?.pages) ? entry.result.pages.map((page) => page?.url) : []),
    ].filter(Boolean).map(normalizeEtsyCompetitorUrl);
    return crawlUrls.includes(currentShopUrl);
  })) {
    return true;
  }
  const urls = new Set();
  toolHistory.forEach((entry) => {
    if (!["open_new_tab", "navigate_to", "read_current_page"].includes(entry?.tool)) return;
    [
      entry.arguments?.url,
      entry.result?.url,
      entry.result?.finalUrl,
      entry.result?.pageData?.url,
      entry.result?.pageData?.etsyShopProductContext?.currentPageUrl,
    ].filter(Boolean).forEach((url) => {
      if (/etsy\.com\/shop\//i.test(String(url))) urls.add(String(url));
    });
  });
  const pageUrls = Array.from(urls).filter((url) => /[?&]page=\d+/i.test(url));
  return pageUrls.length >= 2 || Boolean(pageContext?.etsyShopProductContext?.pagination?.hasNextPage === false && pageContext?.productCards?.length > 0);
}

function validateShopProductCoverageClaims(out, toolHistory = [], pageContext = {}) {
  const errors = [];
  const text = `${out.overview || ""}\n${out.analysis || ""}\n${out.summary || ""}\n${JSON.stringify(out.data || [])}\n${JSON.stringify(out.competitor_benchmarks || [])}`;
  const claimsFullCoverage = /(?:已|已经|完成|覆盖|抓取|读取|获取|分析|统计)[^。；\n]{0,24}(?:全店(?:\s*\d+\s*(?:款|个|件|商品)|所有|全部|完整|全量)|所有商品|全部商品|完整商品|全量商品|全部\s*SKU|所有\s*SKU|完整\s*SKU|完整价格分布|full\s+(?:shop|store).*(?:products|listings|sku)|all\s+(?:products|listings|skus))/i.test(text);
  if (claimsFullCoverage && !hasFullShopProductCrawlEvidence(toolHistory, pageContext)) {
    errors.push("店铺优化报告声称已覆盖全店所有商品/全部 SKU/完整价格分布，但本轮没有 Etsy API 全量商品证据，也没有逐页分页抓取证据。请改为“当前可见样本/已打开页面样本”，或继续逐页打开分页并记录每页 URL 与商品数量。");
  }
  const benchmarks = Array.isArray(out.competitor_benchmarks) ? out.competitor_benchmarks : [];
  benchmarks.forEach((benchmark, idx) => {
    const order = benchmark?.listing_order_insight || benchmark?.visible_order_insight || benchmark?.product_order_insight;
    const basis = String(order?.observed_order_basis || "");
    if (order && !/Sort|Most Recent|Recommended|Custom|Recent|current visible|visible shop grid|排序|最近|推荐|未检测到排序控件|sort control/i.test(basis)) {
      errors.push(`竞品深度分析第 ${idx + 1} 项的 listing_order_insight.observed_order_basis 未写明 Etsy 当前排序/可见展示口径。请明确例如 Sort: Most Recent、Recommended、当前可见店铺网格或未检测到排序控件。`);
    }
  });
  return errors;
}

function hasTrendsVisualLedger(ledger = []) {
  return ledger.some((entry) => {
    if (String(entry?.source_type || "").toLowerCase() !== "screenshot_visual") return false;
    const text = [
      entry?.source_ref,
      entry?.observed_value,
      entry?.used_for,
      entry?.limitation,
    ].filter(Boolean).join(" ");
    return /Google Trends|trends\.google|趋势图|Interest over time|related queries|related topics|季节|搜索热度|需求曲线|trend chart/i.test(text);
  });
}

function hasAssumptionFallback(ledger = [], topicRegex) {
  return ledger.some((entry) => {
    const sourceType = String(entry?.source_type || "").toLowerCase();
    if (sourceType !== "assumption") return false;
    const text = [
      entry?.source_ref,
      entry?.observed_value,
      entry?.used_for,
      entry?.limitation,
    ].filter(Boolean).join(" ");
    return topicRegex.test(text) && /不可用|未绑定|未获得|未访问|阻断|无法|待验证|blocked|unavailable|not available/i.test(text);
  });
}

function validateEvidenceLedgerEntries({
  entries,
  label,
  toolHistory,
  pageContext,
  allowedTypes = ["page_dom", "screenshot_visual", "etsy_api", "etsy_search", "google_search", "google_trends", "sourcing_search", "supplier_page", "official_policy", "official_regulation", "user_input", "assumption"],
}) {
  const errors = [];
  if (!Array.isArray(entries) || entries.length === 0) {
    errors.push(`${label} 缺少 evidence_ledger 结构化证据账本。每个实体必须拆分真实页面/API/搜索/供应商页面/假设来源。`);
    return errors;
  }
  entries.forEach((entry, ledgerIdx) => {
    const prefix = `${label} 的 evidence_ledger 第 ${ledgerIdx + 1} 条`;
    const sourceType = String(entry?.source_type || "").toLowerCase();
    const sourceRef = entry?.source_ref;
    const observedValue = entry?.observed_value;
    const usedFor = entry?.used_for;
    const limitation = entry?.limitation;
    if (!allowedTypes.includes(sourceType)) {
      errors.push(`${prefix} 的 source_type 无效，必须是 ${allowedTypes.join(" / ")}。`);
    }
    if (!sourceRef || !observedValue || !usedFor || !entry?.confidence || !limitation) {
      errors.push(`${prefix} 不完整，必须包含 source_type、source_ref、observed_value、used_for、confidence、limitation。`);
    }
    if (sourceType && sourceType !== "assumption" && sourceType !== "user_input" && !hasEvidenceSource(toolHistory, pageContext, sourceType)) {
      errors.push(`${prefix} 声称来源为 ${sourceType}，但本轮没有对应的真实页面/API/搜索/供应商工具证据。请调用对应工具，或改为 assumption 并明确待验证。`);
    }
  });
  return errors;
}

function domesticVisualRouteActive(skillId, pageContext, toolHistory) {
  if (!isSourcingSkill(skillId)) return false;
  return hasImageSearchAttempt(toolHistory) || hasPreparedCleanImageAttempt(toolHistory);
}

const REPORT_JARGON_REPLACEMENTS = [
  [/read_current_page/gi, "页面信息读取"],
  [/open_new_tab/gi, "打开候选详情页取证"],
  [/close_tab/gi, "关闭已完成取证的页面"],
  [/click_by_text|click_by_selector/gi, "页面交互"],
  [/input_text_and_search/gi, "站内搜索"],
  [/agentic_web_search/gi, "后台资料检索"],
  [/\bDOM\b/g, "页面文本"],
  [/xpath/gi, "页面定位线索"],
  [/GBK\s*编码|UTF-8/gi, "页面编码"],
  [/自愈程序|爬虫/gi, "自动化取证流程"],
  [/人机拦截|验证码/gi, "平台访问限制"],
];

const REPORT_JARGON_PROTECTED_KEYS = new Set([
  "source_type",
  "source_ref",
  "product_link",
  "link",
  "url",
  "candidate_image_url",
  "source_candidate_image",
  "image",
  "imageUrl",
  "image_url",
]);

function sanitizeBusinessReportText(text = "") {
  if (typeof text !== "string") return text;
  return REPORT_JARGON_REPLACEMENTS.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), text);
}

function sanitizeReportObjectForDelivery(value, key = "") {
  if (typeof value === "string") {
    return REPORT_JARGON_PROTECTED_KEYS.has(key) ? value : sanitizeBusinessReportText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeReportObjectForDelivery(item, key));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        sanitizeReportObjectForDelivery(childValue, childKey),
      ])
    );
  }
  return value;
}

export function sanitizeFinalReportForDelivery(parsed) {
  if (!parsed || parsed.type !== "final" || !parsed.output) {
    return { parsed, changed: false };
  }
  const sanitized = {
    ...parsed,
    output: sanitizeReportObjectForDelivery(parsed.output),
  };
  return {
    parsed: sanitized,
    changed: JSON.stringify(sanitized.output) !== JSON.stringify(parsed.output),
  };
}

const ETSY_API_ASSUMPTION_RE = /API|Seller API|etsy_api|Sessions?|session|流量|会话|访问量|订单|交易|扣费|履约成本|第三方海外仓|Etsy 自发货|conversion|traffic|orders?|fulfillment/i;

function cloneReport(parsed) {
  if (typeof globalThis.structuredClone === "function") return globalThis.structuredClone(parsed);
  return JSON.parse(JSON.stringify(parsed));
}

function ensureArrayField(object, key) {
  if (!object || typeof object !== "object") return [];
  if (!Array.isArray(object[key])) object[key] = [];
  return object[key];
}

function buildAssumptionLedgerEntry({ sourceRef, observedValue, usedFor, limitation }) {
  return {
    source_type: "assumption",
    source_ref: sourceRef,
    observed_value: observedValue,
    used_for: usedFor,
    confidence: "low",
    limitation,
  };
}

function buildPageDomLedgerEntry({ sourceRef, observedValue }) {
  return {
    source_type: "page_dom",
    source_ref: sourceRef || "当前 Etsy 页面",
    observed_value: observedValue || "已读取当前 Etsy 页面文本、店铺定位、标题、商品卡片或类目上下文。",
    used_for: "支撑店铺定位、类目属性、商品结构、标题/描述和整改方向判断。",
    confidence: "high",
    limitation: "页面文本仅代表本轮可读取的公开页面内容，不能替代 Etsy 后台 API、订单或完整竞品私有数据。",
  };
}

function looksLikeReportOutput(value = {}) {
  const narrativeFieldCount = ["overview", "analysis", "summary"].filter((key) =>
    typeof value?.[key] === "string" && value[key].trim().length > 0
  ).length;
  return Boolean(
    value &&
    typeof value === "object" &&
    (
      (Array.isArray(value.data) && narrativeFieldCount >= 1) ||
      narrativeFieldCount >= 2
    )
  );
}

export function normalizeFinalReportShapeForDelivery(parsed) {
  if (!parsed || typeof parsed !== "object") {
    return { parsed, changed: false, reason: "" };
  }
  if (parsed.type === "final" && parsed.output && typeof parsed.output === "object") {
    return { parsed, changed: false, reason: "" };
  }
  if (parsed.output && typeof parsed.output === "object" && looksLikeReportOutput(parsed.output)) {
    return {
      parsed: { ...parsed, type: "final", output: parsed.output },
      changed: parsed.type !== "final",
      reason: "已将非标准 final 类型包装为标准 final 报告结构",
    };
  }
  if (parsed.type === "final" && looksLikeReportOutput(parsed)) {
    const { type: _type, ...output } = parsed;
    return {
      parsed: { type: "final", output },
      changed: true,
      reason: "已将裸报告字段包装到 output 中",
    };
  }
  if (!parsed.type && looksLikeReportOutput(parsed)) {
    return {
      parsed: { type: "final", output: parsed },
      changed: true,
      reason: "已将裸报告 JSON 包装为标准 final 报告结构",
    };
  }
  return { parsed, changed: false, reason: "" };
}

export function autoRepairFinalReportForDelivery(parsed, {
  skillId = "",
  toolHistory = [],
  pageContext = {},
} = {}) {
  if (!parsed || parsed.type !== "final" || !parsed.output || !Array.isArray(parsed.output.data)) {
    return { parsed, changed: false, reasons: [] };
  }

  const repaired = cloneReport(parsed);
  const reasons = [];
  const hasEtsyApiEvidence = hasEvidenceSource(toolHistory, pageContext, "etsy_api");
  const pageDomEvidence = getBestPageDomEvidence(toolHistory, pageContext);
  const shouldAutoAttachPageDom = isShopOptimizerOnly(skillId) && pageDomEvidence;

  repaired.output.data.forEach((item, idx) => {
    if (!item || typeof item !== "object") return;
    const ledger = ensureArrayField(item, "evidence_ledger");
    let itemChanged = false;

    if (shouldAutoAttachPageDom && !hasLedgerType(ledger, "page_dom")) {
      ledger.unshift(buildPageDomLedgerEntry(pageDomEvidence));
      itemChanged = true;
    }

    ledger.forEach((entry) => {
      if (!entry || typeof entry !== "object") return;
      const sourceType = String(entry.source_type || "").toLowerCase();
      if (sourceType !== "etsy_api" || hasEtsyApiEvidence) return;
      entry.source_type = "assumption";
      entry.confidence = entry.confidence || "low";
      entry.limitation = entry.limitation
        ? `${entry.limitation}；本轮未取得 Etsy 个人访问 API 的真实店铺流量/订单/履约数据，因此该 API 相关结论仅作为待验证假设。`
        : "本轮未取得 Etsy 个人访问 API 的真实店铺流量/订单/履约数据，因此该 API 相关结论仅作为待验证假设。";
      itemChanged = true;
    });

    const itemText = JSON.stringify(item);
    if (isEtsyBusinessSkill(skillId) && ETSY_API_ASSUMPTION_RE.test(itemText) && !hasEtsyApiEvidence && !hasAssumptionFallback(ledger, ETSY_API_ASSUMPTION_RE)) {
      ledger.push(buildAssumptionLedgerEntry({
        sourceRef: "Etsy personal API access not available in this run",
        observedValue: "本轮未取得 Etsy 个人访问 API 的真实 Sessions、订单、转化或履约成本数据。",
        usedFor: "将流量、订单、转化、履约或海外仓相关判断降级为待验证假设，避免把模型推断写成已验证事实。",
        limitation: "需要店主授权并同步 Etsy API 后，才能用真实 API 数据复核该项建议；当前不得作为已验证运营数据。",
      }));
      itemChanged = true;
    }

    if (itemChanged) {
      reasons.push(`第 ${idx + 1} 项已补齐页面文本证据或降级 API/订单/履约类假设`);
    }
  });

  return {
    parsed: repaired,
    changed: reasons.length > 0 || JSON.stringify(repaired.output.data) !== JSON.stringify(parsed.output.data),
    reasons,
  };
}

function validateComplianceReport(out, toolHistory = [], pageContext = {}) {
  const errors = [];
  const allText = `${out.overview || ""}\n${out.analysis || ""}\n${out.summary || ""}\n${JSON.stringify(out.data || [])}`;
  const validLevels = new Set(["low", "medium", "high", "blocked"]);
  const validDecisions = new Set(["proceed", "proceed_after_evidence", "blocked"]);

  if (!Array.isArray(out.data) || out.data.length === 0) {
    errors.push("合规审查报告至少需要一个风险项，不能返回空 data。");
    return errors;
  }

  out.data.forEach((item, idx) => {
    const label = `合规风险项第 ${idx + 1} 项`;
    const level = String(item?.risk_level || "").toLowerCase();
    const decision = String(item?.publish_decision || "").toLowerCase();
    const category = String(item?.category || "").trim();
    const ledger = Array.isArray(item?.evidence_ledger) ? item.evidence_ledger : [];
    const itemText = JSON.stringify(item);

    if (!validLevels.has(level)) errors.push(`${label} 的 risk_level 必须是 low / medium / high / blocked。`);
    if (!category) errors.push(`${label} 缺少 category，必须明确风险类别。`);
    if (!validDecisions.has(decision)) errors.push(`${label} 的 publish_decision 必须是 proceed / proceed_after_evidence / blocked。`);
    if (!item.finding || !item.first_action) errors.push(`${label} 必须包含具体 finding 和 first_action。`);
    if (!Array.isArray(item.required_evidence)) errors.push(`${label} 缺少 required_evidence 数组。`);
    if (ledger.length === 0) errors.push(`${label} 缺少 evidence_ledger，合规结论必须可追溯。`);

    errors.push(...validateEvidenceLedgerEntries({
      entries: ledger,
      label,
      toolHistory,
      pageContext,
      allowedTypes: ["page_dom", "screenshot_visual", "etsy_api", "official_policy", "official_regulation", "user_input", "assumption"],
    }));

    if (["high", "blocked"].includes(level) && (!item.required_evidence?.length || !item.first_action)) {
      errors.push(`${label} 为 ${level} 风险时必须列出 required_evidence 和 first_action。`);
    }
    if (level === "blocked" && decision !== "blocked") {
      errors.push(`${label} 已判定 blocked，但 publish_decision 不是 blocked；必须阻断发布、Listing 生成和采购推荐。`);
    }
    if (level === "high" && decision === "proceed") {
      errors.push(`${label} 为 high 风险时不能直接 proceed。`);
    }
    if (/已合规|完全合规|无风险|符合\s*(?:FDA|CE|CPC|FCC|RoHS|REACH)/i.test(String(item.finding || "")) && !ledger.some((entry) => ["official_policy", "official_regulation", "page_dom", "screenshot_visual", "user_input"].includes(String(entry?.source_type || "").toLowerCase()))) {
      errors.push(`${label} 使用确定性合规表述，但没有商品证据或官方来源，必须降级为待补证据。`);
    }
    if (/\b(?:CE|CPC|FDA|FCC|RoHS|REACH)\b/i.test(itemText) && !hasAnyLedgerType(ledger, ["official_policy", "official_regulation"]) && !hasAssumptionFallback(ledger, /CE|CPC|FDA|FCC|RoHS|REACH/i)) {
      errors.push(`${label} 引用了 CE/CPC/FDA/FCC/RoHS/REACH，但没有官方来源证据或明确 assumption 降级。`);
    }
    if (/手拿包|晚宴包|婚礼配饰|clutch|wedding accessory|purse|bag/i.test(itemText) && /\b(?:CE|CPC|FDA)\b/i.test(itemText) && !/儿童|电子|电池|食品接触|待确认|通常不适用|非核心/i.test(itemText)) {
      errors.push(`${label} 把普通婚礼配饰与 CE/CPC/FDA 直接绑定，缺少适用场景证据。`);
    }
    if (/侵权|仿牌|商标|版权|角色|球队|影视|设计师|brand|trademark|copyright|counterfeit/i.test(itemText) && /style|inspired|风格|灵感/i.test(itemText) && level !== "high" && level !== "blocked") {
      errors.push(`${label} 存在 IP/仿牌线索，却用 style/inspired 弱化风险；无法证明授权时必须至少判定 high。`);
    }
  });

  if (/\b(?:CE|CPC|FDA|FCC|RoHS|REACH)\b/i.test(allText) && !hasEvidenceSource(toolHistory, pageContext, "official_policy") && !hasEvidenceSource(toolHistory, pageContext, "official_regulation") && !/待补证据|待验证|assumption|未取得|无法确认/i.test(allText)) {
    errors.push("报告引用法规或认证，但没有官方政策/法规来源，也没有明确降级为待验证。不能把模型常识交付为合规结论。");
  }
  return errors;
}

function validateOperationsReport(out, toolHistory = [], pageContext = {}) {
  const errors = [];
  const items = Array.isArray(out.data) ? out.data : [];
  if (items.length === 0) return ["运营追踪报告不能返回空 data，至少需要一个阶段或行动复盘项。"];
  items.forEach((item, idx) => {
    const label = `运营追踪第 ${idx + 1} 项`;
    const text = JSON.stringify(item);
    const baseline = item?.baseline_window || item?.baselineWindow;
    const comparison = item?.comparison_window || item?.comparisonWindow;
    const observation = item?.observation_window || item?.observationWindow;
    if (!baseline || !comparison || !observation) errors.push(`${label} 必须包含 baseline_window、comparison_window 和 observation_window，且写明起止日期、时区和完整性。`);
    if (!item?.baseline_metrics || !item?.comparison_metrics) errors.push(`${label} 缺少 baseline_metrics 或 comparison_metrics，不能证明优化前后变化。`);
    if (!Array.isArray(item?.confounders) && !item?.confounders) errors.push(`${label} 缺少 confounders，必须声明价格、广告、库存、促销、季节性、评价和履约等干扰因素。`);
    if (!item?.attribution_confidence) errors.push(`${label} 缺少 attribution_confidence，不能把相关性写成因果性。`);
    if (!item?.next_observation_window || !item?.success_threshold) errors.push(`${label} 缺少 next_observation_window 或 success_threshold，下一轮必须有观察时间和成功标准。`);
    if (/提升|下降|增长|改善|成功|increase|decrease|improv|success/i.test(text) && !hasEvidenceSource(toolHistory, pageContext, "etsy_api") && !hasAssumptionFallback(item?.evidence_ledger || [], /API|基线|数据|指标|待验证/i)) {
      errors.push(`${label} 输出了指标变化或成功判断，但没有 Etsy 个人访问 API 证据或明确待验证假设。`);
    }
    if (/Sessions?|session_view|hits_view|页面浏览|曝光|点击率|加购率|conv_tocart|traffic/i.test(text) && !hasSupportedEtsyAnalytics(toolHistory) && !hasAssumptionFallback(item?.evidence_ledger || [], /个人 API 不支持|未提供|待验证|不可用|无法取得|unsupported/i)) {
      errors.push(`${label} 使用了 Sessions、曝光、点击率或加购率等指标，但当前 Etsy 个人卖家 API 不提供这些 analytics；必须改为待验证假设或使用公开页面证据，不能填 0 冒充真实数据。`);
    }
  });
  return errors;
}

export function validateReport(parsed, userInstruction, skillId, toolHistory = [], pageContext = {}) {
  const errors = [];
  if (!parsed || parsed.type !== "final" || !parsed.output) {
    errors.push("未输出符合格式的 final 报告 JSON 结构");
    return errors;
  }
  const out = parsed.output;
  if (!out.overview || !out.analysis || !out.summary || !Array.isArray(out.data)) {
    errors.push("final 报告缺少必须的属性（overview, analysis, summary 或 data 数组）");
    return errors;
  }

  if (isComplianceSkill(skillId)) {
    errors.push(...validateComplianceReport(out, toolHistory, pageContext));
  }
  if (isOperationsSkill(skillId)) {
    errors.push(...validateOperationsReport(out, toolHistory, pageContext));
  }

  // 1. Check for technical jargon
  const jargonRegex = /read_current_page|open_new_tab|click_by_text|click_by_selector|input_text_and_search|agentic_web_search|DOM|xpath|GBK 编码|UTF-8|自愈程序|爬虫|人机拦截|验证码/i;
  const checkJargon = (str) => typeof str === "string" && jargonRegex.test(str);
  if (checkJargon(out.overview) || checkJargon(out.analysis) || checkJargon(out.summary)) {
    errors.push("报告正文中包含内部技术黑话或函数名（如 DOM, read_current_page, xpath 等），请过滤并替换为通俗易懂的商业/供应链分析术语！");
  }

  if (isShopOptimizerOnly(skillId)) {
    const combinedReportText = `${out.overview || ""}\n${out.analysis || ""}\n${out.summary || ""}`;
    const fullReportText = `${combinedReportText}\n${JSON.stringify(out.data || [])}`;
    if (/货源\s*#|推荐对齐货源|采购直达|1688\s*采购直达链接|detail\.1688\.com|s\.1688\.com/i.test(combinedReportText)) {
      errors.push("店铺优化报告不得输出货源编号、采购直达链接或 1688 推荐清单。请改为店铺健康评级、ABC 分级优化候选方案与执行任务。");
    }
    if (/选品机会书|选品机会深度分析|扩品机会书|商品机会书/i.test(combinedReportText)) {
      errors.push("店铺优化报告标题和概述不得写成“选品机会书/选品机会分析”。当前任务必须是 Etsy 店铺优化诊断、店铺健康体检或 ABC 分级整改方案。");
    }
    if (/外部市场数据因工具限制.*待验证假设|任务广度.*跨境物流合规预判|已完成.*跨境物流合规预判/i.test(combinedReportText)) {
      errors.push("店铺优化报告不得把关键 Etsy/Google 取证缺失包装成完整诊断。若工具或页面受限，必须继续取证或明确输出阻断说明，不能声称已完成外部市场/物流诊断。");
    }

    const hasClassifiedPlan = out.data.some((item) => {
      const text = [
        item?.plan_id,
        item?.scheme_id,
        item?.diagnosis_level,
        item?.title,
        item?.name,
        item?.direction,
      ].filter(Boolean).join(" ");
      return /\b[ABC]-?\d*\b|A级|B级|C级|方案|优化|整改|诊断/i.test(text);
    });
    if (!hasClassifiedPlan) {
      errors.push("店铺优化报告的 data 数组必须包含 A/B/C 分级优化候选方案或诊断任务，而不是商品/货源清单。");
    }

    out.data.forEach((item, idx) => {
      const title = item.title || item.name || item.plan_id || `方案 #${idx + 1}`;
      const link = item.product_link || item.link || "";
      const ledger = item.financial_ledger || {};
      if (/1688\.com/i.test(String(link))) {
        errors.push(`店铺优化方案第 ${idx + 1} 项 (${title}) 包含 1688 采购链接。除非用户明确要求寻源，否则不能在店铺优化第一步生成采购链接。`);
      }
      if (ledger.sourcing_cost || ledger.sourcing_cost_cny || ledger.sourcing_cost_rub) {
        errors.push(`店铺优化方案第 ${idx + 1} 项 (${title}) 包含采购成本字段。没有真实寻源时只能写成本压力或待验证假设，不能伪造供应商账本。`);
      }
      const evidence = item.evidence || item.diagnosis_basis || item.selection_rationale || item.trend_evidence || "";
      if (!evidence || String(evidence).trim().length < 20) {
        errors.push(`店铺优化方案第 ${idx + 1} 项 (${title}) 缺少具体证据字段（evidence / diagnosis_basis / selection_rationale），必须说明来自页面、截图、Etsy API 或待验证假设。`);
      }

      const ledgerEntries = Array.isArray(item.evidence_ledger) ? item.evidence_ledger : [];
      if (ledgerEntries.length === 0) {
        errors.push(`店铺优化方案第 ${idx + 1} 项 (${title}) 缺少 evidence_ledger 结构化证据账本。每个方案必须拆分 page_dom / screenshot_visual / etsy_api / etsy_search / google_search / google_trends / assumption 等来源。`);
      }

      ledgerEntries.forEach((entry, ledgerIdx) => {
        const prefix = `店铺优化方案第 ${idx + 1} 项 (${title}) 的 evidence_ledger 第 ${ledgerIdx + 1} 条`;
        const sourceType = String(entry?.source_type || "").toLowerCase();
        const sourceRef = entry?.source_ref;
        const observedValue = entry?.observed_value;
        const usedFor = entry?.used_for;
        const limitation = entry?.limitation;
        const allowedTypes = ["page_dom", "screenshot_visual", "etsy_api", "etsy_search", "google_search", "google_trends", "official_policy", "official_regulation", "assumption"];
        if (!allowedTypes.includes(sourceType)) {
          errors.push(`${prefix} 的 source_type 无效，必须是 ${allowedTypes.join(" / ")}。`);
        }
        if (!sourceRef || !observedValue || !usedFor || !entry?.confidence || !limitation) {
          errors.push(`${prefix} 不完整，必须包含 source_type、source_ref、observed_value、used_for、confidence、limitation。`);
        }
        if (sourceType && sourceType !== "assumption" && !hasEvidenceSource(toolHistory, pageContext, sourceType)) {
          errors.push(`${prefix} 声称来源为 ${sourceType}，但本轮没有对应的真实页面/API/搜索工具证据。请调用对应工具，或把该结论改为 assumption 并明确待验证。`);
        }
      });

      const itemText = JSON.stringify(item);
      if (!item.stage_fit) {
        errors.push(`店铺优化方案第 ${idx + 1} 项 (${title}) 缺少 stage_fit，必须说明该方案为什么适合当前店铺阶段（新店冷启动/成长店/成熟店/问题修复）。`);
      }
      if (!item.buyer_scenario) {
        errors.push(`店铺优化方案第 ${idx + 1} 项 (${title}) 缺少 buyer_scenario，必须说明对应的欧美买家场景或购买人群。`);
      }
      if (/API|Seller API|etsy_api|Sessions|session|订单|扣费|交易|履约成本|第三方海外仓|Etsy 自发货/i.test(itemText) && !hasLedgerType(ledgerEntries, "etsy_api") && !hasAssumptionFallback(ledgerEntries, /API|Seller|流量|订单|履约|第三方海外仓|Etsy 自发货/i)) {
        errors.push(`店铺优化方案第 ${idx + 1} 项 (${title}) 使用了 API/流量/订单/履约类结论，但 evidence_ledger 没有 etsy_api 证据或 assumption 降级说明。`);
      }
      if (/Google|google/i.test(itemText) && !hasLedgerType(ledgerEntries, "google_search") && !hasAssumptionFallback(ledgerEntries, /Google/i)) {
        errors.push(`店铺优化方案第 ${idx + 1} 项 (${title}) 使用了 Google/站外需求结论，但 evidence_ledger 没有 google_search 证据或 assumption 降级说明。`);
      }
      if (/站外|搜索指数|外部流量|季节性/i.test(itemText) && !hasAnyLedgerType(ledgerEntries, ["google_search", "google_trends"]) && !hasAssumptionFallback(ledgerEntries, /Google|谷歌|站外|搜索指数|外部流量|季节|趋势/i)) {
        errors.push(`店铺优化方案第 ${idx + 1} 项 (${title}) 使用了站外需求/季节性结论，但 evidence_ledger 没有 google_search / google_trends 证据或 assumption 降级说明。`);
      }
      if (/Google|Google Trends|谷歌趋势|搜索趋势|年度趋势|季度趋势|YoY|QoQ|季节性增长|需求趋势/i.test(itemText) && !hasAnyLedgerType(ledgerEntries, ["google_search", "google_trends"]) && !hasAssumptionFallback(ledgerEntries, /Google|谷歌|趋势|YoY|QoQ|季节/i)) {
        errors.push(`店铺优化方案第 ${idx + 1} 项 (${title}) 使用了 Google/趋势/季节性增长结论，但 evidence_ledger 没有 google_search / google_trends 证据或 assumption 降级说明。`);
      }
      if (/Etsy 站内|etsy 站内|热卖榜|第一页|竞品均价|评价门槛|广告占位/i.test(itemText) && !hasLedgerType(ledgerEntries, "etsy_search") && !hasAssumptionFallback(ledgerEntries, /Etsy|站内|热卖榜|第一页|竞品|评价门槛|广告占位/i)) {
        errors.push(`店铺优化方案第 ${idx + 1} 项 (${title}) 使用了 Etsy 站内/热卖榜/竞品搜索结论，但 evidence_ledger 没有 etsy_search 证据或 assumption 降级说明。`);
      }
    });

    const allLedgerEntries = out.data.flatMap((item) => Array.isArray(item.evidence_ledger) ? item.evidence_ledger : []);
    if (!hasLedgerType(allLedgerEntries, "page_dom")) {
      errors.push("店铺优化报告缺少当前店铺/商品页真实文本证据。不能只凭截图诊断，必须先读取 Etsy 页面文本、店铺定位、类目属性、标题/描述/attributes 后再分析。");
    }
    if (!hasLedgerType(allLedgerEntries, "screenshot_visual")) {
      errors.push("店铺优化报告缺少视觉截图证据。必须结合当前店铺截图或竞品截图判断调性、格调、首图卖点、视觉统一性，不能只看文本/API。");
    }
    const openedCompetitorCount = getOpenedEtsyCompetitorUrls(toolHistory, pageContext?.url).size;
    const hasCompetitorBlocker = hasBlockedCompetitorDepthExplanation(fullReportText);
    if (openedCompetitorCount < (hasCompetitorBlocker ? 1 : 2)) {
      errors.push("店铺优化报告缺少足够的竞品店铺/商品详情页打开取证。不能只看 Etsy 搜索结果页；默认必须打开至少 2 个同类高排名店铺或商品详情页，读取页面并结合截图分析其首图、调性、标题、评价门槛、价格分布、SKU/类目结构和履约承诺。若不足 2 个，必须说明页面阻断或可访问竞品不足的原因。");
    }
    const competitorVisualCount = countCompetitorVisualLedgerEntries(allLedgerEntries);
    if (!hasCompetitorVisualLedger(allLedgerEntries) || competitorVisualCount < (hasCompetitorBlocker ? 1 : 2)) {
      errors.push("店铺优化报告缺少足够的竞品店铺/商品详情页截图视觉证据。当前店铺截图不能替代竞品截图；默认必须在 evidence_ledger 的 screenshot_visual 中写明至少 2 个竞品店铺/商品详情截图观察到的首图卖点、视觉调性、包装/场景图或画廊结构。");
    }
    errors.push(...validateEvidenceCoverageConsistency(parsed.output, toolHistory));
    const unanalyzedScreenshotRefs = getUnanalyzedEtsyShopCrawlScreenshotRefs(toolHistory);
    if (hasEtsyShopCrawlScreenshotEvidence(toolHistory) && unanalyzedScreenshotRefs.length > 0) {
      errors.push(`本轮已通过 collect_etsy_shop_pages 捕获竞品店铺分页截图，但仍有 ${unanalyzedScreenshotRefs.length} 张截图尚未调用 analyze_etsy_shop_crawl_screenshots 做独立截图解读。请先分析已缓存截图，再把视觉调性、首图/网格陈列、促销/信任信号和局限写入 evidence_ledger。`);
    }
    errors.push(...validateCompetitorBenchmarks(out, toolHistory, pageContext));
    if (!hasLedgerType(allLedgerEntries, "etsy_search")) {
      errors.push("店铺优化报告缺少必须完成的 Etsy 站内搜索/热卖榜/高排名竞品店铺对标证据。该项不能降级为 assumption，请调用 search_in_browser(engine=etsy) 并学习同类高排名店铺/商品页面。");
    }
    if (toolHistory.some((entry) => entry?.tool === "collect_etsy_competitor_shops" || (entry?.tool === "collect_etsy_shop_pages" && entry.arguments?.deepDetail === true))) {
      const detailEvidenceCount = getCompetitorListingDetailEvidence(toolHistory).size;
      if (detailEvidenceCount < 2) {
        errors.push("竞品店铺分页采集完成后，必须继续完成至少 2 个 Etsy 商品详情页的 DOM + 截图深度取证。当前只有店铺首页/商品卡片证据，不能称为竞品商品详情深度分析。");
      }
    }
    if (!hasAnyLedgerType(allLedgerEntries, ["google_search", "google_trends"])) {
      errors.push("店铺优化报告缺少必须完成的 Google Trends US / Google Search 站外需求证据。该项不能降级为 assumption，请调用 search_in_browser(engine=google_us 或 google_trends) 获取真实检索/趋势证据。");
    }
    const hasTrendInterpretation = /Google Trends|谷歌趋势|趋势图|搜索趋势|搜索热度|年度趋势|季度趋势|近\s*12\s*个月|YoY|QoQ|季节性|需求曲线|Interest over time|related queries|related topics/i.test(fullReportText);
    if ((hasLedgerType(allLedgerEntries, "google_trends") || hasTrendInterpretation) && !hasTrendsVisualLedger(allLedgerEntries)) {
      errors.push("店铺优化报告缺少 Google Trends 截图视觉解读证据。趋势图属于可视化数据，若使用 Google Trends 或输出趋势/季节性/热度方向，必须在 evidence_ledger 的 screenshot_visual 中写明 Trends 图表截图观察到的时间范围、需求曲线方向、季节峰值或 related queries；否则只能写“趋势图待人工确认”。");
    }
    if (!hasAnyLedgerType(allLedgerEntries, ["google_search", "google_trends"]) && hasAssumptionFallback(allLedgerEntries, /Google|谷歌|站外|趋势|季节|需求/i) && /呈现|显示|证明|同比|环比|增长|下降|热度高|趋势上升/i.test(combinedReportText)) {
      errors.push("店铺优化报告的站外趋势只有 assumption，正文不能写成已验证事实。请把趋势判断降级为待验证假设，或先调用 Google Trends / Etsy 搜索 获取真实证据。");
    }
    if (/(无法直接访问|未直接访问).*(etsy|Etsy|trends\.google|Google Trends)|行业报告摘要|Google 搜索摘要/i.test(combinedReportText)) {
      errors.push("店铺优化报告不得把 Etsy 站内/热卖榜或 Google Trends 关键证据写成“未直接访问/来自摘要”。这两项是本流程必须完成的浏览器取证任务，请实际访问后再输出 final。");
    }
    if (!/竞品店铺|头部店铺|高排名店铺|高销店铺|best[-\s]?seller|top shop|同类高排名/i.test(combinedReportText)) {
      errors.push("店铺优化报告缺少同类高排名/高销竞品店铺的反向学习结论。必须搜索并对标 2-3 个头部店铺或高排名商品，再提炼其定位、调性、首图、标题和履约承诺。");
    }
    errors.push(...validateDiagnosticDepthMatrix(out));
    errors.push(...validateShopProductCoverageClaims(out, toolHistory, pageContext));
    const hasPrematureScaleAdvice = /1\s*[-–—到至]\s*2\s*周内.*第三方海外仓|立即.*第三方海外仓|海外仓.*第一优先级|大额广告|广告放量/i.test(fullReportText);
    const isWarningAgainstPrematureScale = /不建议[^。；\n]{0,24}(?:第三方海外仓|海外仓|大额广告|广告放量)|不得[^。；\n]{0,24}(?:第三方海外仓|海外仓|大额广告|广告放量)|避免[^。；\n]{0,24}(?:第三方海外仓|海外仓|大额广告|广告放量)/i.test(fullReportText);
    if (hasPrematureScaleAdvice && !isWarningAgainstPrematureScale && !/成熟店|订单密度|库存周转|履约成本证据|etsy_api/i.test(fullReportText)) {
      errors.push("店铺优化报告把海外仓/广告放量作为过早动作，但缺少成熟店阶段、订单密度、库存和履约成本证据。新店应优先补信任资产、页面信息和小步实验。");
    }
    if (/获取首批?\s*\d+\s*[-–—到至]\s*\d+\s*个真实评价|获取\s*\d+\s*[-–—到至]\s*\d+\s*个评价|补充评价积累/i.test(fullReportText) && !/合规|真实订单|不得诱导|如实评价|post[-\s]?purchase|发货后礼貌提醒/i.test(fullReportText)) {
      errors.push("店铺优化报告不能把“获取 5-10 个评价”写成孤立目标。必须约束为 Etsy 合规的真实订单后评价提醒和信任资产建设，禁止诱导或刷评。");
    }
    if (/\b(?:CE|CPC|FDA)\b|CE\/CPC\/FDA/i.test(fullReportText) && /手拿包|晚宴包|clutch|bag|purse/i.test(fullReportText) && !/非核心认证|通常不是|儿童|电子|电池|食品接触|待确认/i.test(fullReportText)) {
      errors.push("婚礼手拿包/晚宴包店铺不应把 CE/CPC/FDA 写成主要风险。除非有儿童/电子/电池/食品接触证据，否则应聚焦 IP、商标词、材质安全、天然材质来源、易碎包装和色差预期。");
    }
    const hasLogisticsClaim = /配送|物流|发货|运输|时效|工作日|delivery|shipping|transit|fulfillment/i.test(combinedReportText);
    const hasExactTransitPromise = /\b\d+\s*[-–—到至]\s*\d+\s*(个)?\s*(工作日|日|天|business days?|days?)\b/i.test(combinedReportText);
    const hasShippingResearch = hasLedgerTypeTopic(allLedgerEntries, ["google_search"], /配送|物流|发货|运输|时效|delivery|shipping|transit|fulfillment|USPS|DHL|FedEx|UPS|postal/i);
    if (hasLogisticsClaim && !hasShippingResearch) {
      errors.push("店铺优化报告涉及配送/物流/时效判断，但缺少实时物流主题 google_search 证据。Etsy 国际物流因发货地、目的地、承运商和季节差异很大，必须先做实时搜索研究。");
    }
    if (hasExactTransitPromise && !hasShippingResearch) {
      errors.push("店铺优化报告输出了具体配送时效区间，但没有实时物流搜索证据支撑。禁止凭模型常识写 7-12 工作日等确定承诺。");
    }
  }

  if (isEtsyBusinessSkill(skillId) && !isShopOptimizerOnly(skillId)) {
    if (isReviewSkill(skillId)) {
      const reviewEvidence = getReviewEvidenceSummary(toolHistory, pageContext);
      if (!reviewEvidence.hasCollection && reviewEvidence.sampleCount < 1) {
        errors.push("评论审查必须先读取 Etsy 商品页评论或执行评论分页采集；没有真实评论证据不能输出买家集中反馈或缺陷结论。");
      }
      if (reviewEvidence.sampleCount > 0 && reviewEvidence.sampleCount < 3 && /集中|主要|普遍|多数|高频|比例|频率|dominant|common|majority|rate|frequent/i.test(JSON.stringify(out.data))) {
        errors.push(`评论审查当前只有 ${reviewEvidence.sampleCount} 条真实评论样本，不能输出“买家集中/主要反馈”或频率判断；请继续翻页，或明确降级为当前页样本。`);
      }
      if (reviewEvidence.lowStarCount > 0 && reviewEvidence.sampleCount < 3 && /差评率|低星比例|negative rate|low.?star rate/i.test(JSON.stringify(out.data))) {
        errors.push("低星评论样本不足 3 条，不能计算差评率或低星比例；必须继续采集或改为样本观察。");
      }
    }
    out.data.forEach((item, idx) => {
      const title = item.title || item.name || item.plan_id || item.phase_id || item.keyword || `实体 #${idx + 1}`;
      const ledgerEntries = Array.isArray(item.evidence_ledger) ? item.evidence_ledger : [];
      errors.push(...validateEvidenceLedgerEntries({
        entries: ledgerEntries,
        label: `Etsy 业务报告第 ${idx + 1} 项 (${title})`,
        toolHistory,
        pageContext,
      }));

      const itemText = JSON.stringify(item);
      if (/蓝海|爆品|高增长|低竞争|趋势|季节|搜索热度|YoY|QoQ/i.test(itemText) && !hasAnyLedgerType(ledgerEntries, ["etsy_search", "google_search", "google_trends"]) && !hasAssumptionFallback(ledgerEntries, /Etsy|Google|谷歌|趋势|季节|需求|竞争|搜索/i)) {
        errors.push(`Etsy 业务报告第 ${idx + 1} 项 (${title}) 使用了市场机会/趋势/竞争结论，但 evidence_ledger 没有 Etsy/Google/Google/Google Trends 证据或主题相关 assumption。`);
      }
      if (/SEO|关键词|搜索词|高频词|标题公式|Listing|листинг/i.test(itemText) && !hasAnyLedgerType(ledgerEntries, ["page_dom", "etsy_search", "google_search", "google_trends"]) && !hasAssumptionFallback(ledgerEntries, /SEO|关键词|搜索词|标题|Listing/i)) {
        errors.push(`Etsy 业务报告第 ${idx + 1} 项 (${title}) 使用了 SEO/关键词/Listing 结论，但 evidence_ledger 没有页面或搜索证据，也没有降级为待验证假设。`);
      }
      if (/评论|差评|Отзывы|отзыв|买家反馈|退货|破损|不符|Не работает/i.test(itemText) && !hasAnyLedgerType(ledgerEntries, ["page_dom", "screenshot_visual", "etsy_search"]) && !hasAssumptionFallback(ledgerEntries, /评论|差评|Отзывы|买家反馈|退货|破损|不符/i)) {
        errors.push(`Etsy 业务报告第 ${idx + 1} 项 (${title}) 使用了评论/差评/退货结论，但 evidence_ledger 没有页面/截图/Etsy 搜索证据，也没有降级为待验证假设。`);
      }
      if (/1688|淘宝|供应商|采购|拿样|货源/i.test(itemText) && !hasAnyLedgerType(ledgerEntries, ["sourcing_search", "supplier_page", "user_input"]) && !hasAssumptionFallback(ledgerEntries, /1688|淘宝|供应商|采购|拿样|货源/i)) {
        errors.push(`Etsy 业务报告第 ${idx + 1} 项 (${title}) 使用了供应商/采购/拿样结论，但 evidence_ledger 没有 sourcing_search / supplier_page / user_input 证据，也没有降级为待验证假设。`);
      }
    });
  }

  // 2. Check product quantity if specified in instruction
  const numMatch = (userInstruction || "").match(/(\d+)款/);
  if (numMatch) {
    const expectedNum = parseInt(numMatch[1]);
    if (out.data.length < expectedNum) {
      errors.push(`用户要求至少筛选 ${expectedNum} 款商品，但你当前的 data 列表中只有 ${out.data.length} 款，请调用翻页、滚动或抓取工具补充完整，达到 ${expectedNum} 款！`);
    }
  }

  // 3. Sourcing-specific details check (1688 / Taobao links, profiling, spec alignment, profit ledger)
  if (isSourcingSkill(skillId)) {
    if (out.data.length < 1) {
      errors.push("供应链寻源报告至少必须返回 1 个真实采购候选。请继续通过 1688/淘宝完成对应路径的真实检索、视觉筛选或详情页穿透补足；只有找到 1 个合格货源也可以交付，但不能输出空 data。");
    }
    const combinedSourcingText = `${out.overview || ""}\n${out.analysis || ""}\n${out.summary || ""}\n${JSON.stringify(out.data || [])}`;
    const hasSupplierShortageExplanation = /不足\s*2|少于\s*2|仅\s*1\s*个|只有\s*1\s*个|无法形成.*比价|不足以形成.*比价|验证码|登录墙|平台阻断|图片搜索受限|未获得真实|无合格货源|继续人工寻源|暂不建议.*采购|不建议.*备货/i.test(combinedSourcingText);
    if (out.data.length > 0 && out.data.length < 2 && !hasSupplierShortageExplanation) {
      errors.push("供应链寻源报告默认必须返回至少 2 个可比供应商候选，以便比较价格、MOQ、材质、供货能力和跨境毛利。当前只有 1 个候选且未说明平台阻断/严格筛选不足 2 个的原因。请继续基于结果页打开第二个详情页审计；若确实无法获得第二个合格供应商，必须在 summary 和 audit_comment 中明确“不足以形成供应商比价，本轮不建议直接采购/批量备货，需要继续人工寻源或拿样验证”。");
    }

    const hasSuccessfulImageSearch = toolHistory.some((entry) => {
      if (!isImageSearchTool(entry.tool)) return false;
      const result = entry.result || {};
      const links = result.pageData?.productLinks || [];
      const cards = result.pageData?.productCards || [];
      return result.ok && !result.error && !result.isCaptcha && (links.length > 0 || cards.length > 0);
    });
    const hasVisualCandidateExtraction = toolHistory.some((entry) => {
      const cards = entry.result?.pageData?.productCards || entry.result?.productCards || [];
      return Array.isArray(cards) && cards.length > 0;
    });

    out.data.forEach((item, idx) => {
      const title = item.title || item.name || `商品 #${idx + 1}`;
      
      // A. Detail links check
      const link = item.product_link || item.link || "";
      if (!link) {
        errors.push(`商品列表第 ${idx + 1} 项 (${title}) 没有提供采购直达链接！`);
      } else if (link.includes("s.1688.com") || link.includes("search?") || link.includes("offer_search")) {
        errors.push(`商品列表第 ${idx + 1} 项 (${title}) 提供的链接是搜索列表页，必须替换为具体的单品详情页直达链接（格式如 detail.1688.com/offer/XXXX.html）！`);
      }

      // B. Category profiling check (target_profile)
      const profile = item.target_profile;
      if (!profile || typeof profile !== "object" || Object.keys(profile).length === 0) {
        errors.push(`商品列表第 ${idx + 1} 项 (${title}) 缺少分类特征画像属性（target_profile 属性对象）！`);
      } else {
        if (!profile.visual_descriptors || typeof profile.visual_descriptors !== "string" || profile.visual_descriptors.trim().length < 5) {
          errors.push(`商品列表第 ${idx + 1} 项 (${title}) 的 target_profile 必须包含多模态提取的外观特征描述（visual_descriptors，如松鼠打伞、材质颜色等）！`);
        }
        if (!profile.refined_query || typeof profile.refined_query !== "string" || profile.refined_query.trim().length < 2) {
          errors.push(`商品列表第 ${idx + 1} 项 (${title}) 的 target_profile 必须包含最终构建的中文复合检索词（refined_query，如松鼠打伞喂鸟器）！`);
        }
        if (!profile.routing_decision || !["标品(文本检索)", "非标品(图片检索)"].includes(profile.routing_decision)) {
          errors.push(`商品列表第 ${idx + 1} 项 (${title}) 的 target_profile 必须包含检索方式分流决策（routing_decision，取值必须为："标品(文本检索)" 或 "非标品(图片检索)"）！`);
        }
        if (profile.routing_decision === "非标品(图片检索)" && !hasSuccessfulImageSearch) {
          errors.push(`商品列表第 ${idx + 1} 项 (${title}) 标记为非标品图片检索，但本轮没有成功执行 1688/淘宝以图搜图并返回商品结果。请继续使用 image_search_1688 或 image_search_taobao 获取真实视觉候选；若平台图片检索被验证码/登录墙/无结果阻断，只能如实申报视觉寻源受阻或无合格货源，禁止改回文本关键词凑结果。`);
        }
        if (profile.routing_decision === "非标品(图片检索)" && !hasVisualCandidateExtraction) {
          errors.push(`商品列表第 ${idx + 1} 项 (${title}) 标记为非标品图片检索，但本轮未抽取到带候选主图和屏幕坐标的 productCards。请重新读取/刷新搜索结果页，先基于列表页商品卡片主图完成视觉相似度排序，再打开详情页。`);
        }
      }

      // B2. Visual list-page screening proof. This prevents keyword-only supplier picks.
      const routingDecision = profile?.routing_decision || "";
      const requiresVisualGate = routingDecision === "非标品(图片检索)" || hasVisualCandidateExtraction;
      if (requiresVisualGate) {
        const candidateImage = item.candidate_image_url || item.source_candidate_image || item.source_image || item.product_image || item.image_url || "";
        const visualScore = item.list_page_visual_score ?? item.visual_match_score ?? item.visual_score;
        const visualEvidence = [
          item.visual_match_evidence,
          item.list_page_visual_screening,
          item.audit_comment,
        ].filter(Boolean).join(" ");

        if (!candidateImage || !/^https?:\/\//i.test(String(candidateImage))) {
          errors.push(`商品列表第 ${idx + 1} 项 (${title}) 缺少列表页候选主图字段（candidate_image_url 或 source_candidate_image）。必须把 productCards 中被选中卡片的 imageSrc 写入报告，证明不是只按标题关键词选择。`);
        }
        if (!hasVisualScore(visualScore)) {
          errors.push(`商品列表第 ${idx + 1} 项 (${title}) 缺少列表页视觉相似度评分（list_page_visual_score 或 visual_match_score）。请先在搜索结果页按目标主图进行视觉排序后再推荐。`);
        }
        if (!visualEvidence || visualEvidence.trim().length < 20) {
          errors.push(`商品列表第 ${idx + 1} 项 (${title}) 缺少列表页视觉筛选证据（visual_match_evidence 或 list_page_visual_screening）。必须具体说明颜色、材质、轮廓、结构或图案为何与目标主图一致。`);
        } else if (!hasConcreteVisualTerms(visualEvidence)) {
          errors.push(`商品列表第 ${idx + 1} 项 (${title}) 的视觉证据过于文本化，未说明具体外观/材质/结构相似点。禁止只依据标题、关键词、价格或销量推荐货源。`);
        }
      }

      // C. Spec alignment check (spec_audit)
      const spec = item.spec_audit;
      if (!spec || typeof spec !== "object" || !spec.target_spec || !spec.sourced_spec || !spec.status) {
        errors.push(`商品列表第 ${idx + 1} 项 (${title}) 缺少规格审计比对参数（spec_audit 必须包含 target_spec、sourced_spec 和 status）！`);
      } else {
        const isRejected = ["一票否决淘汰", "材质缩水", "严重偏离"].includes(spec.status) || 
                           (spec.status.includes("淘汰") || spec.status.includes("缩水") || spec.status.includes("偏离"));
        if (isRejected) {
          errors.push(`商品列表第 ${idx + 1} 项 (${title}) 的规格对比状态判定为一票否决或材质/外观不符 (${spec.status})，绝对禁止列为有效的采购货源推荐方案！请通过多轮检索（以图搜图、精确词、筛选项）重新搜寻合格同款；若确属无货，请在报告中如实申报无货，严禁妥协拼凑！`);
        }
      }

      // D. Profit ledger check (financial_ledger)
      const ledger = item.financial_ledger;
      if (!ledger || typeof ledger !== "object") {
        errors.push(`商品列表第 ${idx + 1} 项 (${title}) 缺少财务账本字段（financial_ledger 属性对象）！`);
      } else {
        const cost = ledger.sourcing_cost || ledger.cost || "";
        const shipping = ledger.shipping_cost || ledger.shipping || "";
        const price = ledger.target_price || ledger.price || "";
        const margin = ledger.margin_rate || ledger.margin || "";
        if (!cost || !shipping || !price || !margin) {
          errors.push(`商品列表第 ${idx + 1} 项 (${title}) 的财务账本不完整（financial_ledger 必须包含 sourcing_cost, shipping_cost, target_price 和 margin_rate）！`);
        }
      }
    });
  }

  // 4. Evidence validation must match the current skill semantics.
  out.data.forEach((item, idx) => {
    const evidence = item.trend_evidence || item.selection_rationale || item.evidence || item.diagnosis_basis || "";
    if (!evidence || evidence.trim().length < 20) {
      const label = isShopOptimizerOnly(skillId) ? "方案" : "商品列表";
      errors.push(`${label}第 ${idx + 1} 项 (${item.title || item.name || item.plan_id || "未命名实体"}) 缺少充分证据链（trend_evidence / evidence / diagnosis_basis / selection_rationale 字段长度必须大于 20 字，并说明真实页面、截图、API、竞品或假设来源）！`);
    }
  });

  // 5. Inferred target market verification in report text
  const overviewText = out.overview || "";
  const analysisText = out.analysis || "";
  const combinedText = overviewText + analysisText;
  if (!combinedText.includes("市场") && !combinedText.includes("客群") && !combinedText.includes("定位")) {
    errors.push("报告概述 (overview) 或分析 (analysis) 中未体现自主判断的目标销售市场与目标客群定位（例如：‘中国大陆/国内电商’或‘欧美/欧美礼品市场市场’等），请予以明确陈述！");
  }

  return errors;
}

export function clearSessionCache(tabId) {
  const sessionKey = `${tabId}`;
  if (globalSessionCache[sessionKey]) {
    delete globalSessionCache[sessionKey];
  }
  clearAgentCheckpoint(sessionKey).catch((err) => {
    console.warn("Failed to clear persisted agent checkpoint:", err.message);
  });
}

function buildPromptContext(pageContext = {}) {
  const ctx = { ...pageContext };
  if (Array.isArray(ctx.productCards)) {
    ctx.productCardsCount = ctx.productCards.length;
    ctx.productCards = ctx.productCards.slice(0, MAX_LLM_PRODUCT_CARDS).map(compactProductCardForLLM);
  }
  if (Array.isArray(ctx.productLinks)) {
    ctx.productLinksCount = ctx.productLinks.length;
    ctx.productLinks = ctx.productLinks.slice(0, MAX_LLM_PRODUCT_CARDS).map((link) => ({
      href: link.href || "",
      text: truncateText(link.text || link.title || "", 160),
    }));
  }
  if (ctx.visibleText || ctx.text) {
    ctx.visibleText = truncateText(ctx.visibleText || ctx.text, 1600);
    delete ctx.text;
  }
  if (ctx.metaDescription) {
    ctx.metaDescription = truncateText(ctx.metaDescription, 400);
  }
  if (ctx.targetImageUrl && String(ctx.targetImageUrl).startsWith("data:")) {
    ctx.targetImageUrl = "__TARGET_IMAGE_URL__";
    ctx.targetImageInputType = "uploaded_image";
  }
  if (Array.isArray(ctx.targetImageCandidates)) {
    ctx.targetImageCandidates = ctx.targetImageCandidates.map((url, idx) => (
      String(url).startsWith("data:") ? `__TARGET_IMAGE_CANDIDATE_${idx + 1}__` : url
    ));
  }
  return ctx;
}

const INTERNAL_RUNAWAY_GUARD_STEPS = 200;

export async function runAgentLoop({ tabId, skillId, skillMarkdown, userInstruction, pageContext, sendProgress, continueSession, highRandomness, negativeFilter, resumeState = null, onCheckpoint = null, workflowId = "", workflowGeneration = "" }) {
  const settings = await getSettings();

  let systemPrompt = skillMarkdown;
  if (negativeFilter === false) {
    systemPrompt += `\n\n=========================================\n\n⚠️ 【用户已手动关闭“不卖原则”过滤限制】：当前处于国内国内电商或不受限的宽容寻源环境，用户已手动取消了默认的“不卖原则”（Negative Filter）负面过滤。因此，你【无须】过滤服饰、鞋帽、内衣、大件重货、陶瓷玻璃易碎品、本地容易买到的普通日杂标品或医疗/成人等高风险品类。请完全根据当前页面商品的实际销量表现、货源品质以及用户指令，自由挖掘上述常规品类并推荐它们的源头供应商！`;
  }
  
  const isApiActive = !!(settings.helium10ApiKey || settings.sellerSpriteApiKey);
  const isFastMossActive = !!settings.fastmossApiKey;
  const filteredToolList = Object.keys(tools).filter(name => {
    if (isComplianceSkill(skillId) && !COMPLIANCE_ALLOWED_TOOLS.has(name)) return false;
    if (name === "query_market_data") return isApiActive;
    if (name === "query_fastmoss_data") return isFastMossActive;
    return true;
  });
  const availableTools = filteredToolList.join(", ");
  let toolHistory = Array.isArray(resumeState?.toolHistory) ? [...resumeState.toolHistory] : [];
  const continuousRunStartedAt = Date.now();

  const actualTargetImageUrl = pageContext?.targetImageUrl || "";
  const ctxForPrompt = buildPromptContext(pageContext);
  const screenshotData = ctxForPrompt.screenshot;
  delete ctxForPrompt.screenshot;

  const userText = `请严格根据 skill 说明执行任务。

## 可用工具
${availableTools}

## 工具调用格式
当需要调用工具时，输出：
\`\`\`json
{"type":"tool_call","tool":"<tool_name>","arguments":{...}}
\`\`\`

## 最终结果格式
请将你最终构思出的结果，**统一组装为标准化的分析报告结构**，完成后输出：
\`\`\`json
{
  "type": "final",
  "output": {
    "overview": "全局概述（使用Markdown，简述你在本页面的核心发现）",
    "analysis": "深度分析过程与推演逻辑（使用Markdown，展示你的多维博弈和决策依据）",
    "summary": "最终核心结论（使用Markdown，提炼出最关键的建议或结论）",
    "data": [ ... ] // 具体的结构化数据（如具体的商品蓝图、筛选出的列表等，必须是数组）
  }
}
\`\`\`


## 当前页面上下文
${JSON.stringify(ctxForPrompt, null, 2)}

## 用户核心焦点 (User Core Focus)
${userInstruction ? `用户补充了以下核心探索方向。这是你的**最高优先级探索目标**。请你**必须将第一步的动作（search_web 或 click），以及后续的所有推演，全部紧紧围绕该主题展开**。但同时，仍需遵守 Skill 中定义的所有避坑与打分原则。\n用户的核心方向是：\n"${userInstruction}"` : "（无额外焦点。请严格按 skill 流程自主探索。）"}

${highRandomness ? `\n\n## ⚠️ [Anti-Cache] 强制发散与破局指令 (Nonce: ${Date.now()})\n用户要求进行**【全新视角的探索】**。请你**完全抛弃最常规、最容易想到的思路**。如果之前的方向是 A，这次请尝试 B 甚至是冷门的 C。突破固有套路，给我极具差异化的答案！` : ""}

${((skillId || "").includes("domestic_sourcing_finder") || (skillId || "").includes("etsy_sourcing_finder")) ? `\n\n## 国内供应链寻源运行硬约束\n- 如果目标是非标外观/造型/模具商品且存在 targetImageUrl，优先调用 image_search_1688 或 image_search_taobao。若已配置生图模型、且平台自动框选主体不完整，可先调用 prepare_clean_product_image，并把返回的 image_search_argument.imageUrl 用作图片搜索输入。\n- 非标品一旦启动图片搜索或干净搜图图准备流程，后续 Critic 打回也严禁调用 input_text_and_search 文本框搜索；必须继续用 productCards 候选主图、截图和视觉相似度证据筛选。\n- agentic_web_search 最多调用 1 次，且只用于物流、费率、政策或认证核算；严禁用它寻找 1688/淘宝货源或替代站内图片搜索。` : ""}

${(skillId || "").includes("etsy_") ? `\n\n## Etsy 浏览器标签页生命周期纪律\n- agentic_web_search 是静默信息检索工具，它自己的临时浏览器标签页由工具内部清理。\n- search_in_browser、open_new_tab、image_search_1688、image_search_taobao、image_search_in_browser 会打开可见标签页。凡是仅用于 Etsy 取证、竞品查看、站外搜索或详情页抽样的新标签页，在读取证据后必须调用 close_tab 关闭对应 tabId。\n- 只有遇到验证码、登录态、人机验证、上传控件等待人工处理，或用户明确需要保留页面继续人工比对时，才允许暂时不关闭；最终报告必须说明保留原因和 tabId。\n- 输出 final 前必须自检：本轮由你打开且已经完成取证的无关标签页是否已经关闭。` : ""}

${(skillId || "").includes("tiktok_shop_monitor") ? `\n\n## ⚠️ TikTok 监控运行硬约束 (TikTok Monitor Hard Constraints)\n- 【严禁直接输出 final】：你绝对不能在第 1 步就直接输出 final 最终报告！\n- 【详情页深挖流程】：你必须挑选出 2-3 个核心/爆款商品，对这 2-3 个商品依次执行：(1) 调用 open_new_tab 打开该商品详情页，(2) 自动读取页面（在 open_new_tab 返回中会自动包含最新的 pageData，或调用 read_current_page 确认），(3) 调用 close_tab 关闭该标签页。只有将这 2-3 个重点商品对应的详情页细节深度抓取合并后，才允许输出 final 最终报告！` : ""}
`;

  let userContent = userText;
  if (screenshotData) {
    userContent = [
      { type: "text", text: userText },
      { type: "image_url", image_url: { url: screenshotData } }
    ];
  }

  let messages = [];
  const sessionKey = `${tabId}`;
  const saveCheckpoint = async (patch = {}) => {
    const ctxState = {
      __reflectionsCount: ctxForPrompt.__reflectionsCount || 0,
      __hasDeepReflected: Boolean(ctxForPrompt.__hasDeepReflected),
    };
    globalSessionCache[sessionKey] = { messages, toolHistory, ctxState };
    const checkpointPayload = {
      status: "running",
      tabId,
      skillId,
      userInstruction,
      pageUrl: pageContext?.url || "",
      pageTitle: pageContext?.title || "",
      messages,
      toolHistory,
      ctxState,
      lastStage: patch.lastStage || patch.lastNode || patch.status || "checkpoint",
      ...patch,
    };
    try {
      await saveAgentCheckpoint(sessionKey, checkpointPayload);
      if (typeof onCheckpoint === "function") {
        await onCheckpoint({
          ...checkpointPayload,
          messages: serializeMessagesForCheckpoint(messages),
          toolHistory: serializeToolHistoryForCheckpoint(toolHistory),
          updatedAt: new Date().toISOString(),
        });
      }
    } catch (err) {
      console.warn("Failed to persist agent checkpoint:", err.message);
    }
  };

  let restoredCheckpoint = null;
  if (continueSession && Array.isArray(resumeState?.messages) && resumeState.messages.length > 0) {
    restoredCheckpoint = {
      ...resumeState,
      messages: hydrateMessagesFromCheckpoint(resumeState.messages),
      toolHistory: Array.isArray(resumeState.toolHistory) ? [...resumeState.toolHistory] : [],
    };
  } else if (continueSession) {
    const cached = globalSessionCache[sessionKey];
    if (Array.isArray(cached)) {
      restoredCheckpoint = { messages: cached, toolHistory: [], ctxState: {} };
    } else if (cached?.messages) {
      restoredCheckpoint = cached;
    } else {
      restoredCheckpoint = await loadAgentCheckpoint(sessionKey);
    }
    if (restoredCheckpoint?.skillId && restoredCheckpoint.skillId !== skillId) {
      restoredCheckpoint = null;
    }
  }

  if (continueSession && restoredCheckpoint?.messages?.length) {
    messages = restoredCheckpoint.messages;
    toolHistory = Array.isArray(restoredCheckpoint.toolHistory) ? restoredCheckpoint.toolHistory : [];
    if (restoredCheckpoint.ctxState) {
      ctxForPrompt.__reflectionsCount = restoredCheckpoint.ctxState.__reflectionsCount || 0;
      ctxForPrompt.__hasDeepReflected = Boolean(restoredCheckpoint.ctxState.__hasDeepReflected);
    }
    sendProgress({
      type: "checkpoint_restored",
      step: restoredCheckpoint.step || 0,
      message: `已恢复上次中断的 workflow：${restoredCheckpoint.lastStage || restoredCheckpoint.lastNode || restoredCheckpoint.status || "checkpoint"}，沿用 ${toolHistory.length} 个工具证据继续推进。`,
    });
    if (messages.length > 0 && messages[0].role === "system") {
      messages[0].content = systemPrompt;
    }

    const newCtx = buildPromptContext(pageContext);
    delete newCtx.screenshot;
    const ctxString = JSON.stringify(newCtx, null, 2);

    let instructionText = `[断点续跑] 请从上次中断节点继续，不要重复已经完成的搜索、开页、筛选或已获得的工具证据。`;
    if (userInstruction) {
      instructionText += `\n\n用户最新补充信息：\n"${userInstruction}"`;
    } else {
      instructionText += `\n\n请结合最新 System Prompt 和页面上下文继续推进。`;
    }
    
    if ((skillId || "").includes("domestic_sourcing_finder") || (skillId || "").includes("etsy_sourcing_finder")) {
      instructionText += `\n\n【⚠️ 极其重要：禁止直接生成/必须调用浏览器工具真实寻源】\n当前匹配到的是寻源任务（例如需要去 1688、淘宝等平台寻找货源或对比价格），**你绝对禁止直接从历史记忆中复制或凭空捏造虚假的 1688/淘宝 详情页链接！**\n如果最新页面上下文中存在 targetImageUrl，且目标商品属于非标外观/模具/造型商品，你必须在第一步调用 'image_search_1688'（优先）或 'image_search_taobao' 执行供应商平台以图搜源；如果已配置生图模型且平台自动框选主体不完整，可先调用 'prepare_clean_product_image' 准备干净主体图，再把返回的 image_search_argument.imageUrl 传给图片搜索工具。非标品一旦进入图片检索路径，Critic 打回后也严禁切回 'input_text_and_search' 关键词搜索；只有目标明确为标品或用户明确要求文本兜底，才允许文本搜索。只有在通过工具真实获取并校验了详情页内容、价格和起批量后，才被允许在最后的报告中写入真实的 1688/淘宝详情页链接并输出 final 报告！`;
    }

    instructionText += `\n\n【极其重要：强制输出格式】\n无论你进行了多少轮推演，**你最后一次的输出必须，且只能是如下 JSON 格式**（请包裹在 \`\`\`json 中）：\n\`\`\`json\n{\n  "type": "final",\n  "output": {\n    "overview": "...",\n    "analysis": "...",\n    "summary": "...",\n    "data": [] \n  }\n}\n\`\`\`\n严禁把上述指令文字直接暴露在最终报告中！`;
    instructionText += `\n\n【最终报告语言净化要求】工具名、函数名、页面解析术语和内部执行细节只允许出现在工具调用中，严禁写入最终报告正文。最终报告必须面向 Etsy 卖家，用“页面文本取证、候选详情页核验、后台资料检索、平台访问限制”等业务语言表达，不得出现 DOM、xpath、read_current_page、open_new_tab、close_tab、agentic_web_search 等内部技术词。`;
    instructionText += `\n\n【注意：以下是你当前所处的最新页面上下文数据】\n${ctxString}`;

    let newUserContent = instructionText;
    if (pageContext.screenshot) {
      newUserContent = [
        { type: "text", text: instructionText },
        { type: "image_url", image_url: { url: pageContext.screenshot } }
      ];
    }

    messages.push({
      role: "user",
      content: newUserContent
    });
    await saveCheckpoint({ status: "resumed", step: restoredCheckpoint.step || 0, lastNode: "resume_context_appended" });
  } else {
    await clearAgentCheckpoint(sessionKey);
    messages = [
      {
        role: "system",
        content: systemPrompt,
      },
      {
        role: "user",
        content: userContent,
      },
    ];
    await saveCheckpoint({ status: "started", step: 0, lastNode: "initial_prompt_created" });
  }

  sendProgress({ type: "start", step: 0, loopLimitDisabled: true });

  for (let step = 1; ; step++) {
    if (workflowId && await isWorkflowCancellationRequested(workflowId)) {
      await saveCheckpoint({ status: "cancelled", step: step - 1, lastNode: "workflow_cancellation_requested" });
      return {
        ok: false,
        type: "interrupted",
        result: "workflow 已收到取消信号，已保存当前断点。发送“继续”可恢复未完成节点。",
        steps: step - 1,
      };
    }
    const runtimeMs = Date.now() - continuousRunStartedAt;
    if (runtimeMs >= MAX_CONTINUOUS_RUNTIME_MS) {
      await saveCheckpoint({
        status: "runtime_budget_paused",
        step: step - 1,
        lastNode: "continuous_runtime_budget",
        runtimeMs,
      });
      sendProgress({
        type: "workflow_timeout",
        step: step - 1,
        elapsedSeconds: Math.round(runtimeMs / 1000),
        message: "本次连续运行已达到 15 分钟运行预算，已保存断点并暂停。发送“继续”后将从当前节点恢复。",
      });
      return {
        ok: false,
        type: "interrupted",
        result: "工作流已达到本次连续运行预算，已保存断点。请发送“继续”从当前节点恢复。",
        steps: step - 1,
      };
    }
    if (step > INTERNAL_RUNAWAY_GUARD_STEPS) {
      await saveCheckpoint({
        status: "runaway_guard_paused",
        step: step - 1,
        lastNode: "internal_runaway_guard",
      });
      return {
        ok: false,
        type: "interrupted",
        result: "工作流已触发内部跑飞保护并保存断点。请补充一句“继续”，系统会从当前工具证据和消息历史继续推进，而不是从第一步重跑。",
        steps: step - 1,
      };
    }
    sendProgress({ type: "thinking", step, loopLimitDisabled: true });
    await saveCheckpoint({ status: "running", step, lastNode: "llm_call_started" });

    let assistantContent = "";
    const llmMessages = compactMessagesForLLM(messages);
    const llmPayloadChars = JSON.stringify(llmMessages).length;
    sendProgress({
      type: "llm_started",
      step,
      messageCount: llmMessages.length,
      payloadChars: llmPayloadChars,
      estimatedTokens: Math.ceil(llmPayloadChars / 4),
      message: `正在请求 AI（${llmMessages.length} 条消息，约 ${Math.ceil(llmPayloadChars / 4)} tokens）...`,
    });
    const llmStartedAt = Date.now();
    let llmHeartbeatTimer = null;
    try {
      llmHeartbeatTimer = setInterval(() => {
        const elapsedSeconds = Math.max(1, Math.round((Date.now() - llmStartedAt) / 1000));
        sendProgress({
          type: "llm_heartbeat",
          step,
          elapsedSeconds,
          message: `AI 正在基于已采集证据规划下一步，已运行 ${elapsedSeconds} 秒。`,
        });
      }, 30000);
      assistantContent = await callLLM(llmMessages, ({ chunk, fullText, isReasoning }) => {
        sendProgress({ type: "streaming", step, chunk, fullText, isReasoning });
      }, highRandomness);
    } finally {
      if (llmHeartbeatTimer) clearInterval(llmHeartbeatTimer);
    }

    sendProgress({ type: "llm_done", step, content: assistantContent });
    await saveCheckpoint({
      status: "llm_done",
      step,
      lastNode: "llm_response_received",
      pendingAssistantContent: assistantContent,
    });

    let parsed = extractJSONBlock(assistantContent);
    const normalizedFinalShape = normalizeFinalReportShapeForDelivery(parsed);
    if (normalizedFinalShape.changed) {
      parsed = normalizedFinalShape.parsed;
      sendProgress({
        type: "auto_fix",
        step,
        message: `${normalizedFinalShape.reason}，避免因交付包装偏差触发整稿重做。`,
      });
    }

    if (!parsed) {
      messages.push({ role: "assistant", content: assistantContent });
      globalSessionCache[sessionKey] = { messages, toolHistory, ctxState: {} };
      await clearAgentCheckpoint(sessionKey);
      return {
        ok: true,
        type: "text",
        result: assistantContent,
        steps: step,
      };
    }

    if (parsed.type === "final") {
      const sanitizedFinal = sanitizeFinalReportForDelivery(parsed);
      if (sanitizedFinal.changed) {
        parsed = sanitizedFinal.parsed;
        sendProgress({
          type: "auto_fix",
          step,
          message: "已自动将报告中的内部技术术语改写为业务语言，避免不必要的整稿重做。",
        });
      }
      const autoRepairedFinal = autoRepairFinalReportForDelivery(parsed, { skillId, toolHistory, pageContext });
      if (autoRepairedFinal.changed) {
        parsed = autoRepairedFinal.parsed;
        sendProgress({
          type: "auto_fix",
          step,
          message: `已自动修正非质量类证据账本问题：${autoRepairedFinal.reasons.join("；")}。`,
        });
      }
      const validationErrors = validateReport(parsed, userInstruction, skillId, toolHistory, pageContext);
      if (validationErrors.length > 0) {
        const reflectionsCount = ctxForPrompt.__reflectionsCount || 0;
        if (reflectionsCount < 2) {
          ctxForPrompt.__reflectionsCount = reflectionsCount + 1;
          sendProgress({ type: "reflection", step, message: `Critic 自动审计拒绝：${validationErrors[0]} 正在打回重做...` });
          
          messages.push({ role: "assistant", content: assistantContent });
          const domesticVisualActive = domesticVisualRouteActive(skillId, pageContext, toolHistory);
          messages.push({
            role: "user",
            content: `【Critic Agent 报告质量审计拒绝】\n你的报告未能通过系统的自动合规自检，发现了以下问题：\n${validationErrors.map((err, i) => `${i + 1}. ${err}`).join("\n")}\n\n${domesticVisualActive ? "【非标视觉寻源硬约束】本轮已经启动目标主图/以图搜图路径。请继续基于图片搜索结果页 productCards 和截图做视觉相似度修正，补齐 candidate_image_url、list_page_visual_score、visual_match_evidence；严禁回到 1688/淘宝文本框关键词搜索来凑结果。\n\n" : ""}请严格对照系统提示词规范，在脑海中进行深度反思（如补充筛选数量、使用真实详情单页链接、清除技术黑话等），并重新调用工具或重新输出一份完美修正了以上所有问题的 \`{"type":"final", "output": {...}}\` 报告！`
          });
          await saveCheckpoint({ status: "critic_retry", step, lastNode: "report_validation_retry", validationErrors });
          continue;
        }
      }

      messages.push({ role: "assistant", content: assistantContent });
      globalSessionCache[sessionKey] = { messages, toolHistory, ctxState: {} };
      await clearAgentCheckpoint(sessionKey);
      return {
        ok: true,
        type: "final",
        result: parsed.output,
        steps: step,
      };
    }

    if (parsed.type === "tool_call") {
      const toolName = parsed.tool;
      const toolArgs = parsed.arguments || {};

      if (isComplianceSkill(skillId) && !COMPLIANCE_ALLOWED_TOOLS.has(toolName)) {
        messages.push({ role: "assistant", content: assistantContent });
        messages.push({
          role: "user",
          content: JSON.stringify({
            type: "tool_error",
            tool: toolName,
            error: "商品合规审查不允许调用采购、市场规模、广告或供应商工具。请只使用商品页面、店铺分页、截图视觉证据、Etsy 官方政策、目标市场官方法规和个人访问 API 读取工具完成审查。",
          }),
        });
        await saveCheckpoint({ status: "tool_guard_retry", step, lastNode: "compliance_tool_whitelist_guard", toolName });
        continue;
      }

      if (toolName === "prepare_clean_product_image") {
        if ((!toolArgs.imageUrl || toolArgs.imageUrl === "__TARGET_IMAGE_URL__") && actualTargetImageUrl) {
          toolArgs.imageUrl = actualTargetImageUrl;
        }
      }

      if (isEtsyBusinessSkill(skillId) && toolName === "collect_etsy_shop_pages") {
        toolArgs.deepDetail = true;
      }

      if (workflowId) {
        toolArgs.workflowId = workflowId;
        toolArgs.workflowGeneration = workflowGeneration;
      }

      if (isImageSearchTool(toolName)) {
        if ((!toolArgs.imageUrl || toolArgs.imageUrl === "__TARGET_IMAGE_URL__") && actualTargetImageUrl) {
          toolArgs.imageUrl = actualTargetImageUrl;
        }
      }

      if (isShopOptimizerOnly(skillId) && !isExplicitSourcingRequested(userInstruction)) {
        const engine = String(toolArgs.engine || "").toLowerCase();
        const query = String(toolArgs.query || toolArgs.keyword || "");
        const isSourcingTool =
          isImageSearchTool(toolName) ||
          (toolName === "search_in_browser" && (engine === "1688" || /1688|货源|供应商|采购|批发|起批|工厂/i.test(query)));
        if (isSourcingTool) {
          messages.push({ role: "assistant", content: assistantContent });
          messages.push({
            role: "user",
            content: JSON.stringify({
              type: "tool_error",
              tool: toolName,
              error: "当前任务是 Etsy 店铺优化诊断，不是寻源流程。第一步必须围绕店铺健康评级、页面/截图/自营 API 数据、Etsy 站内竞品、Google Trends / Etsy 搜索 需求证据构建 ABC 优化方案；除非用户明确要求 1688/货源/采购，否则禁止调用采购平台搜索或生成供应商链接。",
            }),
          });
          await saveCheckpoint({ status: "tool_guard_retry", step, lastNode: "shop_optimizer_sourcing_guard", toolName });
          continue;
        }
      }

      const etsyBrowserWorkflowGuardError = getEtsyBrowserWorkflowGuardError({
        skillId,
        toolName,
        toolArgs,
        toolHistory,
      });
      if (etsyBrowserWorkflowGuardError) {
        messages.push({ role: "assistant", content: assistantContent });
        messages.push({
          role: "user",
          content: JSON.stringify(etsyBrowserWorkflowGuardError),
        });
        sendProgress({
          type: "tool_guard",
          step,
          toolName,
          message: etsyBrowserWorkflowGuardError.error,
        });
        await saveCheckpoint({ status: "tool_guard_retry", step, lastNode: "etsy_browser_workflow_guard", toolName });
        continue;
      }

      const sourcingWorkflowGuardError = getSourcingWorkflowGuardError({
        skillId,
        toolName,
        toolArgs,
        userInstruction,
        toolHistory,
        pageContext,
      });
      if (sourcingWorkflowGuardError) {
        messages.push({ role: "assistant", content: assistantContent });
        messages.push({
          role: "user",
          content: JSON.stringify(sourcingWorkflowGuardError),
        });
        await saveCheckpoint({ status: "tool_guard_retry", step, lastNode: "sourcing_workflow_guard", toolName });
        continue;
      }

      if (isSourcingSkill(skillId) && toolName === "input_text_and_search") {
        const incompleteImageSearch = lastIncompleteImageSearch(toolHistory);
        if (incompleteImageSearch) {
          messages.push({ role: "assistant", content: assistantContent });
          messages.push({
            role: "user",
            content: JSON.stringify({
              type: "tool_error",
              tool: toolName,
              error: "刚刚的以图搜图流程尚未真正进入商品结果页，禁止立即切换到文本搜索。请先继续完成图片检索动作：优先重新调用 image_search_1688/image_search_taobao；如果页面仍停留在上传浮层，请读取页面或使用截图坐标点击明确的“搜索图片/以图搜款/找同款”按钮；只有平台明确无图搜结果、验证码/登录墙阻断，或用户要求文本兜底时，才允许文本搜索。",
              previousImageSearch: {
                tool: incompleteImageSearch.tool,
                result: incompleteImageSearch.result,
              },
            }),
          });
          await saveCheckpoint({ status: "tool_guard_retry", step, lastNode: "incomplete_image_search_guard", toolName });
          continue;
        }

        if (domesticVisualRouteActive(skillId, pageContext, toolHistory) && !isExplicitTextFallbackAllowed(userInstruction)) {
          messages.push({ role: "assistant", content: assistantContent });
          messages.push({
            role: "user",
            content: JSON.stringify({
              type: "tool_error",
              tool: toolName,
              error: "本轮国内寻源已经进入非标视觉/以图搜图路径。对于非标外观、模具、造型类商品，Critic 打回后也严格禁止回到文本框关键词搜索。请继续使用 productCards、截图和候选主图做视觉相似度筛选；如 1688 自动框选主体不完整且已配置生图模型，请先调用 prepare_clean_product_image，再把返回的 image_search_argument.imageUrl 传给 image_search_1688/image_search_taobao。",
            }),
          });
          await saveCheckpoint({ status: "tool_guard_retry", step, lastNode: "visual_route_text_guard", toolName });
          continue;
        }
      }

      if (isSourcingSkill(skillId) && toolName === "agentic_web_search") {
        const query = toolArgs.query || "";
        const previousSearches = countToolCalls(toolHistory, "agentic_web_search");
        if (previousSearches >= 1 || !isLogisticsOrPolicySearchQuery(query)) {
          messages.push({ role: "assistant", content: assistantContent });
          messages.push({
            role: "user",
            content: JSON.stringify({
              type: "tool_error",
              tool: toolName,
              error: previousSearches >= 1
                ? "国内供应链寻源流程中 agentic_web_search 最多允许调用 1 次，仅用于物流、费率、政策或认证核算。请不要重复静默联网搜索；继续使用当前 1688/淘宝视觉候选、详情页数据和已获得的物流估算完成报告。"
                : "agentic_web_search 只允许用于物流、费率、政策、认证等纯信息核算，不能用于寻找 1688/淘宝货源或替代图片搜索。请回到 image_search_1688/image_search_taobao、productCards 视觉筛选或详情页审计。",
              query,
            }),
          });
          await saveCheckpoint({ status: "tool_guard_retry", step, lastNode: "agentic_web_search_guard", toolName });
          continue;
        }
      }

      const progressToolArgs = { ...toolArgs };
      if (progressToolArgs.imageUrl && String(progressToolArgs.imageUrl).startsWith("data:")) {
        progressToolArgs.imageUrl = "__UPLOADED_IMAGE_DATA__";
      }
      sendProgress({ type: "tool_call", step, toolName, toolArgs: progressToolArgs });
      await saveCheckpoint({
        status: "tool_pending",
        step,
        lastNode: "tool_call_ready",
        toolName,
        toolArgs: progressToolArgs,
      });

      if (!tools[toolName]) {
        const errMsg = `Unknown tool: ${toolName}. Available: ${availableTools}`;
        messages.push({ role: "assistant", content: assistantContent });
        messages.push({
          role: "user",
          content: JSON.stringify({ type: "tool_error", tool: toolName, error: errMsg }),
        });
        await saveCheckpoint({ status: "tool_error", step, lastNode: "unknown_tool", toolName });
        continue;
      }

      // Auto-inject page context into monitor_process_page_data to prevent LLM token overflow
      if (toolName === "monitor_process_page_data") {
        if (!toolArgs.items || toolArgs.items.length === 0) {
          toolArgs.items = pageContext.productCards || [];
        }
        if (!toolArgs.shopInfo && pageContext.url) {
          toolArgs.shopInfo = {
            name: pageContext.title || "Etsy Seller",
            url: pageContext.url
          };
        }
        if (!toolArgs.platform) {
          toolArgs.platform = (pageContext.url && pageContext.url.includes("etsy")) ? "etsy" : "tiktok";
        }
      }

      let toolResult;
      let toolTimedOut = false;
      let toolHeartbeatTimer = null;
      const toolStartedAt = Date.now();
      const toolTimeoutMs = getToolTimeoutMs(toolName);
      const tabsBeforeTool = await snapshotTabIds();
      try {
        toolHeartbeatTimer = setInterval(() => {
          const elapsedSeconds = Math.max(1, Math.round((Date.now() - toolStartedAt) / 1000));
          sendProgress({
            type: "tool_heartbeat",
            step,
            toolName,
            elapsedSeconds,
            timeoutSeconds: Math.round(toolTimeoutMs / 1000),
            message: `${toolName} 已运行 ${elapsedSeconds} 秒，最长等待 ${Math.round(toolTimeoutMs / 1000)} 秒；若超时会自动返回错误并继续恢复 workflow。`,
          });
        }, 30000);
        toolResult = await runToolWithTimeout(toolName, toolArgs);
        if (workflowId && !(await isWorkflowGenerationCurrent(workflowId, workflowGeneration))) {
          toolResult = {
            ok: false,
            cancelled: true,
            stale: true,
            error: "workflow generation changed while the tool was running; late tool result discarded",
          };
        }
      } catch (err) {
        toolTimedOut = / timed out after /i.test(String(err.message || ""));
        toolResult = {
          ok: false,
          error: err.message,
          timedOut: toolTimedOut,
          elapsedMs: Date.now() - toolStartedAt,
        };
        if (toolTimedOut) {
          const closedTabIds = await closeTabsCreatedDuringTimedOutTool(tabsBeforeTool);
          toolResult.closedTabIds = closedTabIds;
          sendProgress({
            type: "tool_timeout",
            step,
            toolName,
            elapsedSeconds: Math.round((Date.now() - toolStartedAt) / 1000),
            message: `${toolName} 已超时，已回收本次工具新增的临时标签页并继续保存断点。`,
          });
        }
      } finally {
        if (toolHeartbeatTimer) {
          clearInterval(toolHeartbeatTimer);
        }
      }
      if (toolResult?.stale) {
        await saveCheckpoint({ status: "stale_tool_result_discarded", step, lastNode: "stale_tool_result_discarded", toolName });
        sendProgress({
          type: "stale_tool_result_discarded",
          step,
          toolName,
          message: "旧 workflow 的迟到工具结果已丢弃，未写入当前恢复任务。",
        });
        return {
          ok: false,
          type: "interrupted",
          result: "检测到旧 workflow 迟到结果，已丢弃并保存断点。请继续当前 workflow。",
          steps: step,
        };
      }
      toolHistory.push({ tool: toolName, arguments: toolArgs, result: toolResult });

      sendProgress({ type: "tool_result", step, toolName, toolResult });
      await saveCheckpoint({
        status: toolTimedOut ? "tool_timeout" : "tool_completed",
        step,
        lastNode: toolTimedOut ? "tool_timeout" : "tool_result",
        toolName,
      });

      if (toolResult && toolResult.isCaptcha) {
        sendProgress({
          type: "captcha_warning",
          step,
          message: "【采购平台人机拦截预警】：检测到当前页面被验证码（滑块）或登录限制卡住！请立刻前往打开的浏览器窗口，滑动通过验证或完成登录。操作完成后 Agent 将自动继续。"
        });
      }

      let nextScreenshot = null;
      let nextScreenshotCaptureMode = "unknown";
      const pageModifyingTools = ["open_new_tab", "navigate_to", "search_in_browser", "collect_etsy_shop_pages", "collect_etsy_competitor_shops", "click_by_text", "input_text_and_search", "click_by_selector", "image_search_1688", "image_search_taobao", "image_search_in_browser", "click_by_coordinate"];
      const skipImmediateLoopScreenshotTools = new Set([
        "collect_etsy_shop_pages",
        "collect_etsy_competitor_shops",
      ]);
      if (pageModifyingTools.includes(toolName) && !skipImmediateLoopScreenshotTools.has(toolName)) {
        try {
          const tId = (toolResult && toolResult.tabId) ? toolResult.tabId : tabId;
          const t = await new Promise((resTab) => {
            chrome.tabs.get(tId, (tabInfo) => {
              if (chrome.runtime.lastError || !tabInfo) resTab(null);
              else resTab(tabInfo);
            });
          });
          if (t && t.windowId) {
            if (/etsy\.com/i.test(String(t.url || ""))) {
              try {
                const fullPageCapture = await captureFullPageScreenshot(tId);
                nextScreenshot = fullPageCapture.dataUrl;
                nextScreenshotCaptureMode = fullPageCapture.captureMode;
              } catch (err) {
                console.warn("Could not capture Etsy full-page screenshot for loop context:", err.message);
              }
            }
            if (!nextScreenshot) {
              nextScreenshot = await new Promise((resScr) => {
                chrome.tabs.captureVisibleTab(t.windowId, { format: "jpeg", quality: 60 }, (dataUrl) => {
                  if (chrome.runtime.lastError || !dataUrl) resScr(null);
                  else resScr(dataUrl);
                });
              });
              nextScreenshotCaptureMode = "captureVisibleTab_viewport";
            }
          }
        } catch (err) {
          console.warn("Could not capture real-time loop screenshot:", err.message);
        }
      }

      if (nextScreenshot && toolHistory.at(-1)?.tool === toolName) {
        try {
          const screenshotArtifact = await putDataUrlArtifact(nextScreenshot, {
            namespace: "workflow-loop-screenshot",
            metadata: { workflowId, toolName, step },
            ttlMs: 24 * 60 * 60 * 1000,
          });
          const latestToolEntry = toolHistory.at(-1);
          latestToolEntry.result = {
            ...(latestToolEntry.result || {}),
            screenshotCaptured: true,
            screenshotRef: screenshotArtifact.ref,
            screenshotStorage: screenshotArtifact.storage,
            screenshotExpiresAt: screenshotArtifact.expiresAt,
            screenshotCaptureMode: nextScreenshotCaptureMode,
          };
        } catch (err) {
          console.warn("Could not persist workflow loop screenshot artifact:", err.message);
        }
      }

      messages.push({ role: "assistant", content: assistantContent });

      const userResultObj = {
        type: "tool_result",
        tool: toolName,
        result: compactToolResultForLLM(toolName, toolResult),
        rawResultPreservedInToolHistory: true,
      };
      const productCards = toolResult?.pageData?.productCards || [];
      if (Array.isArray(productCards) && productCards.length > 0) {
        userResultObj.visual_candidate_summary = summarizeProductCards(productCards);
        userResultObj.next_step_instruction = "当前页面已经抽取到带主图与屏幕坐标的 productCards。下一步必须停止继续搜索，先对照目标商品主图和最新截图，把这些卡片按外观/材质/结构视觉相似度排序；只允许打开视觉排名最高且未触发材质/造型红线的 1-3 个详情页。最终 data 每项必须写入 candidate_image_url、list_page_visual_score、visual_match_evidence，禁止只按标题关键词选择。";
      }
      if (isEtsyBusinessSkill(skillId) && toolName === "open_new_tab" && /etsy\.com\/shop\//i.test(String(toolResult?.finalUrl || toolResult?.url || toolArgs.url || ""))) {
        userResultObj.next_step_instruction = "该 Etsy 店铺页已经打开并读取过。下一步不要继续重复 open_new_tab；若已有 2-3 个竞品店铺 URL，请优先调用 collect_etsy_competitor_shops 批量采集；若只处理当前单个店铺，再调用 collect_etsy_shop_pages 采集 1-3 页商品/排序/分页数据。采集后必须调用 analyze_etsy_shop_crawl_screenshots 解读截图；完成取证后关闭不再需要的 tabId。";
      }
      if (isEtsyBusinessSkill(skillId) && toolName === "collect_etsy_competitor_shops") {
        userResultObj.next_step_instruction = "批量竞品店铺采集已完成。下一步不要重复打开这些店铺；请把 allPages 或 screenshotRefs 传给 analyze_etsy_shop_crawl_screenshots 做独立视觉解读，然后基于 shops[].pages[].productCards 逐店铺输出价格分布、商品类别/SKU 样本、促销/评论信号和可见排序解读。";
      }

      let userMsgContent;
      if (nextScreenshot) {
        userMsgContent = [
          { type: "text", text: compactJsonStringForLLM(userResultObj) },
          { type: "image_url", image_url: { url: nextScreenshot } }
        ];
      } else {
        userMsgContent = compactJsonStringForLLM(userResultObj);
      }

      messages.push({
        role: "user",
        content: userMsgContent,
      });
      await saveCheckpoint({ status: "tool_context_appended", step, lastNode: "tool_result_context", toolName });

      continue;
    }

    messages.push({ role: "assistant", content: assistantContent });
    globalSessionCache[sessionKey] = { messages, toolHistory, ctxState: {} };
    await clearAgentCheckpoint(sessionKey);
    return {
      ok: true,
      type: "json",
      result: parsed,
      steps: step,
    };
  }

}

function repairJSONQuotes(str) {
  if (!str) return str;
  let result = "";
  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    if (char === '"') {
      if (i > 0 && str[i - 1] === '\\') {
        result += char;
        continue;
      }
      let beforeChar = "";
      for (let j = i - 1; j >= 0; j--) {
        if (!/\s/.test(str[j])) {
          beforeChar = str[j];
          break;
        }
      }
      let afterChar = "";
      for (let j = i + 1; j < str.length; j++) {
        if (!/\s/.test(str[j])) {
          afterChar = str[j];
          break;
        }
      }
      const isPrecededByStructure = ["{", "[", ",", ":"].includes(beforeChar);
      const isFollowedByStructure = [":", ",", "}", "]"].includes(afterChar);
      if (isPrecededByStructure || isFollowedByStructure) {
        result += char;
      } else {
        result += '\\"';
      }
    } else {
      result += char;
    }
  }
  return result;
}

function tryParseJSON(str) {
  try {
    return JSON.parse(str);
  } catch (e) {
    try {
      let repaired = repairJSONQuotes(str);
      repaired = repaired.replace(/"([^"\\]*(?:\\.[^"\\]*)*)"/g, (match, p1) => {
        return '"' + p1.replace(/\n/g, '\\n').replace(/\r/g, '\\r') + '"';
      });
      return JSON.parse(repaired);
    } catch (_) {
      throw e;
    }
  }
}

function extractBalancedJSONCandidates(text = "") {
  const candidates = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = i;
      depth++;
      continue;
    }
    if (char === "}") {
      if (depth > 0) depth--;
      if (depth === 0 && start >= 0) {
        candidates.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return candidates;
}

function isLikelyAgentJSON(parsed) {
  return Boolean(
    parsed &&
    typeof parsed === "object" &&
    (parsed.type === "final" || parsed.output || parsed.tool || looksLikeReportOutput(parsed))
  );
}

export function extractJSONBlock(text) {
  if (!text || typeof text !== "string") return null;

  // 1. Scan code blocks (from last to first to match the final output block after reflections)
  const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)```/g;
  let matches = [];
  let match;
  while ((match = codeBlockRegex.exec(text)) !== null) {
    matches.push(match[1].trim());
  }

  for (let i = matches.length - 1; i >= 0; i--) {
    try {
      const parsed = tryParseJSON(matches[i]);
      if (isLikelyAgentJSON(parsed)) {
        return parsed;
      }
    } catch (_) {}
  }

  // 2. Fallback: scan balanced JSON objects in prose. This handles
  // "critic notes ... { type: final ... }" without returning the prose as text.
  const braceMatches = extractBalancedJSONCandidates(text)
    .map((candidate) => candidate.trim())
    .filter((candidate) => /"type"\s*:\s*"final"|"output"\s*:|"tool"\s*:|"overview"\s*:|"analysis"\s*:|"summary"\s*:|"data"\s*:/.test(candidate));
  for (let i = braceMatches.length - 1; i >= 0; i--) {
    try {
      const parsed = tryParseJSON(braceMatches[i]);
      if (isLikelyAgentJSON(parsed)) {
        return parsed;
      }
    } catch (_) {}
  }

  // 3. Fallback: Try raw parsing of the entire text
  try {
    return tryParseJSON(text.trim());
  } catch (_) {}

  return null;
}
