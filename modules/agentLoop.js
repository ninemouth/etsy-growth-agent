// modules/agentLoop.js — The Agent reasoning & tool loop logic

import { callLLM, getSettings } from './llmClient.js';
import { tools, hasValidEtsySearchEvidence, hasValidGoogleTrendsEvidence } from './toolRegistry.js';
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
const QUALITY_RETRY_LIMIT = 2;
const inFlightToolRuns = new Map();

function stableToolValue(value) {
  if (Array.isArray(value)) return value.map(stableToolValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableToolValue(value[key])]));
  }
  return value;
}

function toolRunKey(toolName, toolArgs = {}) {
  const workflowId = String(toolArgs.workflowId || "default");
  const dedupeArgs = { ...toolArgs };
  delete dedupeArgs.workflowGeneration;
  return `${workflowId}:${toolName}:${JSON.stringify(stableToolValue(dedupeArgs))}`;
}

function normalizeSearchQueryForWorkflow(query = "") {
  return String(query || "")
    .trim()
    .replace(/[“”"']/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function searchEvidenceKey(toolArgs = {}) {
  const engine = String(toolArgs.engine || "google").toLowerCase();
  const searchType = String(toolArgs.searchType || "listing").toLowerCase();
  const query = normalizeSearchQueryForWorkflow(toolArgs.query || toolArgs.keyword || "");
  return query ? `${engine}:${searchType}:${query}` : "";
}

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
    evidenceType: result.evidenceType,
    screenshotCaptured: result.screenshotCaptured,
    screenshotRef: result.screenshotRef,
    screenshotStorage: result.screenshotStorage,
    screenshotCaptureMode: result.screenshotCaptureMode,
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
  normalizeSearchQueryForWorkflow,
  searchEvidenceKey,
  getPlatformTrendEvidenceState,
  getPlatformTrendStageGuard,
  compactPlatformTrendRunawayToolHistory,
  checkpointSkillMatches,
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

function checkpointSkillMatches(checkpoint = {}, expectedSkillId = "") {
  if (!expectedSkillId) return true;
  if (!checkpoint?.skillId) return false;
  return String(checkpoint.skillId) === String(expectedSkillId);
}

async function loadAgentCheckpoint(sessionKey, expectedSkillId = "") {
  if (!checkpointStorageAvailable()) return null;
  const data = await new Promise((resolve) => {
    chrome.storage.local.get([checkpointKey(sessionKey), CHECKPOINT_LATEST_KEY], resolve);
  });
  const exactCheckpoint = data[checkpointKey(sessionKey)] || null;
  if (exactCheckpoint) {
    if (!checkpointSkillMatches(exactCheckpoint, expectedSkillId)) return null;
    return {
      ...exactCheckpoint,
      messages: hydrateMessagesFromCheckpoint(exactCheckpoint.messages || []),
    };
  }
  const checkpoint = data[CHECKPOINT_LATEST_KEY] || null;
  if (!checkpoint) return null;
  if (!checkpointSkillMatches(checkpoint, expectedSkillId)) return null;
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
const PLATFORM_TRENDS_SKILL_RE = /etsy_platform_trends/;
const KEYWORD_SKILL_RE = /etsy_keyword_analysis/;
const LISTING_SKILL_RE = /etsy_listing_generator/;
const PRODUCT_OPPORTUNITY_SKILL_RE = /etsy_product_opportunity_explorer|etsy_crossborder_explorer/;

export function isPlatformTrendSkill(skillId = "") {
  return PLATFORM_TRENDS_SKILL_RE.test(String(skillId || ""));
}

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
  "etsy_api_get_connection_status",
  "etsy_api_get_store_snapshot",
  "etsy_api_get_products",
  "etsy_api_get_product_info",
]);

const PLATFORM_TRENDS_ALLOWED_TOOLS = new Set([
  "read_current_page",
  "open_new_tab",
  "close_tab",
  "navigate_to",
  "search_in_browser",
  "collect_etsy_shop_pages",
  "collect_etsy_competitor_shops",
  "analyze_etsy_shop_crawl_screenshots",
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

function isKeywordSkill(skillId = "") {
  return KEYWORD_SKILL_RE.test(String(skillId || ""));
}

function isListingSkill(skillId = "") {
  return LISTING_SKILL_RE.test(String(skillId || ""));
}

function isProductOpportunitySkill(skillId = "") {
  return PRODUCT_OPPORTUNITY_SKILL_RE.test(String(skillId || ""));
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

function hasValidGoogleSearchEvidence(result = {}) {
  if (!result || result.ok === false || result.error || result.isCaptcha) return false;
  const pageData = result.pageData || {};
  const pageHealth = pageData.pageHealth || {};
  if (pageHealth.isLikelyBlocked) return false;
  const text = [pageData.title, pageData.h1, pageData.visibleText, pageData.metaDescription].filter(Boolean).join("\n");
  return text.trim().length >= 80 || Array.isArray(pageData.productLinks) && pageData.productLinks.length > 0;
}

function getPlatformTrendEvidenceState(toolHistory = []) {
  const uniqueSearchKeys = new Set();
  const validSearchKeys = new Set();
  let etsySearches = 0;
  let googleSearches = 0;
  let googleTrendsSearches = 0;
  let validEtsySearches = 0;
  let validGoogleSearches = 0;
  let validGoogleTrendsSearches = 0;
  let googleTrendsScreenshots = 0;
  let searchCalls = 0;
  let failedSearchCalls = 0;
  let consecutiveSearchCalls = 0;

  for (let i = toolHistory.length - 1; i >= 0; i--) {
    if (toolHistory[i]?.tool === "search_in_browser") consecutiveSearchCalls++;
    else break;
  }

  toolHistory.forEach((entry) => {
    if (entry?.tool !== "search_in_browser") return;
    searchCalls++;
    const engine = String(entry.arguments?.engine || "google").toLowerCase();
    const key = searchEvidenceKey(entry.arguments || {});
    if (key) uniqueSearchKeys.add(key);
    let valid = false;
    if (engine === "etsy") {
      etsySearches++;
      valid = hasValidEtsySearchEvidence(entry.result || {});
      if (valid) validEtsySearches++;
    } else if (engine === "google_trends") {
      googleTrendsSearches++;
      valid = hasValidGoogleTrendsEvidence(entry.result || {});
      if (valid) validGoogleTrendsSearches++;
      if (entry.result?.screenshotRef || entry.result?.screenshotCaptured) googleTrendsScreenshots++;
    } else if (["google", "google_us", "google_ru"].includes(engine)) {
      googleSearches++;
      valid = hasValidGoogleSearchEvidence(entry.result || {});
      if (valid) validGoogleSearches++;
    }
    if (valid && key) validSearchKeys.add(key);
    if (!valid) failedSearchCalls++;
  });

  const competitorUrls = getOpenedEtsyCompetitorUrls(toolHistory);
  const listingDetails = getCompetitorListingDetailEvidence(toolHistory);
  const screenshotAnalysisDone = toolHistory.some((entry) =>
    entry?.tool === "analyze_etsy_shop_crawl_screenshots" &&
    entry.result?.ok !== false &&
    Number(entry.result?.screenshotsAnalyzed || 0) > 0
  );

  return {
    searchCalls,
    failedSearchCalls,
    consecutiveSearchCalls,
    uniqueSearches: uniqueSearchKeys.size,
    validSearches: validSearchKeys.size,
    etsySearches,
    googleSearches,
    googleTrendsSearches,
    validEtsySearches,
    validGoogleSearches,
    validGoogleTrendsSearches,
    googleTrendsScreenshots,
    competitorCount: competitorUrls.size,
    listingDetailCount: listingDetails.size,
    hasCompetitorCrawl: toolHistory.some((entry) => ["collect_etsy_shop_pages", "collect_etsy_competitor_shops"].includes(entry?.tool) && entry.result?.ok !== false),
    hasScreenshotAnalysis: screenshotAnalysisDone,
    searchStageComplete: validEtsySearches >= 1 && validGoogleSearches >= 1 && validGoogleTrendsSearches >= 1 && googleTrendsScreenshots >= 1,
  };
}

function getTrendCompetitorTargetsFromSearch(toolHistory = [], limit = 3) {
  const targets = [];
  const seen = new Set();
  const opened = getOpenedEtsyCompetitorUrls(toolHistory);
  const pushTarget = (url, name = "") => {
    const normalized = normalizeEtsyCompetitorUrl(url);
    if (!normalized || seen.has(normalized) || opened.has(normalized)) return;
    seen.add(normalized);
    targets.push({
      url,
      name: name || normalized,
      type: /\/shop\//i.test(normalized) ? "shop" : "listing",
    });
  };
  toolHistory.forEach((entry) => {
    if (entry?.tool !== "search_in_browser" || String(entry.arguments?.engine || "").toLowerCase() !== "etsy" || entry.result?.ok === false) return;
    const pageData = entry.result?.pageData || {};
    (Array.isArray(pageData.productCards) ? pageData.productCards : []).forEach((card) => {
      pushTarget(card.shopUrl || card.shop_url || card.href || card.listingUrl, card.shopName || card.title);
    });
    (Array.isArray(pageData.productLinks) ? pageData.productLinks : []).forEach((link) => {
      pushTarget(link.href, link.text || link.title);
    });
  });
  return targets.slice(0, limit);
}

function getPlatformTrendStageGuard({ toolName = "", toolArgs = {}, toolHistory = [] } = {}) {
  if (toolName !== "search_in_browser") return null;
  const state = getPlatformTrendEvidenceState(toolHistory);
  const engine = String(toolArgs.engine || "google").toLowerCase();
  const requestedKey = searchEvidenceKey(toolArgs);
  const searchRequestsExhausted = state.searchStageComplete || state.validEtsySearches >= 1 && state.validGoogleSearches >= 1 && engine !== "google_trends";

  if (state.searchStageComplete) {
    const targets = getTrendCompetitorTargetsFromSearch(toolHistory);
    const shopTargets = targets.filter((target) => target.type === "shop");
    const listingTargets = targets.filter((target) => target.type === "listing");
    if (!state.hasCompetitorCrawl && shopTargets.length > 0) {
      return {
        type: "redirect_tool_call",
        fromTool: toolName,
        toTool: "collect_etsy_competitor_shops",
        arguments: {
          competitors: shopTargets,
          maxPagesPerShop: 2,
          maxProductsPerPage: 24,
          maxDetailsPerShop: 2,
          deepDetail: true,
        },
        message: `趋势搜索阶段已完成（Etsy/Google/Trends 均有可用证据），不再继续搜索 ${requestedKey}；自动进入公开竞品店铺/商品详情采集。`,
        stageState: state,
      };
    }
    if (state.listingDetailCount < 2 && listingTargets.length > 0) {
      return {
        type: "redirect_tool_call",
        fromTool: toolName,
        toTool: "open_new_tab",
        arguments: {
          url: listingTargets[0].url,
          readDelayMs: 1800,
        },
        message: `趋势搜索阶段已完成，但尚缺竞品商品详情页证据；不再继续搜索 ${requestedKey}，自动打开高排名 listing 详情页读取 DOM 与截图。`,
        stageState: state,
      };
    }
    if (state.hasCompetitorCrawl && !state.hasScreenshotAnalysis) {
      return {
        type: "tool_error",
        tool: toolName,
        error: "趋势搜索和竞品分页采集已完成，下一步必须调用 analyze_etsy_shop_crawl_screenshots 解读已缓存截图，而不是继续 search_in_browser。",
        stageState: state,
      };
    }
    return {
      type: "tool_error",
      tool: toolName,
      error: "趋势搜索阶段已经满足最低证据闭环，继续搜索会造成节点循环。请基于已有 Etsy/Google/Google Trends/竞品证据输出 final；若缺失项存在，必须说明 blocked，而不是继续泛搜索。",
      stageState: state,
    };
  }

  if (state.consecutiveSearchCalls >= 6 || state.searchCalls >= 12 || state.failedSearchCalls >= 4 || searchRequestsExhausted) {
    return {
      type: "tool_error",
      tool: toolName,
      error: "趋势任务已出现连续搜索循环，但尚未形成下一阶段动作。请停止扩展关键词，转入缺失证据阶段：若已有 Etsy 搜索候选，采集竞品详情/店铺页；若 Google Trends 缺截图，修复 Trends 取证；若证据被阻断，输出 blocked 说明。",
      requestedSearch: requestedKey,
      stageState: state,
    };
  }

  return null;
}

function compactPlatformTrendRunawayToolHistory(toolHistory = []) {
  const state = getPlatformTrendEvidenceState(toolHistory);
  const shouldCompact = state.searchCalls >= 24 || state.consecutiveSearchCalls >= 8;
  if (!shouldCompact) return { changed: false, toolHistory, state };

  const kept = [];
  const bestSearchByKey = new Map();
  const failedSearchSamples = [];

  toolHistory.forEach((entry, index) => {
    if (entry?.tool !== "search_in_browser") {
      kept.push(entry);
      return;
    }
    const key = searchEvidenceKey(entry.arguments || {}) || `search:${index}`;
    const existing = bestSearchByKey.get(key);
    const result = entry.result || {};
    const isValid =
      String(entry.arguments?.engine || "").toLowerCase() === "etsy"
        ? hasValidEtsySearchEvidence(result)
        : String(entry.arguments?.engine || "").toLowerCase() === "google_trends"
        ? hasValidGoogleTrendsEvidence(result)
        : hasValidGoogleSearchEvidence(result);
    const score = [
      isValid ? 100 : 0,
      result.screenshotRef || result.screenshotCaptured ? 20 : 0,
      result.pageData?.productCards?.length ? 10 : 0,
      result.pageData?.visibleText ? Math.min(8, Math.floor(String(result.pageData.visibleText).length / 120)) : 0,
      index / 100000,
    ].reduce((sum, value) => sum + value, 0);
    if (!existing || score > existing.score) {
      bestSearchByKey.set(key, { entry, score, isValid });
    }
    if (!isValid && failedSearchSamples.length < 4) {
      failedSearchSamples.push({
        tool: entry.tool,
        arguments: entry.arguments,
        result: {
          ok: false,
          evidenceStatus: result.evidenceStatus || "invalid_or_blocked",
          searchUrl: result.searchUrl || result.pageData?.url || "",
          message: result.message || result.error || "",
        },
      });
    }
  });

  const searchEntries = Array.from(bestSearchByKey.values())
    .sort((a, b) => {
      const aValid = a.isValid ? 0 : 1;
      const bValid = b.isValid ? 0 : 1;
      return aValid - bValid || b.score - a.score;
    })
    .slice(0, 18)
    .map((item) => item.entry);

  const compactedState = getPlatformTrendEvidenceState([...kept, ...searchEntries]);
  const summaryEntry = {
    tool: "workflow_stage_summary",
    arguments: { skill: "etsy_platform_trends", reason: "runaway_search_history_compacted" },
    result: {
      ok: true,
      summaryType: "platform_trend_runaway_search_compaction",
      originalSearchCalls: state.searchCalls,
      keptSearchCalls: searchEntries.length,
      removedSearchCalls: Math.max(0, state.searchCalls - searchEntries.length),
      originalState: state,
      compactedState,
      failedSearchSamples,
      nextStep: compactedState.searchStageComplete
        ? "Search evidence is complete; move to competitor page/detail collection, screenshot analysis, or final."
        : "Repair the missing evidence stage without repeating already compacted search attempts.",
    },
  };

  return {
    changed: true,
    removedSearchCalls: Math.max(0, state.searchCalls - searchEntries.length),
    state,
    compactedState,
    toolHistory: [summaryEntry, ...kept, ...searchEntries],
  };
}

function getEtsyBrowserWorkflowGuardResult({ skillId = "", toolName = "", toolArgs = {}, toolHistory = [] } = {}) {
  if (!isEtsyBusinessSkill(skillId)) return null;
  if (isPlatformTrendSkill(skillId) && toolName === "search_in_browser") {
    const stageGuard = getPlatformTrendStageGuard({ toolName, toolArgs, toolHistory });
    if (stageGuard) return stageGuard;
  }
  if (toolName === "search_in_browser" && !isSourcingSkill(skillId)) {
    const requestKey = searchEvidenceKey(toolArgs);
    const duplicate = toolHistory.find((entry) => {
      if (entry?.tool !== "search_in_browser" || entry?.result?.ok === false || entry?.result?.error) return false;
      return searchEvidenceKey(entry.arguments || {}) === requestKey;
    });
    if (duplicate) {
      return {
        type: "reuse_tool_result",
        tool: toolName,
        message: `该搜索证据已完成，本次不再打开新标签页，直接复用已有搜索证据：${requestKey}。请转入下一项尚未完成的证据阶段或输出 final。`,
        reusedEvidence: true,
        originalTool: duplicate.tool,
        originalArguments: duplicate.arguments,
        reusedResult: {
          ...(duplicate.result || {}),
          reusedEvidence: true,
          reusedFromSearchKey: requestKey,
          message: duplicate.result?.message || "Reused prior successful search evidence for this workflow.",
        },
        previousSearch: {
          engine: String(duplicate.arguments?.engine || "google").toLowerCase(),
          query: normalizeSearchQueryForWorkflow(duplicate.arguments?.query || duplicate.arguments?.keyword || ""),
          searchType: String(duplicate.arguments?.searchType || "listing").toLowerCase(),
          evidenceOk: duplicate.result?.evidenceOk !== false,
          searchUrl: duplicate.result?.searchUrl || duplicate.result?.pageData?.url || "",
        },
      };
    }
  }
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

function describeToolAction(toolName = "", toolArgs = {}, toolResult = null) {
  const engine = String(toolArgs.engine || "").toLowerCase();
  const url = String(toolArgs.url || toolResult?.finalUrl || toolResult?.url || toolResult?.pageData?.url || "");
  if (toolName === "search_in_browser") {
    if (engine === "etsy") return { actionKind: "search_results", actionLabel: "Etsy 搜索结果页取证", lifecycle: "搜索页在保存页面文本和截图证据后会自动关闭" };
    if (engine === "google_trends") return { actionKind: "trend_chart", actionLabel: "Google Trends 趋势图取证", lifecycle: "趋势页在保存截图证据后会自动关闭" };
    if (engine === "google" || engine === "google_us") return { actionKind: "web_search", actionLabel: "Google Search 结果页取证", lifecycle: "搜索页在保存页面文本和截图证据后会自动关闭" };
    if (engine === "1688" || engine === "taobao") return { actionKind: "sourcing_search", actionLabel: "采购平台搜索结果页取证", lifecycle: "平台页可能保留用于人工验证或继续筛选" };
    return { actionKind: "browser_search", actionLabel: "浏览器搜索取证", lifecycle: "临时搜索页可能在证据保存后自动关闭" };
  }
  if (toolName === "open_new_tab") {
    if (/etsy\.com\/listing\//i.test(url)) return { actionKind: "listing_detail", actionLabel: "Etsy 商品详情页取证", lifecycle: "详情页会保持打开，除非后续显式关闭或工具超时回收" };
    if (/etsy\.com\/shop\//i.test(url)) return { actionKind: "shop_detail", actionLabel: "Etsy 店铺页取证", lifecycle: "店铺页会保持打开，用于后续分页采集或截图分析" };
    return { actionKind: "detail_page", actionLabel: "详情页取证", lifecycle: "详情页会保持打开，除非后续显式关闭或工具超时回收" };
  }
  if (toolName === "collect_etsy_shop_pages") return { actionKind: "shop_pagination_crawl", actionLabel: "Etsy 店铺分页商品采集", lifecycle: "分页采集会打开页面、保存 DOM/截图/商品卡片后关闭临时页" };
  if (toolName === "collect_etsy_competitor_shops") return { actionKind: "competitor_shop_crawl", actionLabel: "竞品店铺批量采集", lifecycle: "批量采集会分页读取竞品店铺、详情页和截图证据" };
  if (toolName === "analyze_etsy_shop_crawl_screenshots") return { actionKind: "screenshot_interpretation", actionLabel: "店铺截图独立解读", lifecycle: "不打开新标签页，只分析已缓存截图 artifact" };
  if (toolName === "close_tab") return { actionKind: "tab_close", actionLabel: "关闭已完成取证的标签页", lifecycle: "关闭由 workflow 创建或指定的标签页" };
  return { actionKind: toolName || "tool", actionLabel: toolName || "工具执行", lifecycle: "" };
}

async function runToolWithTimeout(toolName, toolArgs) {
  const timeoutMs = getToolTimeoutMs(toolName);
  let timeoutId = null;
  const key = toolRunKey(toolName, toolArgs);
  let operation = inFlightToolRuns.get(key);
  if (!operation) {
    operation = Promise.resolve()
      .then(() => tools[toolName](toolArgs))
      .finally(() => {
        if (inFlightToolRuns.get(key) === operation) inFlightToolRuns.delete(key);
      });
    inFlightToolRuns.set(key, operation);
  }
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timeoutId = setTimeout(async () => {
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
      entry.tool === "search_in_browser" && String(entry.arguments?.engine || "").toLowerCase() === "google_trends" && hasValidGoogleTrendsEvidence(entry.result)
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

function getGoogleTrendsScreenshotEvidence(toolHistory = []) {
  for (let i = toolHistory.length - 1; i >= 0; i--) {
    const entry = toolHistory[i];
    if (entry?.tool !== "search_in_browser") continue;
    if (String(entry.arguments?.engine || "").toLowerCase() !== "google_trends") continue;
    if (!hasValidGoogleTrendsEvidence(entry.result || {})) continue;
    if (!entry.result?.screenshotRef && !entry.result?.screenshotCaptured) continue;
    return {
      query: entry.arguments?.query || entry.arguments?.keyword || entry.result?.queryUsed || "",
      sourceRef: entry.result?.screenshotRef || entry.result?.searchUrl || entry.result?.pageData?.url || "Google Trends screenshot artifact",
      searchUrl: entry.result?.searchUrl || entry.result?.pageData?.url || "",
      captureMode: entry.result?.screenshotCaptureMode || "unknown",
      observedValue: [
        "Google Trends 页面已读取并保存趋势图截图 artifact。",
        entry.result?.pageData?.visibleText ? `页面可见文本包含：${truncateText(entry.result.pageData.visibleText, 220)}` : "",
      ].filter(Boolean).join(" "),
    };
  }
  return null;
}

function buildGoogleTrendsScreenshotLedgerEntry(evidence = {}) {
  const queryText = evidence.query ? `查询词：${evidence.query}；` : "";
  const urlText = evidence.searchUrl ? `页面：${evidence.searchUrl}；` : "";
  return {
    source_type: "screenshot_visual",
    source_ref: `Google Trends 截图 ${evidence.sourceRef || evidence.searchUrl || ""}`.trim(),
    observed_value: `${queryText}${urlText}已取得 Google Trends 趋势图截图，需基于截图记录地区 US、近 12 个月时间范围、Interest over time 曲线、related queries/topics 和图表可见局限。${evidence.observedValue || ""}`,
    used_for: "支撑趋势/季节性/需求曲线相关结论，并约束报告只能描述截图可见趋势，不得推断真实搜索量或 Etsy 订单。",
    confidence: "medium",
    limitation: `截图捕获方式 ${evidence.captureMode || "unknown"}；Google Trends 是相对热度，不等于 Etsy 平台搜索量、点击率、订单或转化率。`,
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
  const trendsScreenshotEvidence = getGoogleTrendsScreenshotEvidence(toolHistory);
  const reportText = `${repaired.output.overview || ""}\n${repaired.output.analysis || ""}\n${repaired.output.summary || ""}\n${JSON.stringify(repaired.output.data || [])}`;
  const reportUsesTrends = /Google Trends|谷歌趋势|趋势图|搜索趋势|搜索热度|季节性|需求曲线|Interest over time|related queries|related topics|峰值|peak/i.test(reportText);

  repaired.output.data.forEach((item, idx) => {
    if (!item || typeof item !== "object") return;
    const ledger = ensureArrayField(item, "evidence_ledger");
    let itemChanged = false;

    if (shouldAutoAttachPageDom && !hasLedgerType(ledger, "page_dom")) {
      ledger.unshift(buildPageDomLedgerEntry(pageDomEvidence));
      itemChanged = true;
    }

    const itemUsesTrends = reportUsesTrends || /Google Trends|谷歌趋势|趋势图|搜索趋势|搜索热度|季节性|需求曲线|Interest over time|related queries|related topics|峰值|peak/i.test(JSON.stringify(item));
    if (isPlatformTrendSkill(skillId) && itemUsesTrends && trendsScreenshotEvidence && !hasTrendVisualForTrends(ledger)) {
      ledger.push(buildGoogleTrendsScreenshotLedgerEntry(trendsScreenshotEvidence));
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
      reasons.push(`第 ${idx + 1} 项已补齐页面文本/Google Trends 截图证据或降级 API/订单/履约类假设`);
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

const KEYWORD_VOLUME_CLAIM_RE = /^\s*\d+(?:[,.]\d+)*(?:\s*[-–—到至]\s*\d+(?:[,.]\d+)*)?\s*$|高频|高搜索|搜索量高|热度高|high\s+volume|large\s+volume|popular/i;
const TREND_OR_SEASONAL_RE = /Google Trends|谷歌趋势|趋势图|季节|旺季|淡季|峰值|搜索热度|需求曲线|Interest over time|related queries|related topics|YoY|QoQ|trend|seasonal|peak/i;
const SEO_OR_KEYWORD_RE = /SEO|关键词|搜索词|高频词|标题|标签|tags?|keyword|listing title|属性|attribute/i;
const SENSITIVE_LISTING_RE = /儿童|婴幼儿|玩具|化妆品|护肤|食品接触|餐具|电器|插头|电池|充电|药品|医疗|品牌|迪士尼|Disney|Marvel|Pokemon|Nike|LV|Chanel|商标|版权|角色|children|kids|toy|cosmetic|skin.?care|food contact|electrical|battery|medical|brand|trademark|copyright|character/i;
const DIRECT_PUBLISH_RE = /可直接发布|直接上架|立即发布|ready to publish|publish-ready|直接投放/i;
const OPPORTUNITY_STRONG_CLAIM_RE = /蓝海|爆品|高增长|低竞争|需求旺盛|强需求|高毛利|高潜力|机会评分|potential_score|opportunity_score|blue ocean|best.?seller|爆款|winning product|high growth|low competition|strong demand/i;
const MARKET_SCOPE_OVERCLAIM_RE = /全市场|全平台|完整市场|完整价格分布|全部竞品|所有竞品|主要竞品均|头部竞品均|complete market|full market|entire market|complete price distribution/i;
const LOGISTICS_EXACT_CLAIM_RE = /\b\d+\s*[-–—到至]\s*\d+\s*(个)?\s*(工作日|日|天|business days?|days?)\b|运费\s*[$¥€]?\s*\d+|shipping cost\s*[$¥€]?\s*\d+/i;
const OFFICIAL_CERT_RE = /\b(?:CE|CPC|FDA|FCC|RoHS|REACH)\b/i;

function hasTrendScreenshotLedger(ledger = []) {
  return hasTrendVisualForTrends(ledger) || hasTrendsVisualLedger(ledger);
}

function itemLedger(item = {}) {
  return Array.isArray(item?.evidence_ledger) ? item.evidence_ledger : [];
}

function validateKeywordReport(out, toolHistory = [], pageContext = {}) {
  const errors = [];
  const items = Array.isArray(out.data) ? out.data : [];
  if (items.length === 0) return ["关键词分析报告不能返回空 data；每个关键词实体必须包含 keyword/intent/competition/estimated_volume 与 evidence_ledger。"];
  const allLedger = items.flatMap(itemLedger);
  if (!hasAnyLedgerType(allLedger, ["page_dom", "etsy_search"])) {
    errors.push("关键词分析缺少页面文本或 Etsy 搜索证据。不能只凭模型常识输出 SEO 词、标签或标题公式。");
  }
  items.forEach((item, idx) => {
    const label = `关键词分析第 ${idx + 1} 项`;
    const ledger = itemLedger(item);
    const itemText = JSON.stringify(item || {});
    const tags = Array.isArray(item?.etsy_tags) ? item.etsy_tags : Array.isArray(item?.tags) ? item.tags : [];
    errors.push(...validateEvidenceLedgerEntries({
      entries: ledger,
      label,
      toolHistory,
      pageContext,
      allowedTypes: ["page_dom", "screenshot_visual", "etsy_search", "google_search", "google_trends", "etsy_api", "user_input", "assumption"],
    }));
    if (!hasValue(item?.keyword || item?.title || item?.name)) errors.push(`${label} 缺少 keyword/title/name，无法和报告表格同步展示。`);
    if (tags.length > 13) errors.push(`${label} 输出了 ${tags.length} 个 Etsy tags，超过 Etsy Listing 最多 13 个标签的硬限制。`);
    if (KEYWORD_VOLUME_CLAIM_RE.test(String(item?.estimated_volume || item?.volume || "")) && !hasAnyLedgerType(ledger, ["google_trends", "google_search", "etsy_api"])) {
      errors.push(`${label} 输出了搜索量/高频词强判断，但没有 Google Trends/Google Search/API 证据；Etsy 个人 API 不提供平台搜索量，无法取得时必须写“未取得/待验证”。`);
    }
    if (/高频|高搜索|搜索量高|high\s+volume/i.test(itemText) && !hasAnyLedgerType(ledger, ["google_trends", "google_search"]) && !/未取得|待验证|无法确认|不可用|not available|unavailable/i.test(itemText)) {
      errors.push(`${label} 把关键词写成高频/高搜索，但没有站外或趋势证据。`);
    }
    if (TREND_OR_SEASONAL_RE.test(itemText) && (!hasLedgerType(ledger, "google_trends") || !hasTrendScreenshotLedger(ledger))) {
      errors.push(`${label} 使用趋势/季节性结论时必须包含 google_trends 证据和 Google Trends 截图视觉解读。`);
    }
  });
  return errors;
}

function validateListingReport(out, toolHistory = [], pageContext = {}) {
  const errors = [];
  const items = Array.isArray(out.data) ? out.data : [];
  if (items.length === 0) return ["Listing 生成报告不能返回空 data；至少需要一个标题/标签/属性/描述方案，并绑定 evidence_ledger。"];
  const allLedger = items.flatMap(itemLedger);
  if (!hasAnyLedgerType(allLedger, ["page_dom", "user_input", "supplier_page"])) {
    errors.push("Listing 生成缺少当前商品页面、用户提供资料或供应商资料证据。不能只凭一句需求生成可发布 Listing。");
  }
  if (!hasAnyLedgerType(allLedger, ["etsy_search", "page_dom", "user_input"]) && SEO_OR_KEYWORD_RE.test(`${out.overview || ""}\n${out.analysis || ""}\n${JSON.stringify(items)}`)) {
    errors.push("Listing 的 SEO 标题、标签或关键词建议缺少 Etsy 搜索/竞品 Listing/页面文本证据；没有证据时只能标记为待验证。");
  }
  items.forEach((item, idx) => {
    const label = `Listing 方案第 ${idx + 1} 项`;
    const ledger = itemLedger(item);
    const itemText = JSON.stringify(item || {});
    const tags = Array.isArray(item?.etsy_tags) ? item.etsy_tags : Array.isArray(item?.tags) ? item.tags : [];
    errors.push(...validateEvidenceLedgerEntries({
      entries: ledger,
      label,
      toolHistory,
      pageContext,
      allowedTypes: ["page_dom", "screenshot_visual", "etsy_search", "google_search", "google_trends", "supplier_page", "official_policy", "official_regulation", "user_input", "assumption"],
    }));
    if (tags.length > 13) errors.push(`${label} 输出了 ${tags.length} 个 Etsy tags，超过 Etsy Listing 最多 13 个标签的硬限制。`);
    if (/已填写|confirmed|verified|已确认|确定属性/i.test(itemText) && !hasAnyLedgerType(ledger, ["page_dom", "user_input", "supplier_page"])) {
      errors.push(`${label} 把属性写成已填写/已确认，但没有页面、用户输入或供应商事实证据。模型补全只能标记为待确认。`);
    }
    if (/estimated_volume|搜索量|竞争强度|季节|偏好集中|高频|热度/i.test(itemText) && !hasAnyLedgerType(ledger, ["etsy_search", "google_search", "google_trends"]) && !hasAssumptionFallback(ledger, /搜索量|竞争|季节|偏好|未取得|待验证/i)) {
      errors.push(`${label} 输出搜索量、竞争强度、季节性或买家偏好，但没有 Etsy/Google/Trends 证据。`);
    }
    if (SENSITIVE_LISTING_RE.test(itemText) && DIRECT_PUBLISH_RE.test(itemText) && !hasAnyLedgerType(ledger, ["official_policy", "official_regulation"]) && !hasAssumptionFallback(ledger, /合规|认证|商标|版权|发布|blocked|待验证/i)) {
      errors.push(`${label} 涉及儿童/化妆品/电器/电池/食品接触/IP 等敏感风险，却写成可直接发布；必须先完成合规审查或标记 proceed_after_evidence/blocked。`);
    }
  });
  return errors;
}

function validateProductOpportunityReport(out, toolHistory = [], pageContext = {}) {
  const errors = [];
  const items = Array.isArray(out.data) ? out.data : [];
  if (items.length === 0) return ["选品/机会探索报告不能返回空 data；至少需要一个机会项或明确阻断项，并绑定 evidence_ledger。"];
  items.forEach((item, idx) => {
    const label = `机会探索第 ${idx + 1} 项`;
    const ledger = itemLedger(item);
    const itemText = JSON.stringify(item || {});
    errors.push(...validateEvidenceLedgerEntries({
      entries: ledger,
      label,
      toolHistory,
      pageContext,
      allowedTypes: ["page_dom", "screenshot_visual", "etsy_search", "google_search", "google_trends", "etsy_api", "official_policy", "official_regulation", "user_input", "assumption"],
    }));
    if (OPPORTUNITY_STRONG_CLAIM_RE.test(itemText) && !hasAnyLedgerType(ledger, ["etsy_search", "google_search", "google_trends", "page_dom"]) && !hasAssumptionFallback(ledger, /机会|需求|竞争|趋势|待验证|未取得/i)) {
      errors.push(`${label} 输出蓝海/爆品/高增长/低竞争/机会评分等强结论，但没有 Etsy/Google/Trends/页面证据。`);
    }
    if (hasValue(item?.potential_score || item?.opportunity_score || item?.score) && ledger.length === 0) {
      errors.push(`${label} 有机会评分但没有 evidence_ledger；评分必须能追溯到需求、竞争、价格、物流、合规和评论样本。`);
    }
    if (MARKET_SCOPE_OVERCLAIM_RE.test(itemText) && !/样本|第一页|可见|sample|visible|limitation|局限/i.test(itemText)) {
      errors.push(`${label} 把可见搜索/店铺样本写成全市场或完整价格分布。Search Grid 只能代表本轮可见样本，必须写 sample_count/coverage/limitation。`);
    }
    if ((LOGISTICS_EXACT_CLAIM_RE.test(itemText) || /物流|配送|shipping|delivery|transit/i.test(itemText)) && !hasLedgerTypeTopic(ledger, ["google_search"], /配送|物流|发货|运输|时效|delivery|shipping|transit|fulfillment|USPS|DHL|FedEx|UPS|postal/i) && !hasAssumptionFallback(ledger, /物流|配送|shipping|delivery|transit|待验证|未取得/i)) {
      errors.push(`${label} 输出物流时效/成本判断，但没有实时物流主题搜索证据；跨国运输不能凭模型常识承诺。`);
    }
    if (OFFICIAL_CERT_RE.test(itemText) && !hasAnyLedgerType(ledger, ["official_policy", "official_regulation"]) && !hasAssumptionFallback(ledger, /CE|CPC|FDA|FCC|RoHS|REACH|认证|法规|待验证/i)) {
      errors.push(`${label} 引用了 CE/CPC/FDA/FCC/RoHS/REACH，但没有官方来源证据或明确待验证降级。`);
    }
    if (/采购|拿样|备货|上架|发布|扩大销售|purchase|source\s+this|launch\s+this|start\s+selling/i.test(itemText) && !/合规|compliance|审查|proceed_after_evidence|blocked|待验证/i.test(itemText)) {
      errors.push(`${label} 推荐采购/上架/扩大销售前缺少合规下一步；机会评分不能替代合规许可。`);
    }
    if (/评论|差评|review|buyer feedback|痛点|抱怨/i.test(itemText) && !hasAnyLedgerType(ledger, ["page_dom", "screenshot_visual", "etsy_search"]) && !hasAssumptionFallback(ledger, /评论|差评|review|痛点|样本|待验证/i)) {
      errors.push(`${label} 使用评论痛点或买家反馈，但没有评论/页面/搜索样本证据。`);
    }
  });
  return errors;
}

const TREND_FORBIDDEN_PRIVATE_DATA_RE = /(?:竞品\s*(?:转化率|conversion|sessions?|订单|销售额|流量|加购率)|(?:竞品|其他店铺|平台)\s*(?:后台|analytics|分析数据)|(?:拉取|读取|获取|对比).{0,18}(?:竞品|其他店铺).{0,18}(?:API|订单|转化|sessions?|流量)|(?:平台|全平台)\s*(?:搜索量|搜索指数|analytics|流量|订单))/i;
const TREND_STRONG_CLAIM_RE = /完整(?:市场|全平台)?(?:价格|商品|SKU)?(?:分布|数据)|全平台|全市场|主要竞品|头部竞品(?:均|都)|需求旺盛|显著峰值|点击率更高|转化率更高|买家(?:普遍|常见|集中)反馈|评论区常见|["“']?7\s*[-–—到至]\s*12\s*(?:个)?\s*(?:工作日|日|天)|香港发货.{0,18}\d+\s*[-–—到至]\s*\d+\s*(?:个)?\s*(?:工作日|日|天)|full market|entire market|complete price distribution|higher CTR|higher conversion|common buyer feedback|significant peak|strong demand/i;
const TREND_LOGISTICS_RE = /配送|物流|发货|运输|时效|工作日|delivery|shipping|transit|fulfillment/i;
const TREND_CERTIFICATION_RE = /\b(?:CE|CPC|FDA|FCC|RoHS|REACH)\b/i;

function trendLedgerText(entries = []) {
  return entries.map((entry) => [
    entry?.source_ref,
    entry?.observed_value,
    entry?.used_for,
    entry?.limitation,
  ].filter(Boolean).join(" ")).join(" ");
}

function hasTrendSampleScope(item = {}) {
  const coverage = item?.coverage || item?.sample_scope || item?.sampleCoverage;
  const sampleCount = item?.sample_count ?? item?.sampleCount;
  return Number.isFinite(Number(sampleCount)) && Number(sampleCount) > 0 && hasValue(coverage) &&
    (hasValue(item?.limitation) || hasValue(item?.evidence_limitation));
}

function hasTrendCompetitorPageEvidence(ledger = []) {
  const refs = new Set();
  ledger.forEach((entry) => {
    const sourceType = String(entry?.source_type || "").toLowerCase();
    if (!['page_dom', 'screenshot_visual'].includes(sourceType)) return;
    const text = [entry?.source_ref, entry?.observed_value, entry?.used_for].filter(Boolean).join(" ");
    if (!/competitor|竞品|店铺|shop|listing|商品详情|高排名|best[-\s]?seller|top shop/i.test(text)) return;
    const url = String(entry?.source_ref || "").match(/https?:\/\/[^\s)]+/i)?.[0];
    refs.add(url || text.slice(0, 160));
  });
  return refs.size >= 2;
}

function hasTrendVisualForTrends(ledger = []) {
  return ledger.some((entry) => {
    if (String(entry?.source_type || "").toLowerCase() !== "screenshot_visual") return false;
    return /Google Trends|trends\.google|Interest over time|related queries|related topics|趋势图|需求曲线|季节性/i.test(
      [entry?.source_ref, entry?.observed_value, entry?.used_for, entry?.limitation].filter(Boolean).join(" ")
    );
  });
}

function hasPositiveUnsupportedPrivateDataClaim(text = "") {
  return String(text || "").split(/[。！？!?.\n]/).some((sentence) =>
    TREND_FORBIDDEN_PRIVATE_DATA_RE.test(sentence) &&
    !/不能|不可|不包含|不等于|未取得|未获取|未读取|无法|禁止|不得|not available|unavailable|cannot|no access|不支持/i.test(sentence)
  );
}

function validatePlatformTrendReport(out, toolHistory = [], pageContext = {}) {
  const errors = [];
  const items = Array.isArray(out.data) ? out.data : [];
  const fullText = `${out.overview || ""}\n${out.analysis || ""}\n${out.summary || ""}\n${JSON.stringify(items)}`;
  const allLedger = items.flatMap((item) => Array.isArray(item?.evidence_ledger) ? item.evidence_ledger : []);

  if (items.length === 0) return ["Etsy 趋势报告至少需要一个结构化机会项，不能返回空 data。"];
  if (hasPositiveUnsupportedPrivateDataClaim(fullText)) {
    errors.push("趋势报告引用了竞品后台、竞品订单/转化率或平台搜索量等不可得数据。Etsy 个人卖家 API 只能读取当前授权自营店铺；竞品和平台趋势必须使用公开页面、Etsy 搜索、Google Search 或 Google Trends。");
  }
  if (!hasLedgerType(allLedger, "etsy_search")) {
    errors.push("趋势报告缺少 Etsy 公开搜索证据。Search Grid 只能作为本轮可见样本，必须先完成真实 Etsy 搜索并记录查询口径。");
  }

  const usesTrend = /Google Trends|谷歌趋势|趋势图|搜索趋势|搜索热度|季节性|需求曲线|Interest over time|related queries|related topics|峰值|peak/i.test(fullText);
  if (usesTrend && !hasLedgerType(allLedger, "google_trends")) {
    errors.push("报告使用了 Google Trends/季节性/需求曲线结论，但 evidence_ledger 缺少 google_trends 工具证据。");
  }
  if (usesTrend && !hasTrendVisualForTrends(allLedger)) {
    errors.push("报告使用了趋势或季节性结论，但没有 Google Trends 截图视觉解读。必须记录地区、时间范围、查询词、曲线方向、related queries/topics 和截图局限。");
  }
  if (/Google Search|谷歌搜索|站外搜索|搜索结果|欧美市场|市场调研/i.test(fullText) && !hasLedgerType(allLedger, "google_search")) {
    errors.push("报告使用了 Google Search/站外市场结论，但 evidence_ledger 缺少 google_search 证据。");
  }
  if (TREND_CERTIFICATION_RE.test(fullText) && !hasAnyLedgerType(allLedger, ["official_policy", "official_regulation"]) && !hasAssumptionFallback(allLedger, /CE|CPC|FDA|FCC|RoHS|REACH/i)) {
    errors.push("趋势报告引用 CE/CPC/FDA/FCC/RoHS/REACH，但没有官方法规/平台政策证据，也没有明确降级为待验证假设；不能把普通婚礼手拿包默认绑定这些认证。");
  }

  items.forEach((item, idx) => {
    const label = `趋势机会第 ${idx + 1} 项`;
    const requiredFields = [
      "opportunity_id", "keyword_or_category", "buyer_scenario", "price_band",
      "demand_signal", "seasonality", "competitor_signal", "next_validation_action",
      "evidence", "evidence_ledger",
    ];
    requiredFields.forEach((field) => {
      if (field === "evidence_ledger" ? !Array.isArray(item?.[field]) || item[field].length === 0 : !hasValue(item?.[field])) {
        errors.push(`${label} 缺少必填结构化字段 ${field}。报告和对话必须使用同一份结构化数据，不能只输出叙述性建议。`);
      }
    });
    const priceBand = item?.price_band;
    if (!priceBand || !hasValue(priceBand.min) || !hasValue(priceBand.max) || !hasValue(priceBand.basis)) {
      errors.push(`${label} 的 price_band 必须包含 min、max 和 basis，并明确是公开可见样本价格，不得冒充全平台分布。`);
    }
    if (!["observed", "assumption", "blocked"].includes(String(item?.demand_signal || "").toLowerCase())) {
      errors.push(`${label} 的 demand_signal 只能是 observed、assumption 或 blocked。`);
    }
    if (!hasTrendSampleScope(item)) {
      errors.push(`${label} 缺少 sample_count、coverage 和 limitation。只有少量搜索卡片时必须明确样本量、覆盖范围和局限，不能写成完整市场价格带或全平台结论。`);
    }
    const ledger = Array.isArray(item?.evidence_ledger) ? item.evidence_ledger : [];
    errors.push(...validateEvidenceLedgerEntries({
      entries: ledger,
      label,
      toolHistory,
      pageContext,
      allowedTypes: ["page_dom", "screenshot_visual", "etsy_search", "google_search", "google_trends", "official_policy", "official_regulation", "user_input", "assumption"],
    }));
    const itemText = JSON.stringify(item);
    if (TREND_STRONG_CLAIM_RE.test(itemText) && !hasTrendSampleScope(item)) {
      errors.push(`${label} 使用了超出样本覆盖能力的强结论；请改为“本轮公开样本观察”并写明样本量、覆盖范围和局限。`);
    }
    if (/点击率|CTR|转化率|conversion|加购率|click.?through/i.test(itemText) && !/实验|真实指标|待验证|assumption|不可得|无法读取|下一步.{0,30}(?:观察|验证|测试)/i.test(itemText)) {
      errors.push(`${label} 把点击率/转化率/加购率写成已验证事实，但公开搜索页不能证明这些指标；必须改为视觉假设或安排后续真实指标实验。`);
    }
    if (/评论区常见|买家普遍|买家集中|评论.{0,8}(痛点|反馈)|common buyer feedback|frequent complaint/i.test(itemText) && !hasLedgerType(ledger, "page_dom") && !hasLedgerType(ledger, "screenshot_visual")) {
      errors.push(`${label} 使用了评论痛点/买家反馈结论，但没有真实评论页面或截图证据；不能用模型常识替代评论采集。`);
    }
    if (TREND_LOGISTICS_RE.test(itemText) && /\d+\s*[-–—到至]\s*\d+\s*(?:个)?\s*(?:工作日|日|天|business days?|days?)/i.test(itemText)) {
      const shippingLedger = ledger.filter((entry) => String(entry?.source_type || "").toLowerCase() === "google_search" && /发货地|目的地|承运商|运输方式|物流|shipping|delivery|carrier|origin|destination/i.test(trendLedgerText([entry])));
      if (shippingLedger.length === 0) errors.push(`${label} 输出具体物流天数，但缺少包含发货地、目的地、承运商/运输方式和查询日期的实时物流搜索证据。`);
    }
    if (/竞品|头部|高排名|竞品视觉|主图|best.?seller|top shop/i.test(itemText) && !hasTrendCompetitorPageEvidence(ledger)) {
      errors.push(`${label} 使用了竞品/视觉对标结论，但没有至少 2 个公开竞品店铺或商品详情页的页面文本+截图证据；Search Grid 不能替代详情页研究。`);
    }
  });
  return errors;
}

function validatePlatformTrendToolResult(toolName, toolArgs = {}, toolResult = {}) {
  const errors = [];
  const engine = String(toolArgs.engine || "").toLowerCase();
  if (toolName === "search_in_browser") {
    if (engine === "etsy" && !hasValidEtsySearchEvidence(toolResult)) {
      errors.push("Etsy 搜索结果没有通过可用证据校验，未获得可验证的商品/店铺卡片或页面文本。");
    }
    if (engine === "google_trends" && !hasValidGoogleTrendsEvidence(toolResult)) {
      errors.push("Google Trends 页面没有通过可用证据校验，未获得可验证的趋势页面内容。");
    }
    if (engine === "google_trends" && !toolResult?.screenshotRef && !toolResult?.screenshotCaptured) {
      errors.push("Google Trends 搜索没有形成截图 artifact，不能进入趋势图视觉解读或季节性结论阶段。");
    }
    if (["google", "google_us", "google_ru"].includes(engine)) {
      const pageData = toolResult?.pageData || {};
      if (toolResult?.ok === false || String(pageData.visibleText || "").trim().length < 80) {
        errors.push("Google Search 页面内容不足，不能把空页面或搜索失败当成站外证据。");
      }
    }
  }
  if (["collect_etsy_shop_pages", "collect_etsy_competitor_shops"].includes(toolName)) {
    const pages = toolName === "collect_etsy_competitor_shops" ? toolResult?.allPages : toolResult?.pages;
    if (toolResult?.ok === false || !Array.isArray(pages) || pages.length === 0) {
      errors.push("Etsy 店铺采集没有返回可分析的分页结果，不能进入趋势综合阶段。");
    } else if (pages.every((page) => !page?.screenshotRef) && pages.every((page) => !page?.screenshotCaptured)) {
      errors.push("Etsy 店铺分页没有形成截图 artifact，不能进入视觉分析阶段。");
    }
  }
  if (toolName === "analyze_etsy_shop_crawl_screenshots") {
    if (toolResult?.ok === false || Number(toolResult?.screenshotsAnalyzed || 0) < 1 || !Array.isArray(toolResult?.stage_observations) || !toolResult?.stage_synthesis || !toolResult?.stage_report_inputs) {
      errors.push("截图分析没有完成 observations、synthesis 和 report_inputs 三阶段输出，不能把未完成视觉分析交给报告阶段。");
    }
  }
  if (toolName === "open_new_tab" && /etsy\.com/i.test(String(toolResult?.url || toolResult?.finalUrl || toolArgs.url || "")) && toolResult?.evidenceOk !== true) {
    errors.push("Etsy 详情页未形成可用页面证据，不能继续基于该标签页作趋势判断。");
  }
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
  if (isPlatformTrendSkill(skillId)) {
    errors.push(...validatePlatformTrendReport(out, toolHistory, pageContext));
  }
  if (isKeywordSkill(skillId)) {
    errors.push(...validateKeywordReport(out, toolHistory, pageContext));
  }
  if (isListingSkill(skillId)) {
    errors.push(...validateListingReport(out, toolHistory, pageContext));
  }
  if (isProductOpportunitySkill(skillId)) {
    errors.push(...validateProductOpportunityReport(out, toolHistory, pageContext));
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
      if (/SEO|关键词|搜索词|高频词|标题公式|Listing/i.test(itemText) && !hasAnyLedgerType(ledgerEntries, ["page_dom", "etsy_search", "google_search", "google_trends"]) && !hasAssumptionFallback(ledgerEntries, /SEO|关键词|搜索词|标题|Listing/i)) {
        errors.push(`Etsy 业务报告第 ${idx + 1} 项 (${title}) 使用了 SEO/关键词/Listing 结论，但 evidence_ledger 没有页面或搜索证据，也没有降级为待验证假设。`);
      }
      if (/评论|差评|review|buyer feedback|买家反馈|退货|破损|不符/i.test(itemText) && !hasAnyLedgerType(ledgerEntries, ["page_dom", "screenshot_visual", "etsy_search"]) && !hasAssumptionFallback(ledgerEntries, /评论|差评|review|买家反馈|退货|破损|不符/i)) {
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
const LLM_RECOVERY_RETRIES = 1;

function isRetryableLLMError(error) {
  return /network|fetch failed|请求.*失败|请求.*超时|timeout|timed out|502|503|504|429|连接|socket|ECONN|ENET|EAI_AGAIN/i.test(String(error?.message || error || ""));
}

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
      restoredCheckpoint = await loadAgentCheckpoint(sessionKey, skillId);
    }
    if (!checkpointSkillMatches(restoredCheckpoint, skillId)) {
      restoredCheckpoint = null;
    }
  }

  if (continueSession && restoredCheckpoint?.messages?.length) {
    messages = restoredCheckpoint.messages;
    toolHistory = Array.isArray(restoredCheckpoint.toolHistory) ? restoredCheckpoint.toolHistory : [];
    let resumeCompaction = null;
    if (isPlatformTrendSkill(skillId)) {
      const compacted = compactPlatformTrendRunawayToolHistory(toolHistory);
      if (compacted.changed) {
        toolHistory = compacted.toolHistory;
        restoredCheckpoint.toolHistory = toolHistory;
        resumeCompaction = compacted;
      }
    }
    if (restoredCheckpoint.ctxState) {
      // A user-initiated continuation starts a fresh bounded quality-repair window.
      // The previous window may have been exhausted, but its evidence and messages remain resumable.
      ctxForPrompt.__reflectionsCount = restoredCheckpoint.status === "quality_gate_blocked"
        ? 0
        : (restoredCheckpoint.ctxState.__reflectionsCount || 0);
      ctxForPrompt.__hasDeepReflected = Boolean(restoredCheckpoint.ctxState.__hasDeepReflected);
    }
    sendProgress({
      type: "checkpoint_restored",
      step: restoredCheckpoint.step || 0,
      message: `已恢复上次中断的 workflow：${restoredCheckpoint.lastStage || restoredCheckpoint.lastNode || restoredCheckpoint.status || "checkpoint"}，沿用 ${toolHistory.length} 个工具证据继续推进。`,
    });
    if (resumeCompaction) {
      sendProgress({
        type: "checkpoint_compacted",
        step: restoredCheckpoint.step || 0,
        message: `已检测到旧趋势任务搜索循环，自动压缩 ${resumeCompaction.removedSearchCalls} 条重复/低质量搜索证据；保留可用证据和阶段摘要后继续。`,
        removedSearchCalls: resumeCompaction.removedSearchCalls,
        stageState: resumeCompaction.compactedState,
      });
    }
    if (messages.length > 0 && messages[0].role === "system") {
      messages[0].content = systemPrompt;
    }

    const newCtx = buildPromptContext(pageContext);
    delete newCtx.screenshot;
    const ctxString = JSON.stringify(newCtx, null, 2);

    let instructionText = `[断点续跑] 请从上次中断节点继续，不要重复已经完成的搜索、开页、筛选或已获得的工具证据。`;
    if (resumeCompaction) {
      instructionText += `\n\n【已自动清理旧搜索循环】本次恢复时检测到趋势任务历史中存在 ${resumeCompaction.state.searchCalls} 次 search_in_browser，其中 ${resumeCompaction.removedSearchCalls} 条重复/低质量搜索已从工具证据上下文压缩为 workflow_stage_summary。你必须沿用保留的有效证据和阶段摘要继续，禁止再次扩展同类关键词搜索；若搜索阶段已完成，下一步进入竞品店铺/商品详情采集、截图分析或 final。`;
    }
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
      let recoveryAttempt = 0;
      while (true) {
        try {
          assistantContent = await callLLM(llmMessages, ({ chunk, fullText, isReasoning }) => {
            sendProgress({ type: "streaming", step, chunk, fullText, isReasoning });
          }, highRandomness);
          break;
        } catch (error) {
          if (!isRetryableLLMError(error) || recoveryAttempt >= LLM_RECOVERY_RETRIES) {
            await saveCheckpoint({
              status: "llm_network_error",
              step,
              lastNode: "llm_call_started",
              error: error.message,
              retryable: isRetryableLLMError(error),
            });
            sendProgress({
              type: "llm_error",
              step,
              retryable: isRetryableLLMError(error),
              message: `AI 网络请求未完成：${error.message}。已保存当前节点和工具证据，不会重复已完成的浏览器采集。`,
            });
            return {
              ok: false,
              type: "interrupted",
              result: "AI 网络请求暂时失败，已保存当前节点和工具证据。请发送“继续”重试当前 AI 请求，不会从第一步重新采集。",
              steps: step - 1,
              retryable: isRetryableLLMError(error),
              error: error.message,
            };
          }
          recoveryAttempt += 1;
          await saveCheckpoint({
            status: "llm_retry_wait",
            step,
            lastNode: "llm_network_retry",
            retryAttempt: recoveryAttempt,
            error: error.message,
          });
          sendProgress({
            type: "llm_retry",
            step,
            retryAttempt: recoveryAttempt,
            message: `AI 网络请求暂时失败，${recoveryAttempt} 秒后自动重试；已保留当前证据。`,
          });
          await new Promise((resolve) => setTimeout(resolve, recoveryAttempt * 2000));
        }
      }
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
        if (reflectionsCount < QUALITY_RETRY_LIMIT) {
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
        messages.push({ role: "assistant", content: assistantContent });
        messages.push({
          role: "user",
          content: `【质量闸门阻断】本次连续自动修复已达到 ${QUALITY_RETRY_LIMIT} 次上限，当前报告仍未通过最终质量校验。不得交付为成功报告。请在用户发送“继续”后，从已保存的证据和当前错误清单继续修复，不要重复已经完成的采集。\n\n未通过的问题：\n${validationErrors.map((err, i) => `${i + 1}. ${err}`).join("\n")}`,
        });
        await saveCheckpoint({
          status: "quality_gate_blocked",
          step,
          lastNode: "quality_gate_blocked",
          validationErrors,
          rejectedReport: parsed.output,
        });
        sendProgress({
          type: "quality_gate_blocked",
          step,
          message: `报告连续 ${QUALITY_RETRY_LIMIT} 次未通过质量校验，已阻断交付并保存断点。发送“继续”后可从当前证据继续修复。`,
          validationErrors,
        });
        return {
          ok: false,
          type: "interrupted",
          result: `报告未通过质量校验，已阻断交付并保存断点。请发送“继续”从当前证据继续修复。首个问题：${validationErrors[0]}`,
          steps: step,
          qualityGateBlocked: true,
          validationErrors,
        };
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
      let toolName = parsed.tool;
      let toolArgs = parsed.arguments || {};

      if (isPlatformTrendSkill(skillId) && !PLATFORM_TRENDS_ALLOWED_TOOLS.has(toolName)) {
        messages.push({ role: "assistant", content: assistantContent });
        messages.push({
          role: "user",
          content: JSON.stringify({
            type: "tool_error",
            tool: toolName,
            error: "Etsy 趋势任务只允许使用当前页面、Etsy 公开搜索、Google Search/Trends、公开竞品分页采集和截图分析工具。不要调用静默泛搜索、寻源、广告、订单或其他与当前证据阶段无关的工具。",
          }),
        });
        await saveCheckpoint({ status: "tool_quality_retry", step, lastNode: "platform_trends_tool_whitelist_guard", toolName });
        continue;
      }

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

      const etsyBrowserWorkflowGuardResult = getEtsyBrowserWorkflowGuardResult({
        skillId,
        toolName,
        toolArgs,
        toolHistory,
      });
      if (etsyBrowserWorkflowGuardResult?.type === "reuse_tool_result") {
        const reusedResult = etsyBrowserWorkflowGuardResult.reusedResult || {};
        toolHistory.push({ tool: toolName, arguments: toolArgs, result: reusedResult });
        messages.push({ role: "assistant", content: assistantContent });
        messages.push({
          role: "user",
          content: compactJsonStringForLLM({
            type: "tool_result",
            tool: toolName,
            reusedEvidence: true,
            result: compactToolResultForLLM(toolName, reusedResult),
            rawResultPreservedInToolHistory: true,
            next_step_instruction: "该趋势搜索证据已复用，禁止再次打开相同搜索。请检查还缺哪一类证据：Etsy 搜索、Google Search、Google Trends 截图、至少 2 个竞品详情页/店铺页、或物流主题搜索；已满足则直接输出 final。",
          }),
        });
        sendProgress({
          type: "tool_result_reused",
          step,
          toolName,
          message: etsyBrowserWorkflowGuardResult.message,
        });
        await saveCheckpoint({ status: "tool_result_reused", step, lastNode: "tool_result_reused", toolName });
        continue;
      }
      if (etsyBrowserWorkflowGuardResult?.type === "redirect_tool_call") {
        messages.push({ role: "assistant", content: assistantContent });
        sendProgress({
          type: "tool_stage_redirect",
          step,
          toolName,
          redirectedToolName: etsyBrowserWorkflowGuardResult.toTool,
          message: etsyBrowserWorkflowGuardResult.message,
        });
        toolName = etsyBrowserWorkflowGuardResult.toTool;
        toolArgs = etsyBrowserWorkflowGuardResult.arguments || {};
        if (workflowId) {
          toolArgs.workflowId = workflowId;
          toolArgs.workflowGeneration = workflowGeneration;
        }
        messages.push({
          role: "user",
          content: compactJsonStringForLLM({
            type: "tool_stage_redirect",
            fromTool: etsyBrowserWorkflowGuardResult.fromTool,
            toTool: toolName,
            reason: etsyBrowserWorkflowGuardResult.message,
            stageState: etsyBrowserWorkflowGuardResult.stageState,
          }),
        });
        await saveCheckpoint({ status: "tool_stage_redirect", step, lastNode: "platform_trends_stage_redirect", toolName });
      } else
      if (etsyBrowserWorkflowGuardResult) {
        messages.push({ role: "assistant", content: assistantContent });
        messages.push({
          role: "user",
          content: JSON.stringify(etsyBrowserWorkflowGuardResult),
        });
        sendProgress({
          type: "tool_guard",
          step,
          toolName,
          message: etsyBrowserWorkflowGuardResult.error,
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
      const plannedToolAction = describeToolAction(toolName, toolArgs);
      sendProgress({
        type: "tool_call",
        step,
        toolName,
        toolArgs: progressToolArgs,
        actionKind: plannedToolAction.actionKind,
        actionLabel: plannedToolAction.actionLabel,
        tabLifecycle: plannedToolAction.lifecycle,
      });
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
      const toolAction = describeToolAction(toolName, toolArgs);
      const tabsBeforeTool = await snapshotTabIds();
      try {
        toolHeartbeatTimer = setInterval(() => {
          const elapsedSeconds = Math.max(1, Math.round((Date.now() - toolStartedAt) / 1000));
          sendProgress({
            type: "tool_heartbeat",
            step,
            toolName,
            actionKind: toolAction.actionKind,
            actionLabel: toolAction.actionLabel,
            tabLifecycle: toolAction.lifecycle,
            elapsedSeconds,
            timeoutSeconds: Math.round(toolTimeoutMs / 1000),
            message: `${toolAction.actionLabel} 已运行 ${elapsedSeconds} 秒，最长等待 ${Math.round(toolTimeoutMs / 1000)} 秒；${toolAction.lifecycle || "若超时会返回阶段错误并保留 workflow 上下文。"}。`,
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
          toolResult.actionKind = toolAction.actionKind;
          toolResult.actionLabel = toolAction.actionLabel;
          toolResult.tabLifecycle = toolAction.lifecycle;
          toolResult.timeoutPolicy = "tool_timeout_does_not_cancel_workflow";
          sendProgress({
            type: "tool_timeout",
            step,
            toolName,
            actionKind: toolAction.actionKind,
            actionLabel: toolAction.actionLabel,
            tabLifecycle: toolAction.lifecycle,
            closedTabIds,
            elapsedSeconds: Math.round((Date.now() - toolStartedAt) / 1000),
            message: `${toolAction.actionLabel} 已超过本阶段等待时间；这表示该阶段未形成稳定返回，不等于页面没有数据。已回收本次工具新增的临时标签页 ${closedTabIds.length} 个，workflow 未被取消，可继续修复或重试该证据阶段。`,
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
      const completedToolAction = describeToolAction(toolName, toolArgs, toolResult);
      if (toolResult && typeof toolResult === "object") {
        toolResult.actionKind = toolResult.actionKind || completedToolAction.actionKind;
        toolResult.actionLabel = toolResult.actionLabel || completedToolAction.actionLabel;
        toolResult.tabLifecycle = toolResult.tabLifecycle || completedToolAction.lifecycle;
      }
      toolHistory.push({ tool: toolName, arguments: toolArgs, result: toolResult });

      sendProgress({
        type: "tool_result",
        step,
        toolName,
        actionKind: completedToolAction.actionKind,
        actionLabel: completedToolAction.actionLabel,
        tabLifecycle: completedToolAction.lifecycle,
        toolResult,
        message: `${completedToolAction.actionLabel}执行完毕，已获取并保存相关证据。${completedToolAction.lifecycle ? `（${completedToolAction.lifecycle}）` : ""}`,
      });
      await saveCheckpoint({
        status: toolTimedOut ? "tool_timeout" : "tool_completed",
        step,
        lastNode: toolTimedOut ? "tool_timeout" : "tool_result",
        toolName,
      });

      if (isPlatformTrendSkill(skillId)) {
        const toolQualityErrors = validatePlatformTrendToolResult(toolName, toolArgs, toolResult);
        if (toolQualityErrors.length > 0) {
          const requestKey = toolRunKey(toolName, toolArgs);
          const failedAttempts = toolHistory.filter((entry) =>
            entry?.tool === toolName && toolRunKey(entry.tool, entry.arguments || {}) === requestKey &&
            validatePlatformTrendToolResult(entry.tool, entry.arguments || {}, entry.result || {}).length > 0
          ).length;
          const qualityMessage = `【过程证据闸门拒绝】工具 ${toolName} 已返回，但结果不能作为可靠趋势证据：\n${toolQualityErrors.map((error, index) => `${index + 1}. ${error}`).join("\n")}\n请修复当前证据阶段或改为明确 blocked/assumption，不要继续生成基于空证据的结论。`;
          if (failedAttempts >= 2) {
            messages.push({ role: "assistant", content: assistantContent });
            messages.push({ role: "user", content: qualityMessage });
            await saveCheckpoint({
              status: "step_quality_blocked",
              step,
              lastNode: "step_quality_blocked",
              toolName,
              toolQualityErrors,
            });
            sendProgress({ type: "step_quality_blocked", step, toolName, message: qualityMessage, toolQualityErrors });
            return {
              ok: false,
              type: "interrupted",
              result: `趋势证据阶段 ${toolName} 连续失败，已阻断后续分析并保存断点。请发送“继续”修复当前证据阶段。首个问题：${toolQualityErrors[0]}`,
              steps: step,
              qualityGateBlocked: true,
              validationErrors: toolQualityErrors,
            };
          }
          messages.push({ role: "assistant", content: assistantContent });
          messages.push({ role: "user", content: qualityMessage });
          await saveCheckpoint({ status: "tool_quality_retry", step, lastNode: "tool_quality_retry", toolName, toolQualityErrors });
          continue;
        }
      }

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
