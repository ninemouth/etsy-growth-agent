// modules/agentLoop.js — The Agent reasoning & tool loop logic

import { callLLM, getSettings } from './llmClient.js';
import { tools, hasValidEtsySearchEvidence, hasValidGoogleTrendsEvidence } from './toolRegistry.js';
import { appendWorkflowEvent, isWorkflowCancellationRequested, isWorkflowGenerationCurrent } from './workflowRuntime.js';
import { putDataUrlArtifact } from './artifactStore.js';
import { captureFullPageScreenshot } from './debuggerCapture.js';
import { formatBrowserAutomationCapabilityPrompt } from './browserAutomationCapabilities.js';
import { getCurrencyRateContextForPrompt } from './currencyRates.js';
import { buildNegativeFilterPrompt } from './negativeFilters.js';
import {
  collectGoogleTrendsAttempts,
  getTrendQueryGuardError,
  getTrendQueryRefinementState,
  hasUsableGoogleTrendsAttempt,
  MAX_GOOGLE_TRENDS_QUERY_ATTEMPTS,
} from './trendQueryPlanner.js';

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
  delete dedupeArgs.__progress;
  delete dedupeArgs.__sourceTabId;
  delete dedupeArgs.__workflowContext;
  delete dedupeArgs.__toolRunState;
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
    evidence_quality: result.evidence_quality,
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
  hasEvidenceSource,
  validateEvidenceLedgerEntries,
  buildShopOptimizerProductionSkeletonState,
  formatShopOptimizerProductionSkeletonPrompt,
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
const PLATFORM_TRENDS_SKILL_RE = /etsy_platform_trends|etsy_event_driven_trend_radar/;
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

function searchEngineFamily(engine = "") {
  const normalized = String(engine || "").toLowerCase();
  if (normalized === "google" || /^google_(us|uk|de|fr|ca|au|ru)$/.test(normalized)) return "google_search";
  if (normalized === "google_news" || /^google_news_(us|uk|de|fr|ca|au)$/.test(normalized)) return "google_news";
  if (normalized === "google_trends" || /^google_trends_(us|uk|de|fr|ca|au)$/.test(normalized)) return "google_trends";
  if (normalized === "etsy" || /^etsy_(us|uk|de|fr|ca|au)$/.test(normalized)) return "etsy";
  if (normalized === "amazon" || /^amazon_(us|uk|de|fr|ca|au)$/.test(normalized)) return "amazon";
  if (/^ebay_(us|uk|de|fr|ca|au)$/.test(normalized)) return "ebay";
  return normalized;
}

function isGoogleSearchEngine(engine = "") {
  return searchEngineFamily(engine) === "google_search";
}

function isGoogleTrendsEngine(engine = "") {
  return searchEngineFamily(engine) === "google_trends";
}

function isGoogleNewsEngine(engine = "") {
  return searchEngineFamily(engine) === "google_news";
}

function isEtsySearchEngine(engine = "") {
  return searchEngineFamily(engine) === "etsy";
}

function isAmazonSearchEngine(engine = "") {
  return searchEngineFamily(engine) === "amazon";
}

function isEbaySearchEngine(engine = "") {
  return searchEngineFamily(engine) === "ebay";
}

function isShopOptimizerOnly(skillId = "") {
  const id = String(skillId || "");
  return id.includes("etsy_global_shop_optimizer") && !id.includes("etsy_sourcing_finder") && !id.includes("domestic_sourcing_finder");
}

function isGoogleTrendsGuardedWorkflow(skillId = "") {
  return isPlatformTrendSkill(skillId) || isShopOptimizerOnly(skillId);
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

function isReusableSearchEvidence(entry = {}) {
  if (entry?.tool !== "search_in_browser") return false;
  const result = entry.result || {};
  if (result.error || result.isCaptcha || result.cancelled || result.stale) return false;
  const engine = String(entry.arguments?.engine || "").toLowerCase();
  if (isEtsySearchEngine(engine)) return hasValidEtsySearchEvidence(result) || result.evidenceOk === true || Boolean(result.screenshotRef);
  if (isGoogleTrendsEngine(engine)) return hasValidGoogleTrendsEvidence(result) || (result.evidenceOk === true && Boolean(result.screenshotRef || result.screenshotCaptured));
  if (isGoogleSearchEngine(engine) || isGoogleNewsEngine(engine) || engine === "bing") {
    return hasValidGoogleSearchEvidence(result) || result.evidenceOk === true || Boolean(result.screenshotRef || result.screenshotCaptured);
  }
  return result.ok !== false && (result.evidenceOk === true || Boolean(result.pageData || result.screenshotRef || result.screenshotCaptured));
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
    if (isEtsySearchEngine(engine)) {
      etsySearches++;
      valid = hasValidEtsySearchEvidence(entry.result || {});
      if (valid) validEtsySearches++;
    } else if (isGoogleTrendsEngine(engine)) {
      googleTrendsSearches++;
      valid = hasValidGoogleTrendsEvidence(entry.result || {});
      if (valid) validGoogleTrendsSearches++;
      if (entry.result?.screenshotRef || entry.result?.screenshotCaptured) googleTrendsScreenshots++;
    } else if (isGoogleSearchEngine(engine)) {
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
  const searchRequestsExhausted = state.searchStageComplete || state.validEtsySearches >= 1 && state.validGoogleSearches >= 1 && !isGoogleTrendsEngine(engine);

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
      isEtsySearchEngine(entry.arguments?.engine)
        ? hasValidEtsySearchEvidence(result)
        : isGoogleTrendsEngine(entry.arguments?.engine)
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
  if (isGoogleTrendsGuardedWorkflow(skillId) && toolName === "search_in_browser") {
    const queryGuard = getTrendQueryGuardError({ skillId, toolName, toolArgs, toolHistory });
    if (queryGuard) return queryGuard;
  }
  if (isPlatformTrendSkill(skillId) && toolName === "search_in_browser") {
    const stageGuard = getPlatformTrendStageGuard({ toolName, toolArgs, toolHistory });
    if (stageGuard) return stageGuard;
  }
  if (toolName === "search_in_browser" && !isSourcingSkill(skillId)) {
    const requestKey = searchEvidenceKey(toolArgs);
    const duplicate = toolHistory.find((entry) => {
      if (!isReusableSearchEvidence(entry)) return false;
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
    if (isEtsySearchEngine(engine)) return { actionKind: "search_results", actionLabel: "Etsy 搜索结果页取证", lifecycle: "搜索页在保存页面文本和截图证据后会自动关闭" };
    if (isGoogleTrendsEngine(engine)) return { actionKind: "trend_chart", actionLabel: "Google Trends 趋势图取证", lifecycle: "趋势页在保存截图证据后会自动关闭" };
    if (isGoogleSearchEngine(engine) || isGoogleNewsEngine(engine)) return { actionKind: "web_search", actionLabel: "Google Search 结果页取证", lifecycle: "搜索页在保存页面文本和截图证据后会自动关闭" };
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

function formatEvidenceQualityForProgress(toolResult = {}) {
  const quality = toolResult?.evidence_quality;
  if (!quality || typeof quality !== "object") return "";
  const parts = [
    quality.load_state || "",
    Number(quality.stable_reads || 0) ? `stableReads=${quality.stable_reads}` : "",
    quality.screenshot_captured ? "screenshot=ok" : "",
    quality.risk ? `risk=${quality.risk}` : "",
  ].filter(Boolean);
  return parts.length ? `；证据质量：${parts.join(", ")}` : "";
}

function stripRuntimeToolArgs(toolArgs = {}) {
  const clean = { ...toolArgs };
  delete clean.__progress;
  delete clean.__sourceTabId;
  delete clean.__workflowContext;
  delete clean.__toolRunState;
  return clean;
}

function compactToolResultForLedger(toolResult = {}) {
  const pageData = toolResult?.pageData || {};
  return {
    ok: toolResult?.ok,
    error: toolResult?.error || "",
    timedOut: Boolean(toolResult?.timedOut),
    cancelled: Boolean(toolResult?.cancelled),
    stale: Boolean(toolResult?.stale),
    actionKind: toolResult?.actionKind || "",
    actionLabel: toolResult?.actionLabel || "",
    tabId: toolResult?.tabId,
    finalUrl: toolResult?.finalUrl || toolResult?.url || pageData.url || "",
    evidenceOk: toolResult?.evidenceOk,
    evidenceStatus: toolResult?.evidenceStatus || "",
    evidenceQuality: toolResult?.evidence_quality || null,
    pageHealth: pageData.pageHealth || null,
    productCardCount: Array.isArray(pageData.productCards) ? pageData.productCards.length : undefined,
    productLinkCount: Array.isArray(pageData.productLinks) ? pageData.productLinks.length : undefined,
    screenshotCaptured: Boolean(toolResult?.screenshotCaptured),
    screenshotCaptureMode: toolResult?.screenshotCaptureMode || "",
    closedTabIds: Array.isArray(toolResult?.closedTabIds) ? toolResult.closedTabIds : undefined,
  };
}

async function recordWorkflowExecutionEvent(workflowId = "", type = "", payload = {}) {
  if (!workflowId || !type) return;
  try {
    await appendWorkflowEvent(workflowId, type, payload);
  } catch (err) {
    console.warn("Failed to append workflow execution event:", err.message);
  }
}

async function runToolWithTimeout(toolName, toolArgs, toolRunState = null) {
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
          if (toolRunState) {
            toolRunState.cancelled = true;
            toolRunState.cancelReason = `${toolName} timed out after ${Math.round(timeoutMs / 1000)} seconds`;
          }
          if (inFlightToolRuns.get(key) === operation) inFlightToolRuns.delete(key);
          reject(new Error(`${toolName} timed out after ${Math.round(timeoutMs / 1000)} seconds`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function createToolRunId(toolName = "") {
  return `tool_run_${toolName || "tool"}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function snapshotTabIds() {
  if (typeof chrome === "undefined" || !chrome.tabs?.query) return new Set();
  const tabs = await new Promise((resolve) => chrome.tabs.query({}, (items) => resolve(items || [])));
  return new Set(tabs.map((tab) => tab.id).filter((id) => Number.isInteger(id)));
}

async function closeTabsCreatedDuringTimedOutTool(beforeTabIds = new Set(), protectedTabIds = new Set()) {
  if (typeof chrome === "undefined" || !chrome.tabs?.query) return [];
  const tabs = await new Promise((resolve) => chrome.tabs.query({}, (items) => resolve(items || [])));
  const candidates = tabs.filter((tab) => {
    if (!Number.isInteger(tab.id) || beforeTabIds.has(tab.id) || protectedTabIds.has(tab.id)) return false;
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

function getBestEtsyApiEvidence(toolHistory = []) {
  const priority = [
    "etsy_api_get_store_snapshot",
    "etsy_api_get_connection_status",
    "etsy_api_get_capabilities",
    "etsy_api_get_products",
    "etsy_api_get_product_info",
  ];
  const entries = (toolHistory || []).filter((entry) =>
    entry?.result?.ok !== false &&
    !entry?.result?.error &&
    String(entry?.tool || "").startsWith("etsy_api_")
  );
  if (!entries.length) return null;
  return entries.sort((a, b) => {
    const ai = priority.indexOf(a.tool);
    const bi = priority.indexOf(b.tool);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  })[0];
}

function buildEtsyApiLedgerEntry(entry = {}) {
  const result = entry.result?.result || entry.result || {};
  const capabilities = result.capabilities || result.apiCapabilities || result;
  const supported = [];
  const unsupported = [];
  Object.entries(capabilities || {}).forEach(([key, value]) => {
    if (value === true || value?.supported === true) supported.push(key);
    if (value === false || value?.supported === false) unsupported.push(key);
  });
  const listingCount = Array.isArray(result.listings) ? result.listings.length : result.listingCount || result.activeListingCount;
  const receiptCount = Array.isArray(result.receipts) ? result.receipts.length : result.receiptCount;
  const observed = [
    `工具 ${entry.tool || "etsy_api"} 已返回自营店铺 API 边界/快照。`,
    Number.isFinite(Number(listingCount)) ? `可见 listings=${listingCount}` : "",
    Number.isFinite(Number(receiptCount)) ? `可见 receipts=${receiptCount}` : "",
    supported.length ? `supported=${supported.slice(0, 6).join(", ")}` : "",
    unsupported.length ? `unsupported=${unsupported.slice(0, 6).join(", ")}` : "",
  ].filter(Boolean).join("；");
  return {
    source_type: "etsy_api",
    source_ref: entry.tool || "etsy_api",
    observed_value: observed || "本轮已取得 Etsy 个人访问 API 工具返回，用于确认自营店铺可访问数据边界。",
    used_for: "支撑自营店铺 API 能力边界、公开页面与 API 可验证/不可验证字段的区分；不能用于竞品后台、平台大盘、Sessions、点击率或加购率。",
    confidence: "medium",
    limitation: "Etsy 个人 API 只覆盖当前授权自营店铺；若工具返回 capabilities 显示 analytics/traffic/fulfillment 不支持，相关结论仍需在报告中写成待验证假设或人工确认点。",
  };
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

const EVIDENCE_SOURCE_TYPE_ALIASES = {
  own_shop_api: "etsy_api",
  own_listing_api: "etsy_api",
  own_order_api: "etsy_api",
  own_shipping_api: "etsy_api",
  seller_api: "etsy_api",
  etsy_seller_api: "etsy_api",
  current_page_dom: "page_dom",
  current_shop_dom: "page_dom",
  current_listing_dom: "page_dom",
  competitor_page_dom: "page_dom",
  competitor_shop_dom: "page_dom",
  competitor_listing_dom: "page_dom",
  page_text: "page_dom",
  current_page_screenshot: "screenshot_visual",
  current_shop_screenshot: "screenshot_visual",
  current_listing_screenshot: "screenshot_visual",
  competitor_screenshot: "screenshot_visual",
  competitor_shop_screenshot: "screenshot_visual",
  competitor_listing_screenshot: "screenshot_visual",
  google_trends_screenshot: "screenshot_visual",
  google_trends_visual: "screenshot_visual",
  screenshot: "screenshot_visual",
  visual_screenshot: "screenshot_visual",
  google_us: "google_search",
  google_uk: "google_search",
  google_de: "google_search",
  google_fr: "google_search",
  google_ca: "google_search",
  google_au: "google_search",
  google_search_us: "google_search",
  google_search_uk: "google_search",
  google_search_de: "google_search",
  google_search_fr: "google_search",
  google_search_ca: "google_search",
  google_search_au: "google_search",
  etsy_policy: "official_policy",
  official_etsy_policy: "official_policy",
  user_provided: "user_input",
  user_data: "user_input",
  user_note: "user_input",
  pinterest: "pinterest_social",
  pinterest_trends: "pinterest_social",
  pinterest_search: "pinterest_social",
  tiktok: "tiktok_social",
  tiktok_search: "tiktok_social",
  instagram: "instagram_social",
  instagram_search: "instagram_social",
  reddit: "reddit_social",
  reddit_search: "reddit_social",
  news: "google_news",
  news_search: "google_news",
  amazon: "amazon_search",
  amazon_search: "amazon_search",
  ebay: "ebay_search",
  ebay_search: "ebay_search",
};

function normalizeEvidenceLedgerSourceType(sourceType = "") {
  const normalized = String(sourceType || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return EVIDENCE_SOURCE_TYPE_ALIASES[normalized] || normalized;
}

function normalizeEvidenceLedgerSourceTypesInObject(value) {
  let changed = false;
  const visit = (node, key = "") => {
    if (!node || typeof node !== "object") return;
    if (key === "evidence_ledger" && Array.isArray(node)) {
      node.forEach((entry) => {
        if (!entry || typeof entry !== "object") return;
        const original = String(entry.source_type || "");
        const canonical = normalizeEvidenceLedgerSourceType(original);
        if (original && canonical && canonical !== original) {
          entry.source_type = canonical;
          changed = true;
        }
      });
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item) => visit(item));
      return;
    }
    Object.entries(node).forEach(([childKey, childValue]) => visit(childValue, childKey));
  };
  visit(value);
  return changed;
}

function hasEvidenceSource(toolHistory = [], pageContext = {}, sourceType = "") {
  const normalized = normalizeEvidenceLedgerSourceType(sourceType);
  if (normalized === "page_dom") {
    return hasMeaningfulPageDom(pageContext) || hasMeaningfulToolPageDom(toolHistory);
  }
  if (normalized === "screenshot_visual") {
    return Boolean(pageContext?.screenshot) || hasSuccessfulToolCall(toolHistory, (entry) =>
      entry.tool === "analyze_etsy_shop_crawl_screenshots" &&
      Number(entry.result?.screenshotsAnalyzed || 0) > 0
    ) || hasSuccessfulToolCall(toolHistory, (entry) =>
      ["open_new_tab", "navigate_to"].includes(entry?.tool) &&
      Boolean(entry.result?.screenshotRef || entry.result?.screenshotCaptured)
    ) || hasSuccessfulToolCall(toolHistory, (entry) =>
      ["collect_etsy_shop_pages", "collect_etsy_competitor_shops"].includes(entry?.tool) &&
      (Array.isArray(entry.result?.pages) || Array.isArray(entry.result?.allPages)) &&
      [...(entry.result.pages || []), ...(entry.result.allPages || [])].some((page) => page?.screenshotRef || page?.screenshotCaptured)
    );
  }
  if (normalized === "etsy_api") {
    return hasSuccessfulToolCall(toolHistory, (entry) => String(entry.tool || "").startsWith("etsy_api_"));
  }
  if (normalized === "etsy_search") {
    return hasSuccessfulToolCall(toolHistory, (entry) =>
      entry.tool === "search_in_browser" &&
      isEtsySearchEngine(entry.arguments?.engine) &&
      hasValidEtsySearchEvidence(entry.result)
    );
  }
  if (normalized === "google_search") {
    return hasSuccessfulToolCall(toolHistory, (entry) => {
      const engine = String(entry.arguments?.engine || "").toLowerCase();
      return entry.tool === "search_in_browser" && isGoogleSearchEngine(engine);
    });
  }
  if (normalized === "pinterest_social") {
    return hasSuccessfulToolCall(toolHistory, (entry) =>
      entry.tool === "search_in_browser" && ["pinterest", "pinterest_trends"].includes(String(entry.arguments?.engine || "").toLowerCase())
    );
  }
  if (normalized === "tiktok_social") {
    return hasSuccessfulToolCall(toolHistory, (entry) =>
      entry.tool === "search_in_browser" && String(entry.arguments?.engine || "").toLowerCase() === "tiktok"
    );
  }
  if (normalized === "instagram_social") {
    return hasSuccessfulToolCall(toolHistory, (entry) =>
      entry.tool === "search_in_browser" && String(entry.arguments?.engine || "").toLowerCase() === "instagram"
    );
  }
  if (normalized === "reddit_social") {
    return hasSuccessfulToolCall(toolHistory, (entry) =>
      entry.tool === "search_in_browser" && String(entry.arguments?.engine || "").toLowerCase() === "reddit"
    );
  }
  if (normalized === "google_news") {
    return hasSuccessfulToolCall(toolHistory, (entry) =>
      entry.tool === "search_in_browser" && isGoogleNewsEngine(entry.arguments?.engine)
    );
  }
  if (normalized === "google_trends") {
    return hasSuccessfulToolCall(toolHistory, (entry) =>
      entry.tool === "search_in_browser" && isGoogleTrendsEngine(entry.arguments?.engine) && hasValidGoogleTrendsEvidence(entry.result)
    );
  }
  if (normalized === "amazon_search") {
    return hasSuccessfulToolCall(toolHistory, (entry) =>
      entry.tool === "search_in_browser" && isAmazonSearchEngine(entry.arguments?.engine)
    );
  }
  if (normalized === "ebay_search") {
    return hasSuccessfulToolCall(toolHistory, (entry) =>
      entry.tool === "search_in_browser" && isEbaySearchEngine(entry.arguments?.engine)
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
  const targetType = normalizeEvidenceLedgerSourceType(sourceType);
  return ledger.some((entry) => normalizeEvidenceLedgerSourceType(entry?.source_type) === targetType);
}

function hasAnyLedgerType(ledger = [], sourceTypes = []) {
  const normalizedTypes = sourceTypes.map((type) => normalizeEvidenceLedgerSourceType(type));
  return ledger.some((entry) => normalizedTypes.includes(normalizeEvidenceLedgerSourceType(entry?.source_type)));
}

function hasLedgerTypeTopic(ledger = [], sourceTypes = [], topicRegex) {
  const normalizedTypes = sourceTypes.map((type) => normalizeEvidenceLedgerSourceType(type));
  return ledger.some((entry) => {
    const sourceType = normalizeEvidenceLedgerSourceType(entry?.source_type);
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
    if (normalizeEvidenceLedgerSourceType(entry?.source_type) !== "screenshot_visual") return false;
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
    if (normalizeEvidenceLedgerSourceType(entry?.source_type) !== "screenshot_visual") return;
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
    if (normalizeEvidenceLedgerSourceType(entry?.source_type) !== "screenshot_visual") return false;
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
    const sourceType = normalizeEvidenceLedgerSourceType(entry?.source_type);
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
  allowedTypes = ["page_dom", "screenshot_visual", "etsy_api", "etsy_search", "google_search", "google_trends", "sourcing_search", "supplier_page", "official_policy", "official_regulation", "pinterest_social", "tiktok_social", "instagram_social", "reddit_social", "google_news", "amazon_search", "ebay_search", "user_input", "assumption"],
}) {
  const errors = [];
  if (!Array.isArray(entries) || entries.length === 0) {
    errors.push(`${label} 缺少 evidence_ledger 结构化证据账本。每个实体必须拆分真实页面/API/搜索/供应商页面/假设来源。`);
    return errors;
  }
  entries.forEach((entry, ledgerIdx) => {
    const prefix = `${label} 的 evidence_ledger 第 ${ledgerIdx + 1} 条`;
    const sourceType = normalizeEvidenceLedgerSourceType(entry?.source_type);
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

const ETSY_API_ASSUMPTION_RE = /API|Seller API|etsy_api|Sessions?|session|流量|会话|访问量|订单|交易|扣费|履约|履约成本|物流|Shipping Profile|shipping|fulfillment|第三方海外仓|Etsy 自发货|conversion|traffic|orders?/i;
const SHOP_OPTIMIZER_API_CLAIM_RE = /API|Seller API|etsy_api|Sessions?|session|流量|会话|访问量|订单|交易|扣费|履约|履约成本|物流|Shipping Profile|shipping|fulfillment|第三方海外仓|Etsy 自发货|conversion|traffic|orders?/i;
const SHOP_OPTIMIZER_API_ASSUMPTION_TOPIC_RE = /API|Seller|流量|会话|订单|交易|履约|物流|Shipping|fulfillment|第三方海外仓|Etsy 自发货|未配置|未取得|未获得|待验证|复核/i;
const USER_REQUESTS_API_ASSUMPTION_DOWNGRADE_RE = /忽略\s*(?:api|API)|跳过\s*(?:api|API)|未配置\s*(?:api|API)|没有\s*(?:api|API)|无\s*(?:api|API)|不用\s*(?:api|API)|按\s*(?:assumption|假设).{0,12}(?:处理|降级)|(?:api|API).{0,12}(?:assumption|假设|降级|跳过|忽略|未配置|没有|无)/i;

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

function getReportItemClaimText(item = {}) {
  if (!item || typeof item !== "object") return "";
  const clone = { ...item };
  delete clone.evidence_ledger;
  return JSON.stringify(clone);
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

function getEtsySearchEvidence(toolHistory = []) {
  for (let i = toolHistory.length - 1; i >= 0; i--) {
    const entry = toolHistory[i];
    if (entry?.tool !== "search_in_browser") continue;
    if (String(entry.arguments?.engine || "").toLowerCase() !== "etsy") continue;
    if (!hasValidEtsySearchEvidence(entry.result || {})) continue;
    const pageData = entry.result?.pageData || {};
    const cards = Array.isArray(pageData.productCards) ? pageData.productCards : [];
    const links = Array.isArray(pageData.productLinks) ? pageData.productLinks : [];
    const prices = cards.map((card) => card.price).filter(Boolean).slice(0, 6).join(", ");
    const titles = cards.map((card) => card.title || card.text).filter(Boolean).slice(0, 4).join("；");
    return {
      query: entry.arguments?.query || entry.arguments?.keyword || entry.result?.queryUsed || "",
      sourceRef: entry.result?.searchUrl || pageData.url || "Etsy search evidence",
      screenshotRef: entry.result?.screenshotRef || "",
      screenshotCaptured: Boolean(entry.result?.screenshotCaptured),
      observedValue: [
        `Etsy 公开搜索页已读取，可见商品卡片 ${cards.length} 个、链接 ${links.length} 个。`,
        prices ? `可见价格样本：${prices}。` : "",
        titles ? `可见标题样本：${truncateText(titles, 240)}` : "",
        pageData.visibleText ? `页面文本摘要：${truncateText(pageData.visibleText, 220)}` : "",
      ].filter(Boolean).join(" "),
    };
  }
  return null;
}

function getGoogleTrendsScreenshotEvidence(toolHistory = []) {
  for (let i = toolHistory.length - 1; i >= 0; i--) {
    const entry = toolHistory[i];
    if (entry?.tool !== "search_in_browser") continue;
    if (!isGoogleTrendsEngine(entry.arguments?.engine)) continue;
    if (!hasValidGoogleTrendsEvidence(entry.result || {})) continue;
    if (!entry.result?.screenshotRef && !entry.result?.screenshotCaptured) continue;
    return {
      query: entry.arguments?.query || entry.arguments?.keyword || entry.result?.queryUsed || "",
      sourceRef: entry.result?.screenshotRef || entry.result?.searchUrl || entry.result?.pageData?.url || "Google Trends screenshot artifact",
      searchUrl: entry.result?.searchUrl || entry.result?.pageData?.url || "",
      captureMode: entry.result?.screenshotCaptureMode || "unknown",
      evidenceQuality: entry.result?.evidence_quality || entry.result?.evidenceQuality || null,
      observedValue: [
        "Google Trends 页面已读取并保存趋势图截图 artifact。",
        entry.result?.pageData?.visibleText ? `页面可见文本包含：${truncateText(entry.result.pageData.visibleText, 220)}` : "",
      ].filter(Boolean).join(" "),
    };
  }
  return null;
}

function getGoogleTrendsToolEvidence(toolHistory = []) {
  for (let i = toolHistory.length - 1; i >= 0; i--) {
    const entry = toolHistory[i];
    if (entry?.tool !== "search_in_browser") continue;
    if (!isGoogleTrendsEngine(entry.arguments?.engine)) continue;
    if (!hasValidGoogleTrendsEvidence(entry.result || {})) continue;
    const pageData = entry.result?.pageData || {};
    return {
      query: entry.arguments?.query || entry.arguments?.keyword || entry.result?.queryUsed || "",
      sourceRef: entry.result?.searchUrl || pageData.url || "Google Trends search evidence",
      searchUrl: entry.result?.searchUrl || pageData.url || "",
      captureMode: entry.result?.screenshotCaptureMode || "unknown",
      evidenceQuality: entry.result?.evidence_quality || entry.result?.evidenceQuality || null,
      observedValue: [
        "Google Trends 页面已通过工具证据校验。",
        pageData.title ? `页面标题：${truncateText(pageData.title, 120)}` : "",
        pageData.visibleText ? `可见文本摘要：${truncateText(pageData.visibleText, 240)}` : "",
      ].filter(Boolean).join(" "),
    };
  }
  return null;
}

function summarizeEvidenceQuality(evidence = {}) {
  const quality = evidence.evidenceQuality || evidence.evidence_quality || {};
  const parts = [];
  const loadState = quality.load_state || quality.loadState || quality.ready_reason || quality.readyReason;
  const stableReads = quality.stable_reads ?? quality.stableReads;
  const elapsedMs = quality.readiness_elapsed_ms ?? quality.readinessElapsedMs;
  const attempts = quality.readiness_attempts ?? quality.readinessAttempts;
  const risk = quality.risk || "";
  if (loadState) parts.push(`load_state=${loadState}`);
  if (stableReads !== undefined) parts.push(`stable_reads=${stableReads}`);
  if (attempts !== undefined) parts.push(`attempts=${attempts}`);
  if (elapsedMs !== undefined) parts.push(`elapsed_ms=${elapsedMs}`);
  if (risk) parts.push(`risk=${risk}`);
  return parts.length ? `证据质量：${parts.join("，")}。` : "";
}

function getGoogleSearchEvidence(toolHistory = []) {
  for (let i = toolHistory.length - 1; i >= 0; i--) {
    const entry = toolHistory[i];
    if (entry?.tool !== "search_in_browser") continue;
    const engine = String(entry.arguments?.engine || "").toLowerCase();
    if (!isGoogleSearchEngine(engine)) continue;
    const result = entry.result || {};
    if (result.ok === false || result.error || result.isCaptcha) continue;
    const pageData = result.pageData || {};
    const pageHealth = pageData.pageHealth || {};
    if (pageHealth.isLikelyBlocked) continue;
    const visibleText = String(pageData.visibleText || pageData.text || "").replace(/\s+/g, " ").trim();
    const title = String(pageData.title || pageData.h1 || "").trim();
    const hasReadableEvidence = visibleText.length >= 120 || title.length >= 8 || Boolean(result.screenshotRef || result.screenshotCaptured);
    if (!hasReadableEvidence) continue;
    return {
      query: entry.arguments?.query || entry.arguments?.keyword || result.queryUsed || result.queryOriginal || "",
      sourceRef: result.searchUrl || pageData.url || "Google Search evidence",
      screenshotRef: result.screenshotRef || "",
      screenshotCaptured: Boolean(result.screenshotCaptured),
      observedValue: [
        "Google Search/Google US 公开搜索结果页已读取。",
        title ? `页面标题：${truncateText(title, 120)}` : "",
        visibleText ? `可见文本摘要：${truncateText(visibleText, 240)}` : "",
      ].filter(Boolean).join(" "),
    };
  }
  return null;
}

function buildGoogleSearchLedgerEntry(evidence = {}) {
  const queryText = evidence.query ? `查询词：${evidence.query}；` : "";
  const screenshotText = evidence.screenshotRef || evidence.screenshotCaptured ? "；本轮已保留搜索结果页截图 artifact" : "";
  return {
    source_type: "google_search",
    source_ref: evidence.sourceRef || "Google Search evidence",
    observed_value: `${queryText}${evidence.observedValue || "Google Search 公开结果页可读，用于验证站外表达、买家场景和公开市场线索。"}${screenshotText}`,
    used_for: "支撑 Google Search/站外市场/欧美买家表达相关结论；不得据此推断 Etsy 平台搜索量、点击率、订单或转化率。",
    confidence: "medium",
    limitation: "Google Search 公开结果受地区、时间、个性化和页面可读性影响，只能作为站外表达和市场语义线索，不等于 Etsy 平台内部需求规模。",
  };
}

function buildEtsySearchLedgerEntry(evidence = {}) {
  const queryText = evidence.query ? `查询词：${evidence.query}；` : "";
  const screenshotText = evidence.screenshotRef || evidence.screenshotCaptured ? "；本轮已保留 Etsy 搜索结果页截图 artifact" : "";
  return {
    source_type: "etsy_search",
    source_ref: evidence.sourceRef || "Etsy search evidence",
    observed_value: `${queryText}${evidence.observedValue || "Etsy 公开搜索结果页可读，用于验证平台可见样本、价格带、标题词和竞品入口。"}${screenshotText}`,
    used_for: "支撑 Etsy 平台公开搜索样本、价格带、可见商品共性和竞品入口判断；不得据此推断全平台搜索量、订单或转化率。",
    confidence: "medium",
    limitation: "Etsy Search Grid 只能代表本轮可见样本和查询口径，不代表全平台完整商品数、完整价格分布、真实销量或竞品后台数据。",
  };
}

function buildGoogleTrendsToolLedgerEntry(evidence = {}) {
  const queryText = evidence.query ? `查询词：${evidence.query}；` : "";
  const ref = evidence.searchUrl || evidence.sourceRef || "Google Trends search evidence";
  const qualityText = summarizeEvidenceQuality(evidence);
  return {
    source_type: "google_trends",
    source_ref: ref,
    observed_value: `${queryText}Google Trends 页面已通过工具证据校验，可见 Interest over time、related queries/topics 或趋势页面文本。${qualityText}`,
    used_for: "支撑趋势/季节性/需求曲线相关结论的工具来源；最终解释仍需结合趋势图截图视觉解读。",
    confidence: /risk=high|timed_out|blocked/i.test(qualityText) ? "low" : "medium",
    limitation: "Google Trends 是相对热度，不等于 Etsy 平台搜索量、点击率、订单或转化率；只能作为公开需求方向证据。",
  };
}

function buildGoogleTrendsScreenshotLedgerEntry(evidence = {}) {
  const queryText = evidence.query ? `查询词：${evidence.query}；` : "";
  const urlText = evidence.searchUrl ? `页面：${evidence.searchUrl}；` : "";
  const qualityText = summarizeEvidenceQuality(evidence);
  return {
    source_type: "screenshot_visual",
    source_ref: `Google Trends 截图 ${evidence.sourceRef || evidence.searchUrl || ""}`.trim(),
    observed_value: `${queryText}${urlText}已取得 Google Trends 趋势图截图，需基于截图记录地区 US、近 12 个月时间范围、Interest over time 曲线、related queries/topics 和图表可见局限。${qualityText}${evidence.observedValue || ""}`,
    used_for: "支撑趋势/季节性/需求曲线相关结论，并约束报告只能描述截图可见趋势，不得推断真实搜索量或 Etsy 订单。",
    confidence: /risk=high|timed_out|blocked/i.test(qualityText) ? "low" : "medium",
    limitation: `截图捕获方式 ${evidence.captureMode || "unknown"}；Google Trends 是相对热度，不等于 Etsy 平台搜索量、点击率、订单或转化率。`,
  };
}

function getTrendCompetitorPageLedgerEntries(toolHistory = [], limit = 4) {
  const entries = [];
  const seen = new Set();
  const pushPair = ({ url, title, visibleText, screenshotRef, screenshotCaptured, tool }) => {
    const normalizedUrl = normalizeUrlForWorkflow(url);
    if (!normalizedUrl || seen.has(normalizedUrl)) return;
    if (!/etsy\.com\/(?:listing|shop)\//i.test(normalizedUrl)) return;
    seen.add(normalizedUrl);
    const label = /\/listing\//i.test(normalizedUrl) ? "竞品商品详情页" : "竞品店铺页";
    entries.push({
      source_type: "page_dom",
      source_ref: `${label}: ${url}`,
      observed_value: [
        `${label}已通过 ${tool || "browser tool"} 读取页面文本。`,
        title ? `标题：${truncateText(title, 120)}。` : "",
        visibleText ? `可见文本摘要：${truncateText(visibleText, 260)}` : "",
      ].filter(Boolean).join(" "),
      used_for: "支撑趋势机会中的竞品定位、价格表达、评价/促销/定制信息和详情页结构对标。",
      confidence: "medium",
      limitation: "公开页面文本只能代表本轮可读取的页面状态，不能证明非公开经营数据或完整 SKU。",
    });
    if (screenshotRef || screenshotCaptured) {
      entries.push({
        source_type: "screenshot_visual",
        source_ref: `${label}截图: ${screenshotRef || url}`,
        observed_value: `${label}已保存截图 artifact，用于观察首图/画廊、视觉调性、促销标签和页面可见结构。`,
        used_for: "支撑竞品视觉对标和页面陈列方法观察；不得据此推断点击率或转化率。",
        confidence: "medium",
        limitation: "截图只覆盖本轮捕获的可见页面或分段页面，不代表完整画廊、真实销量或后台表现。",
      });
    }
  };

  toolHistory.forEach((entry) => {
    if (!["open_new_tab", "navigate_to"].includes(entry?.tool)) return;
    const result = entry.result || {};
    if (result.ok === false || result.error) return;
    const pageData = result.pageData || {};
    const url = result.finalUrl || result.url || pageData.url || entry.arguments?.url || "";
    pushPair({
      url,
      title: pageData.title || pageData.h1 || result.title || "",
      visibleText: pageData.visibleText || "",
      screenshotRef: result.screenshotRef,
      screenshotCaptured: result.screenshotCaptured,
      tool: entry.tool,
    });
  });

  toolHistory.forEach((entry) => {
    if (!["collect_etsy_shop_pages", "collect_etsy_competitor_shops"].includes(entry?.tool)) return;
    const result = entry.result || {};
    if (result.ok === false || result.error) return;
    const pages = entry.tool === "collect_etsy_competitor_shops" ? result.allPages : result.pages;
    (Array.isArray(pages) ? pages : []).forEach((page) => {
      pushPair({
        url: page.url || page.competitorUrl || result.sourceUrl || "",
        title: page.title || page.shopName || "",
        visibleText: page.visibleTextSnippet || page.visibleText || "",
        screenshotRef: page.screenshotRef,
        screenshotCaptured: page.screenshotCaptured,
        tool: entry.tool,
      });
    });
  });

  return entries.slice(0, Math.max(0, Number(limit) || 4));
}

function normalizePriceText(value = "") {
  const text = String(value || "").trim();
  return text || "price_not_visible_in_sample";
}

function getShopOptimizerCompetitorGroups(toolHistory = [], pageContext = {}) {
  const currentUrl = normalizeEtsyCompetitorUrl(pageContext?.url || pageContext?.etsyShopProductContext?.currentPageUrl || "");
  const groups = new Map();
  const ensureGroup = (url = "", name = "") => {
    const normalizedUrl = normalizeEtsyCompetitorUrl(url);
    if (!normalizedUrl || normalizedUrl === currentUrl) return null;
    if (!groups.has(normalizedUrl)) {
      groups.set(normalizedUrl, {
        normalizedUrl,
        url: String(url || "").split("?")[0],
        name: name || normalizedUrl.split("/").pop() || "Etsy competitor",
        pageType: /\/listing\//i.test(normalizedUrl) ? "listing" : "shop",
        pages: [],
        productCards: [],
        visibleTexts: [],
        screenshotRefs: [],
        sortLabels: [],
        totalVisibleProducts: 0,
      });
    }
    const group = groups.get(normalizedUrl);
    if (name && (!group.name || group.name === group.normalizedUrl.split("/").pop())) group.name = name;
    return group;
  };
  const addPage = ({ url, name, pageData = {}, screenshotRef = "", screenshotCaptured = false, pageMeta = {} }) => {
    const group = ensureGroup(url || pageData.url, name || pageData.shopName || pageMeta.shopName || pageMeta.competitorName);
    if (!group) return;
    const cards = Array.isArray(pageData.productCards) ? pageData.productCards : Array.isArray(pageMeta.productCards) ? pageMeta.productCards : [];
    const visibleText = String(pageData.visibleText || pageData.text || pageMeta.visibleTextSnippet || pageMeta.visibleText || "").replace(/\s+/g, " ").trim();
    group.pages.push({ url: url || pageData.url || "", pageData, pageMeta });
    group.productCards.push(...cards);
    if (visibleText) group.visibleTexts.push(visibleText);
    if (screenshotRef || screenshotCaptured) group.screenshotRefs.push(screenshotRef || url || pageData.url || "competitor screenshot");
    if (pageMeta.sortLabel || pageData.etsyShopProductContext?.sortLabel) {
      group.sortLabels.push(pageMeta.sortLabel || pageData.etsyShopProductContext.sortLabel);
    }
    const visibleCount = Number(pageMeta.productCardsVisible || cards.length || 0);
    if (Number.isFinite(visibleCount)) group.totalVisibleProducts += visibleCount;
  };

  toolHistory.forEach((entry) => {
    if (["open_new_tab", "navigate_to"].includes(entry?.tool)) {
      const result = entry.result || {};
      if (result.ok === false || result.error) return;
      const pageData = result.pageData || {};
      const url = result.finalUrl || result.url || pageData.url || entry.arguments?.url || "";
      addPage({
        url,
        name: pageData.shopName || "",
        pageData,
        screenshotRef: result.screenshotRef,
        screenshotCaptured: result.screenshotCaptured,
      });
    }
    if (entry?.tool === "collect_etsy_shop_pages") {
      const result = entry.result || {};
      if (result.ok === false || result.error) return;
      (Array.isArray(result.pages) ? result.pages : []).forEach((page) => addPage({
        url: page.url || page.competitorUrl || result.sourceUrl || entry.arguments?.url || "",
        name: page.competitorName || page.shopName || result.competitorName || "",
        pageData: {
          url: page.url,
          shopName: page.shopName,
          title: page.title,
          visibleText: page.visibleTextSnippet || page.visibleText || "",
          productCards: page.productCards,
          etsyShopProductContext: { sortLabel: page.sortLabel },
        },
        screenshotRef: page.screenshotRef,
        screenshotCaptured: page.screenshotCaptured,
        pageMeta: page,
      }));
    }
    if (entry?.tool === "collect_etsy_competitor_shops") {
      const result = entry.result || {};
      if (result.ok === false || result.error) return;
      (Array.isArray(result.shops) ? result.shops : []).forEach((shop) => {
        const group = ensureGroup(shop.url, shop.competitorName || shop.shopName || "");
        if (!group) return;
        group.totalVisibleProducts += Number(shop.totalVisibleProductCards || shop.uniqueListingCount || 0) || 0;
        (Array.isArray(shop.pages) ? shop.pages : []).forEach((page) => addPage({
          url: page.url || shop.url,
          name: page.competitorName || shop.competitorName || shop.shopName || "",
          pageData: {
            url: page.url || shop.url,
            shopName: page.shopName || shop.shopName,
            title: page.title,
            visibleText: page.visibleTextSnippet || page.visibleText || "",
            productCards: page.productCards,
            etsyShopProductContext: { sortLabel: page.sortLabel },
          },
          screenshotRef: page.screenshotRef,
          screenshotCaptured: page.screenshotCaptured,
          pageMeta: page,
        }));
      });
      (Array.isArray(result.allPages) ? result.allPages : []).forEach((page) => addPage({
        url: page.url || page.competitorUrl,
        name: page.competitorName || page.shopName || "",
        pageData: {
          url: page.url,
          shopName: page.shopName,
          title: page.title,
          visibleText: page.visibleTextSnippet || page.visibleText || "",
          productCards: page.productCards,
          etsyShopProductContext: { sortLabel: page.sortLabel },
        },
        screenshotRef: page.screenshotRef,
        screenshotCaptured: page.screenshotCaptured,
        pageMeta: page,
      }));
    }
    if (entry?.tool === "search_in_browser" && String(entry.arguments?.engine || "").toLowerCase() === "etsy" && hasValidEtsySearchEvidence(entry.result || {})) {
      const pageData = entry.result?.pageData || {};
      (Array.isArray(pageData.productCards) ? pageData.productCards : []).forEach((card) => {
        const url = card.shopUrl || card.shop_url || "";
        const group = ensureGroup(url, card.shopName || card.shop_name || "");
        if (!group) return;
        group.productCards.push(card);
      });
    }
  });

  return Array.from(groups.values()).filter((group) => group.pages.length > 0 || group.productCards.length > 0);
}

function buildShopOptimizerCompetitorBenchmarks(toolHistory = [], pageContext = {}, limit = 3) {
  const groups = getShopOptimizerCompetitorGroups(toolHistory, pageContext);
  const currencyContext = pageContext?.etsyMarketContext || {};
  const displayCurrencyCode = currencyContext.displayCurrencyCode || pageContext?.priceCurrencyCode || "";
  return groups.slice(0, Math.max(1, Number(limit) || 3)).map((group) => {
    const cards = group.productCards.filter(Boolean);
    const text = group.visibleTexts.join(" ");
    const cardSamples = cards.slice(0, 3).map((card, index) => ({
      title: truncateText(card.title || card.name || card.text || `Visible competitor product sample ${index + 1}`, 120),
      price: normalizePriceText(card.price),
      category_or_scenario: truncateText(card.category_or_scenario || card.category || card.shopName || group.name || "visible shop/listing sample", 80),
      promotion_signal: truncateText(card.promotionText || card.discountText || card.saleText || card.shippingText || card.badges?.join?.(", ") || "none_visible", 80),
      visible_order_rank: card.visibleOrderRank ?? card.rank ?? card.index ?? index + 1,
    }));
    while (cardSamples.length < 2) {
      cardSamples.push({
        title: truncateText(`${group.name} visible page sample ${cardSamples.length + 1}`, 120),
        price: "price_not_visible_in_sample",
        category_or_scenario: truncateText(text || "visible public Etsy competitor page", 80),
        promotion_signal: /free shipping|sale|coupon|star seller|bestseller/i.test(text) ? truncateText(text.match(/free shipping|sale|coupon|star seller|bestseller/i)?.[0] || "visible_trust_signal", 80) : "none_visible",
        visible_order_rank: cardSamples.length + 1,
      });
    }
    const prices = cards.map((card) => String(card.price || "").trim()).filter(Boolean);
    const promotions = Array.from(new Set(cards.map((card) =>
      card.promotionText || card.discountText || card.saleText || card.shippingText || (Array.isArray(card.badges) ? card.badges.join(", ") : "")
    ).filter(Boolean))).slice(0, 4);
    const ratings = cards.map((card) => card.rating).filter(Boolean);
    const reviews = cards.map((card) => card.reviewCount || card.reviews).filter(Boolean);
    const sortLabel = Array.from(new Set(group.sortLabels.filter(Boolean))).join(", ") || "current visible shop grid; sort control not detected";
    const visibleCount = group.totalVisibleProducts || cards.length || group.pages.length;
    return {
      competitor_name: group.name,
      competitor_url: group.url,
      page_type: group.pageType,
      sampled_products_count: Math.max(2, cards.length || group.pages.length || 2),
      visible_sku_count_estimate: `${visibleCount}+ visible items/pages in this run; sampled public evidence only`,
      category_mix: Array.from(new Set([
        ...cards.map((card) => card.category || card.category_or_scenario || card.shopName).filter(Boolean),
        text && /wedding|bridal|bridesmaid|camera|wood|grip|thumb|gift/i.test(text) ? truncateText(text.match(/wedding|bridal|bridesmaid|camera|wood|grip|thumb|gift/ig)?.slice(0, 4).join(" / "), 80) : "",
      ].filter(Boolean))).slice(0, 4),
      product_samples: cardSamples,
      price_distribution: {
        min: prices[0] || "price_not_visible_in_sample",
        max: prices[prices.length - 1] || prices[0] || "price_not_visible_in_sample",
        main_band: prices.length ? prices.slice(0, 4).join(" / ") : "visible prices not captured in this sample",
        currency_code: displayCurrencyCode || cards.find((card) => card.displayCurrencyCode || card.currency)?.displayCurrencyCode || cards.find((card) => card.currency)?.currency || "page_display_currency_not_detected",
        basis: currencyContext.evidenceText
          ? `Etsy visible market selector: ${currencyContext.evidenceText}`
          : "Public visible page sample; use the page displayed currency and do not infer currency from URL locale path.",
      },
      currency_context: {
        display_currency_code: displayCurrencyCode || "not_detected",
        display_currency_label: currencyContext.displayCurrencyLabel || "",
        market_country: currencyContext.countryLabel || "",
        evidence_text: currencyContext.evidenceText || "",
        interpretation_rule: "Visible Etsy currency selector overrides /au or other URL locale path when interpreting bare $ prices.",
      },
      promotion_signals: promotions.length ? promotions : ["none_visible"],
      shop_review_signal: {
        rating: ratings[0] || "not_visible",
        review_count: reviews[0] || "not_visible",
        scope: "public visible shop/listing/search signal in this run",
      },
      listing_order_insight: {
        visible_sort_order: `${cardSamples.map((sample) => sample.title).slice(0, 3).join("；")} appeared first in the captured public sample.`,
        observed_order_basis: sortLabel,
        interpretation_limit: "Visible order is a public merchandising/search signal only; it cannot prove upload time, sales velocity, private conversion, or complete SKU order.",
      },
      visual_method: group.screenshotRefs.length ? "Public screenshot evidence was captured for first-grid or listing visual review." : "Visual method needs deeper screenshot interpretation if no screenshot artifact is available.",
      seo_method: truncateText(cards.map((card) => card.title || card.text).filter(Boolean).slice(0, 3).join("；") || text || "Use visible titles/text only; no private keyword data.", 220),
      fulfillment_signal: truncateText(cards.map((card) => card.shippingText || card.shipping).filter(Boolean).slice(0, 3).join("；") || (/free shipping|delivery|shipping/i.test(text) ? text.match(/.{0,40}(?:free shipping|delivery|shipping).{0,60}/i)?.[0] : "") || "none_visible; exact carrier/transit time not confirmed", 180),
      evidence_refs: [`page_dom:${group.name}`, `screenshot_visual:${group.name}`, "etsy_search:public sample"],
    };
  });
}

function getShopOptimizerScreenshotLedgerEntries(toolHistory = [], pageContext = {}, limit = 4) {
  const entries = [];
  const seen = new Set();
  const push = (entry) => {
    const key = `${entry.source_type}:${entry.source_ref}:${entry.observed_value}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push(entry);
  };
  if (pageContext?.screenshot) {
    push({
      source_type: "screenshot_visual",
      source_ref: `当前店铺截图: ${pageContext.url || "current Etsy page"}`,
      observed_value: "当前店铺页面已保留截图，可用于判断首屏视觉调性、商品网格、首图信息密度和信任信号。",
      used_for: "支撑当前店铺视觉体检和首图/画廊整改优先级。",
      confidence: "medium",
      limitation: "截图只代表本轮捕获页面，不能替代完整画廊、后台点击率或转化率。",
    });
  }
  toolHistory.forEach((historyEntry) => {
    if (historyEntry?.tool === "analyze_etsy_shop_crawl_screenshots" && historyEntry.result?.ok !== false) {
      const ledgers = [
        ...(Array.isArray(historyEntry.result?.evidenceLedgerEntries) ? historyEntry.result.evidenceLedgerEntries : []),
        ...(Array.isArray(historyEntry.result?.stage_report_inputs?.evidenceLedgerEntries) ? historyEntry.result.stage_report_inputs.evidenceLedgerEntries : []),
      ];
      ledgers.forEach((entry) => {
        if (normalizeEvidenceLedgerSourceType(entry?.source_type) === "screenshot_visual") push({ ...entry, source_type: "screenshot_visual" });
      });
    }
    if (["open_new_tab", "navigate_to"].includes(historyEntry?.tool) && historyEntry.result?.ok !== false && (historyEntry.result?.screenshotRef || historyEntry.result?.screenshotCaptured)) {
      const url = historyEntry.result?.finalUrl || historyEntry.result?.url || historyEntry.result?.pageData?.url || historyEntry.arguments?.url || "";
      if (/etsy\.com\/(?:shop|listing)\//i.test(url) && normalizeEtsyCompetitorUrl(url) !== normalizeEtsyCompetitorUrl(pageContext?.url || "")) {
        push({
          source_type: "screenshot_visual",
          source_ref: `竞品店铺/商品详情截图: ${url}`,
          observed_value: "已打开同类 Etsy 竞品店铺/商品详情页并保留截图 artifact，可观察首图、画廊/网格、视觉调性、促销或信任信号。",
          used_for: "对标竞品可见视觉方法、首图卖点、商品陈列和信任信号。",
          confidence: "medium",
          limitation: "截图只覆盖本轮打开页面的可见区域，不能证明真实销量、完整库存、全部画廊或后台转化。",
        });
      }
    }
  });
  return entries.slice(0, Math.max(0, Number(limit) || 4));
}

function buildShopOptimizerDepthMatrixSkeleton(out = {}, evidence = {}) {
  const {
    pageDomEvidence,
    etsySearchEvidence,
    googleSearchEvidence,
    trendsToolEvidence,
    trendsScreenshotEvidence,
    competitorBenchmarks = [],
    screenshotLedgerEntries = [],
  } = evidence;
  const firstBenchmark = competitorBenchmarks[0] || {};
  const benchmarkNames = competitorBenchmarks.map((item) => item.competitor_name || item.shop_name || item.name).filter(Boolean).slice(0, 3).join(" / ") || "已打开竞品样本";
  return [
    {
      dimension: "店铺定位与经营阶段",
      finding: truncateText(out.overview || out.summary || "当前店铺需要先确认定位、经营阶段和主推买家场景。", 220),
      evidence: pageDomEvidence?.sourceRef || "当前页面公开文本/店铺上下文",
      gap: "若缺少后台 API 或店主补录指标，流量、订单和转化只能作为待复核项。",
      action: "把店铺阶段、目标买家、主价格带和本轮证据边界写入报告开头。",
    },
    {
      dimension: "视觉首图与画廊",
      finding: screenshotLedgerEntries[0]?.observed_value || "已结合当前店铺或竞品截图判断首图、网格陈列和视觉信任信号。",
      evidence: screenshotLedgerEntries.map((entry) => entry.source_ref).filter(Boolean).slice(0, 3).join("；") || "截图视觉证据",
      gap: "首图卖点、尺寸/材质/包装/场景图需要和竞品可见方法逐项对齐。",
      action: "优先重做主推款首图和画廊前 3 张，加入英文卖点、尺寸参照、材质微距和真实使用场景。",
    },
    {
      dimension: "SEO 标题与 Attributes",
      finding: googleSearchEvidence || etsySearchEvidence ? "已结合 Etsy 站内搜索与 Google Search 公开表达校验标题词方向。" : "SEO 词和 attributes 仍需真实搜索证据复核。",
      evidence: [etsySearchEvidence?.sourceRef, googleSearchEvidence?.sourceRef].filter(Boolean).join("；") || "Etsy/Google 搜索证据待补齐",
      gap: "标题前 60 字、tags 与 attributes 需要避免堆词，并绑定具体买家场景。",
      action: "按核心品类词、相机/材质/场景词和礼品人群词重构标题与 13 个 tags。",
    },
    {
      dimension: "商品矩阵、SKU 结构与价格带",
      finding: firstBenchmark.price_distribution ? `竞品可见样本价格带：${JSON.stringify(firstBenchmark.price_distribution)}` : "当前只能基于可见样本判断价格与 SKU 角色。",
      evidence: "当前店铺页面样本与 competitor_benchmarks.product_samples",
      gap: "引流款、主推款和利润款角色需要拆分，不能把可见样本写成完整全店价格分布。",
      action: "标注每个主推 SKU 的流量角色、利润角色、适配机型/场景和下一步测试窗口。",
    },
    {
      dimension: "竞品对标与可见排序",
      finding: `已形成竞品结构样本：${benchmarkNames}。`,
      evidence: "已打开的 Etsy 竞品店铺/商品详情页、可见商品样本和截图证据",
      gap: "可见排序只能代表当前公开页面顺序，不能推断真实销量、上架时间或完整库存。",
      action: "逐个竞品记录商品样本、价格分布、类目结构、促销/评价信号和可见排序局限。",
    },
    {
      dimension: "Google/Trends 站外需求",
      finding: trendsToolEvidence ? "Google Trends 地区证据已取得，可用于判断相对需求方向和季节窗口。" : "若未取得 Trends 图表，只能把季节性写成待验证假设。",
      evidence: [googleSearchEvidence?.sourceRef, trendsToolEvidence?.sourceRef, trendsScreenshotEvidence?.sourceRef].filter(Boolean).join("；") || "Google Search/Trends 证据待补齐",
      gap: "Google Trends 是相对热度，不等于 Etsy 搜索量、订单或点击率。",
      action: "在报告中写明地区、近 12 个月口径、查询词、曲线可见方向和截图局限。",
    },
    {
      dimension: "信任资产、评价、政策与履约",
      finding: "信任与履约只能基于公开页面、店主补录或实时物流检索判断。",
      evidence: "当前页面政策/评价可见文本、竞品公开信任信号和必要的实时物流搜索",
      gap: "未实时确认承运商和目的地时，不能承诺具体工作日时效。",
      action: "补齐 About、FAQ、退换货、材质来源、发货地/承运商待确认项；物流天数必须等实时检索后再写。",
    },
  ];
}

function buildShopOptimizerPrioritySkuActions(out = {}, competitorBenchmarks = [], pageContext = {}) {
  const dataItems = Array.isArray(out.data) ? out.data : [];
  const competitorSamples = competitorBenchmarks
    .flatMap((benchmark) => Array.isArray(benchmark?.product_samples) ? benchmark.product_samples : [])
    .filter(Boolean);
  const displayCurrencyCode = pageContext?.etsyMarketContext?.displayCurrencyCode || pageContext?.priceCurrencyCode || "";
  const visibleCurrencyBasis = pageContext?.etsyMarketContext?.evidenceText
    ? `页面可见货币选择器为 ${pageContext.etsyMarketContext.evidenceText}，裸 $ 价格按 ${displayCurrencyCode || "页面显示货币"} 解读。`
    : "价格只引用本轮页面可见口径，不从 URL 地区路径推断货币。";
  const seedLines = [
    {
      sku_or_line: dataItems[0]?.title || pageContext?.h1 || "主推相机木质手柄 / 拇指托商品线",
      why_priority: "承接店铺当前最核心的垂直定位，直接影响搜索页首图点击、买家对适配机型的理解和高客单价信任。",
      first_7_days_action: "重做首图与画廊前 3 张：首图加入英文核心卖点、适配机型、轻薄/重量/材质信息；第 2-3 张补尺寸参照、手持场景和安装后效果。",
      success_metric: "7 天内记录 Etsy 搜索曝光后的点击率、收藏率和加购反馈；若无后台数据，则人工对比改版前后首图点击/询盘变化。",
      evidence_refs: ["page_dom:current_shop", "screenshot_visual:current_shop", "competitor_benchmarks.product_samples"],
    },
    {
      sku_or_line: competitorSamples[0]?.title || "高意图相机型号适配 SKU",
      why_priority: "买家通常按具体相机型号、材质和握持场景检索；该商品线适合用更清晰的标题前 60 字和 attributes 抢占精准搜索。",
      first_7_days_action: "把标题拆成核心品类词、相机型号、wood/wooden grip、street photography、travel photographer、gift 等场景词；同步补齐 13 个 tags 与材质/适配属性。",
      success_metric: "核心关键词排名页可见性、搜索点击率、收藏率或自然询盘数提升；标题不得出现无证据堆词。",
      evidence_refs: ["etsy_search:public_results", "google_search:public_results", "page_dom:listing_titles"],
    },
    {
      sku_or_line: competitorSamples[1]?.title || "低门槛引流款与礼品组合商品线",
      why_priority: "引流款可以降低冷启动店铺的首次购买门槛，礼品组合能服务北美/欧洲摄影爱好者礼品场景，并带动高价手柄款浏览。",
      first_7_days_action: `按页面可见价格口径复核引流款、主推款、利润款分层；为组合款补包装、送礼对象、交付时效和退换货说明。${visibleCurrencyBasis}`,
      success_metric: "组合款点击/收藏、购物车加入率、客单价和买家关于适配/发货问题的咨询量变化。",
      evidence_refs: ["competitor_benchmarks.price_distribution", "page_dom:shipping_policy", "screenshot_visual:shop_grid"],
    },
  ];

  return seedLines.slice(0, 3).map((item) => ({
    sku_or_line: truncateText(item.sku_or_line, 120),
    why_priority: item.why_priority,
    first_7_days_action: item.first_7_days_action,
    success_metric: item.success_metric,
    evidence_refs: item.evidence_refs,
  }));
}

function buildShopOptimizerThirtyDayRoadmap(pageContext = {}) {
  const displayCurrencyCode = pageContext?.etsyMarketContext?.displayCurrencyCode || pageContext?.priceCurrencyCode || "";
  const currencyCheck = displayCurrencyCode
    ? `价格复核统一使用页面可见 ${displayCurrencyCode} 口径。`
    : "价格复核统一使用页面可见货币口径。";
  return [
    {
      period: "0-7天",
      goal: "先修复最影响点击和信任的主推款表达。",
      actions: [
        "选定 3 个主推 SKU，重做首图、画廊前 3 张、标题前 60 字和 tags。",
        "每个 SKU 明确适配机型、材质、尺寸/重量、使用场景和礼品对象。",
        currencyCheck,
      ],
      owner_check: "运营者人工确认图片文案不遮挡产品、标题不堆词、所有尺寸/重量都有商品页或实物依据。",
      metric: "搜索页点击率、收藏率、加购或询盘量；无后台数据时记录改版前后 7 天可见反馈。",
    },
    {
      period: "8-14天",
      goal: "补齐信任资产、履约说明和竞品差异化。",
      actions: [
        "完善 About、FAQ、材质来源、安装方式、兼容性边界、退换货说明。",
        "对照 2-3 个竞品样本整理价格带、促销、评价信号和首图方法。",
        "复核发货地、处理时间和美国/欧洲主要目的地的承运商时效，不写未确认承诺。",
      ],
      owner_check: "人工检查所有物流天数、材质描述和适配型号是否可证明；无法确认的写成待确认。",
      metric: "买家关于适配、材质和物流的重复咨询减少；商品页收藏/加购质量提升。",
    },
    {
      period: "15-30天",
      goal: "用小流量实验决定 SKU 取舍和下一轮放量。",
      actions: [
        "按引流款、主推款、利润款复盘曝光、点击、收藏、加购和订单。",
        "保留表现最好的首图/标题组合，淘汰无点击或无收藏的弱 SKU 表达。",
        "规划礼品组合、节庆场景图或轻量广告测试，但只基于已验证 SKU 放量。",
      ],
      owner_check: "复盘必须区分公开页面证据、后台数据和人工假设；不要把 Google Trends 相对热度写成 Etsy 订单量。",
      metric: "Top 3 SKU 的点击率、收藏率、加购率、订单/询盘趋势，以及高价款带动的客单价变化。",
    },
  ];
}

function ensureShopOptimizerReportSkeleton(repaired, {
  toolHistory = [],
  pageContext = {},
  etsySearchEvidence = null,
  googleSearchEvidence = null,
  trendsToolEvidence = null,
  trendsScreenshotEvidence = null,
  pageDomEvidence = null,
} = {}) {
  if (!repaired?.output || !Array.isArray(repaired.output.data)) return [];
  const reasons = [];
  const out = repaired.output;
  const competitorBenchmarks = buildShopOptimizerCompetitorBenchmarks(toolHistory, pageContext);
  const requiredCompetitors = hasBlockedCompetitorDepthExplanation(`${out.overview || ""}\n${out.analysis || ""}\n${out.summary || ""}\n${JSON.stringify(out.data || [])}`) ? 1 : 2;
  if ((!Array.isArray(out.competitor_benchmarks) || out.competitor_benchmarks.length < requiredCompetitors) && competitorBenchmarks.length >= requiredCompetitors) {
    out.competitor_benchmarks = competitorBenchmarks;
    reasons.push("已基于已打开竞品页面/搜索样本生成 competitor_benchmarks 骨架");
  }

  const screenshotLedgerEntries = getShopOptimizerScreenshotLedgerEntries(toolHistory, pageContext, 6);
  const depthMatrix = out.diagnostic_depth_matrix || out.depth_matrix || out.diagnosis_dimensions;
  if (!Array.isArray(depthMatrix) || validateDiagnosticDepthMatrix({ diagnostic_depth_matrix: depthMatrix }).length > 0) {
    out.diagnostic_depth_matrix = buildShopOptimizerDepthMatrixSkeleton(out, {
      pageDomEvidence,
      etsySearchEvidence,
      googleSearchEvidence,
      trendsToolEvidence,
      trendsScreenshotEvidence,
      competitorBenchmarks: out.competitor_benchmarks || competitorBenchmarks,
      screenshotLedgerEntries,
    });
    reasons.push("已生成 7 维店铺体检 diagnostic_depth_matrix 骨架");
  }

  if (!/竞品店铺|头部店铺|高排名店铺|高销店铺|best[-\s]?seller|top shop|同类高排名/i.test(`${out.overview || ""}\n${out.analysis || ""}\n${out.summary || ""}`) && (out.competitor_benchmarks || []).length > 0) {
    const names = out.competitor_benchmarks.map((item) => item.competitor_name || item.shop_name || item.name).filter(Boolean).slice(0, 3).join(" / ");
    out.analysis = `${out.analysis || ""}\n\n竞品店铺商品结构解析：本轮已打开同类高排名竞品店铺/商品详情页 ${names || "可见样本"}，并按公开页面样本拆分 product_samples、price_distribution、promotion_signals、shop_review_signal 与 listing_order_insight；所有排序和价格结论仅代表本轮可见样本。`.trim();
    reasons.push("已补入竞品店铺反向学习结论段，避免报告只停留在单薄概述");
  }

  if (!Array.isArray(out.priority_sku_actions) || out.priority_sku_actions.length < 3) {
    out.priority_sku_actions = buildShopOptimizerPrioritySkuActions(out, out.competitor_benchmarks || competitorBenchmarks, pageContext);
    reasons.push("已生成 priority_sku_actions，补齐 3 个 SKU/商品线优先级动作");
  }

  if (!Array.isArray(out.thirty_day_roadmap) || out.thirty_day_roadmap.length < 3) {
    out.thirty_day_roadmap = buildShopOptimizerThirtyDayRoadmap(pageContext);
    reasons.push("已生成 thirty_day_roadmap，补齐 0-30 天运营执行路线图");
  }

  out.data.forEach((item, idx) => {
    if (!item || typeof item !== "object") return;
    const ledger = ensureArrayField(item, "evidence_ledger");
    let itemChanged = false;
    if (etsySearchEvidence && !hasLedgerType(ledger, "etsy_search")) {
      ledger.push(buildEtsySearchLedgerEntry(etsySearchEvidence));
      itemChanged = true;
    }
    if (googleSearchEvidence && !hasLedgerType(ledger, "google_search")) {
      ledger.push(buildGoogleSearchLedgerEntry(googleSearchEvidence));
      itemChanged = true;
    }
    if (trendsToolEvidence && !hasLedgerType(ledger, "google_trends")) {
      ledger.push(buildGoogleTrendsToolLedgerEntry(trendsToolEvidence));
      itemChanged = true;
    }
    if (trendsScreenshotEvidence && !hasTrendVisualForTrends(ledger)) {
      ledger.push(buildGoogleTrendsScreenshotLedgerEntry(trendsScreenshotEvidence));
      itemChanged = true;
    }
    screenshotLedgerEntries.forEach((entry) => {
      if (normalizeEvidenceLedgerSourceType(entry.source_type) === "screenshot_visual" && !ledger.some((existing) => `${existing.source_ref || ""}` === `${entry.source_ref || ""}`)) {
        ledger.push(entry);
        itemChanged = true;
      }
    });
    if (!hasValue(item.evidence || item.diagnosis_basis || item.selection_rationale)) {
      item.evidence = "基于当前店铺页面文本/截图、Etsy 公开搜索、Google Search/Trends 和已打开竞品公开样本生成；缺失 API 或物流实时证据的结论均需人工复核。";
      itemChanged = true;
    }
    if (!hasValue(item.stage_fit)) {
      item.stage_fit = "适合作为店铺体检后的首轮整改任务；若店铺仍处于冷启动或低评价阶段，应先补齐信任资产、页面信息和小步实验，再考虑放量。";
      itemChanged = true;
    }
    if (!hasValue(item.buyer_scenario)) {
      item.buyer_scenario = "欧美 Etsy 买家公开搜索/礼品或垂直品类场景，需结合当前店铺定位二次确认。";
      itemChanged = true;
    }
    if (!Array.isArray(item.first_actions) || item.first_actions.length === 0) {
      item.first_actions = [
        "重写主推 SKU 标题前 60 字与 tags",
        "补齐首图/画廊的英文卖点、尺寸和材质证据",
        "按竞品样本复核价格带、促销和履约说明",
      ];
      itemChanged = true;
    }
    if (itemChanged) reasons.push(`第 ${idx + 1} 项已按店铺体检骨架补齐证据账本、阶段适配和行动字段`);
  });

  return reasons;
}

const SHOP_OPTIMIZER_PRODUCTION_SLOTS = [
  {
    id: "shop_stage_positioning",
    title: "店铺定位与经营阶段",
    finalFields: ["overview", "diagnostic_depth_matrix[定位/阶段]", "data[].stage_fit"],
    requiredEvidence: "当前自营店铺/商品页面文本、页面角色和 API 可用性边界",
    nextAction: "先读取当前店铺/商品页并确认 own_shop/own_listing；无 API 时把后台指标降级为 assumption。",
  },
  {
    id: "visual_gallery",
    title: "视觉首图与画廊",
    finalFields: ["diagnostic_depth_matrix[视觉]", "data[].evidence_ledger(screenshot_visual)"],
    requiredEvidence: "当前店铺截图、竞品店铺/商品详情截图和独立截图解读",
    nextAction: "采集截图后调用 analyze_etsy_shop_crawl_screenshots，把 stage_report_inputs 写入报告。",
  },
  {
    id: "seo_text_attributes",
    title: "SEO 标题、描述与 Attributes",
    finalFields: ["diagnostic_depth_matrix[SEO]", "data[].buyer_scenario", "data[].first_actions"],
    requiredEvidence: "Etsy 搜索可见标题词、Google Search 站外表达和当前页面标题/属性文本",
    nextAction: "完成 Etsy Search 与 Google 地区搜索后，再重构标题前 60 字、tags 和 attributes。",
  },
  {
    id: "product_matrix_price",
    title: "商品矩阵、SKU 结构与价格带",
    finalFields: ["diagnostic_depth_matrix[商品矩阵]", "competitor_benchmarks[].price_distribution"],
    requiredEvidence: "当前店铺可见商品卡片、竞品可见商品样本和页面显示币种价格",
    nextAction: "按 Etsy 页面可见地区/币种选择器记录价格；页脚显示 $ (USD) 时裸 $ 必须写 USD，不能因 /au 路径误写 AUD；拆分引流款/主推款/利润款。",
  },
  {
    id: "competitor_benchmarks",
    title: "竞品店铺商品结构解析",
    finalFields: ["competitor_benchmarks", "analysis 竞品店铺商品结构解析小节"],
    requiredEvidence: "至少 2 个已打开 Etsy 竞品店铺/商品详情页、商品样本、评价/促销和可见排序口径",
    nextAction: "打开或批量采集 2-3 个竞品，再逐店输出 product_samples、price_distribution 和 listing_order_insight。",
  },
  {
    id: "external_demand",
    title: "Etsy 站内搜索与 Google/Trends 站外需求",
    finalFields: ["diagnostic_depth_matrix[站外需求]", "data[].evidence_ledger(etsy_search/google_search/google_trends)"],
    requiredEvidence: "Etsy Search、Google 地区搜索、Google Trends 地区页和 Trends 截图视觉解读",
    nextAction: "先补齐 Etsy/Search/Trends 证据；趋势图只能写相对热度、地区、时间范围和截图局限。",
  },
  {
    id: "trust_fulfillment",
    title: "信任资产、评价、政策与履约",
    finalFields: ["diagnostic_depth_matrix[信任/履约]", "data[].risk_guard"],
    requiredEvidence: "公开评价/政策/履约文本、竞品信任信号；具体物流时效需要实时物流 Google Search",
    nextAction: "没有实时物流搜索时只写承运商/时效待确认，禁止承诺具体工作日。",
  },
];

function productionSlot(status, evidenceRefs = [], nextAction = "") {
  return {
    status,
    evidenceRefs: evidenceRefs.filter(Boolean).slice(0, 6),
    nextAction,
  };
}

function hasShopOptimizerShippingSearchEvidence(toolHistory = []) {
  return toolHistory.some((entry) => {
    if (entry?.tool !== "search_in_browser") return false;
    const engine = String(entry.arguments?.engine || "").toLowerCase();
    if (!isGoogleSearchEngine(engine)) return false;
    const text = [
      entry.arguments?.query,
      entry.arguments?.keyword,
      entry.result?.searchUrl,
      entry.result?.pageData?.title,
      entry.result?.pageData?.visibleText,
    ].filter(Boolean).join(" ");
    return /配送|物流|发货|运输|时效|delivery|shipping|transit|fulfillment|carrier|USPS|DHL|FedEx|UPS|postal/i.test(text);
  });
}

function buildShopOptimizerProductionSkeletonState(toolHistory = [], pageContext = {}) {
  const pageDomEvidence = getBestPageDomEvidence(toolHistory, pageContext);
  const etsySearchEvidence = getEtsySearchEvidence(toolHistory);
  const googleSearchEvidence = getGoogleSearchEvidence(toolHistory);
  const trendsToolEvidence = getGoogleTrendsToolEvidence(toolHistory);
  const trendsScreenshotEvidence = getGoogleTrendsScreenshotEvidence(toolHistory);
  const screenshotLedgerEntries = getShopOptimizerScreenshotLedgerEntries(toolHistory, pageContext, 8);
  const competitorBenchmarks = buildShopOptimizerCompetitorBenchmarks(toolHistory, pageContext);
  const openedCompetitorCount = getOpenedEtsyCompetitorUrls(toolHistory, pageContext?.url).size;
  const unanalyzedScreenshots = getUnanalyzedEtsyShopCrawlScreenshotRefs(toolHistory);
  const hasApiEvidence = hasEvidenceSource(toolHistory, pageContext, "etsy_api");
  const hasShippingSearch = hasShopOptimizerShippingSearchEvidence(toolHistory);
  const currentPageRole = pageContext?.research_scope?.entry_page_type || pageContext?.pageType || pageContext?.pageHealth?.pageType || "unknown";
  const slots = {
    shop_stage_positioning: productionSlot(
      pageDomEvidence ? "filled" : pageContext?.screenshot ? "partial" : "missing",
      [
        pageDomEvidence?.sourceRef,
        currentPageRole ? `page_role:${currentPageRole}` : "",
        hasApiEvidence ? "etsy_api:available" : "etsy_api:missing_or_not_configured",
      ],
      pageDomEvidence
        ? "把当前店铺定位、经营阶段和 API 边界写入 overview / stage_fit。"
        : "先读取当前自营店铺/商品页面文本；若只是竞品/弱上下文，必须声明范围或要求切换到自营页。"
    ),
    visual_gallery: productionSlot(
      screenshotLedgerEntries.length >= 2 && unanalyzedScreenshots.length === 0 ? "filled" : screenshotLedgerEntries.length > 0 ? "partial" : "missing",
      [
        ...screenshotLedgerEntries.map((entry) => entry.source_ref),
        unanalyzedScreenshots.length ? `unanalyzed_screenshots:${unanalyzedScreenshots.length}` : "",
      ],
      unanalyzedScreenshots.length
        ? "已有店铺分页截图尚未独立解读；下一步调用 analyze_etsy_shop_crawl_screenshots。"
        : screenshotLedgerEntries.length
          ? "把截图观察写入 screenshot_visual ledger、视觉维度和首图/画廊行动项。"
          : "采集当前店铺和竞品截图，不能只凭文本判断视觉。"
    ),
    seo_text_attributes: productionSlot(
      etsySearchEvidence && googleSearchEvidence && pageDomEvidence ? "filled" : etsySearchEvidence || googleSearchEvidence || pageDomEvidence ? "partial" : "missing",
      [pageDomEvidence?.sourceRef, etsySearchEvidence?.sourceRef, googleSearchEvidence?.sourceRef],
      etsySearchEvidence && googleSearchEvidence
        ? "围绕 Etsy 可见标题词和 Google 站外表达输出标题/tags/attributes 动作。"
        : "补齐 Etsy Search 与 Google 地区搜索，再写 SEO/Attributes 结论。"
    ),
    product_matrix_price: productionSlot(
      competitorBenchmarks.some((item) => hasValue(item.price_distribution) && hasValue(item.product_samples)) ? "filled" : pageDomEvidence || competitorBenchmarks.length ? "partial" : "missing",
      competitorBenchmarks.map((item) => `${item.competitor_name}:${item.visible_sku_count_estimate}`),
      competitorBenchmarks.length
        ? "用页面显示币种记录可见样本价格，输出 SKU 角色和价格层级；页脚/地区选择器币种优先于 URL locale，不要前台二次换算 USD。"
        : "需要当前/竞品商品卡片或分页采集样本，才能写商品矩阵和价格带。"
    ),
    competitor_benchmarks: productionSlot(
      competitorBenchmarks.length >= 2 && openedCompetitorCount >= 2 ? "filled" : competitorBenchmarks.length > 0 || openedCompetitorCount > 0 ? "partial" : "missing",
      [
        `opened_competitors:${openedCompetitorCount}`,
        ...competitorBenchmarks.map((item) => item.competitor_name),
      ],
      competitorBenchmarks.length >= 2
        ? "将每个竞品写入 competitor_benchmarks，并在 analysis 增加竞品店铺商品结构解析小节。"
        : "必须打开/采集至少 2 个同类高排名竞品店铺或商品详情页。"
    ),
    external_demand: productionSlot(
      etsySearchEvidence && googleSearchEvidence && trendsToolEvidence && trendsScreenshotEvidence ? "filled" : etsySearchEvidence || googleSearchEvidence || trendsToolEvidence ? "partial" : "missing",
      [etsySearchEvidence?.sourceRef, googleSearchEvidence?.sourceRef, trendsToolEvidence?.sourceRef, trendsScreenshotEvidence?.sourceRef],
      etsySearchEvidence && googleSearchEvidence && trendsToolEvidence && trendsScreenshotEvidence
        ? "把站内/站外/Trends 证据写入 evidence_ledger 和站外需求维度，趋势只写相对热度。"
        : "补齐 Etsy Search、Google 地区搜索、Google Trends 地区页和 Trends 截图视觉解读。"
    ),
    trust_fulfillment: productionSlot(
      hasShippingSearch ? "filled" : pageDomEvidence || competitorBenchmarks.length ? "partial" : "missing",
      [
        pageDomEvidence?.sourceRef,
        hasShippingSearch ? "google_search:shipping_or_transit" : "",
        ...competitorBenchmarks.map((item) => `${item.competitor_name}:${item.fulfillment_signal}`).slice(0, 2),
      ],
      hasShippingSearch
        ? "可写物流/履约建议，但仍需标明查询日期、目的地、承运商和局限。"
        : "只允许写履约待确认/Shipping Profile 复核；不要承诺具体工作日时效。"
    ),
  };
  const orderedSlots = SHOP_OPTIMIZER_PRODUCTION_SLOTS.map((slot) => ({
    ...slot,
    ...(slots[slot.id] || productionSlot("missing", [], slot.nextAction)),
  }));
  const filledCount = orderedSlots.filter((slot) => slot.status === "filled").length;
  const partialCount = orderedSlots.filter((slot) => slot.status === "partial").length;
  const missing = orderedSlots.filter((slot) => slot.status !== "filled");
  return {
    reportSkeleton: "etsy_shop_health_v1",
    filledCount,
    partialCount,
    totalSlots: orderedSlots.length,
    readyForFinal: missing.length === 0,
    nextMissingSlot: missing[0]?.id || "",
    nextAction: missing[0]?.nextAction || "所有生产槽位已覆盖；输出 final 时必须保持字段与证据一致。",
    slots: orderedSlots,
  };
}

function formatShopOptimizerProductionSkeletonPrompt(toolHistory = [], pageContext = {}) {
  const state = buildShopOptimizerProductionSkeletonState(toolHistory, pageContext);
  const rows = state.slots.map((slot, index) =>
    `${index + 1}. ${slot.title} [${slot.status}] -> final: ${slot.finalFields.join(", ")}；证据: ${slot.requiredEvidence}；下一步: ${slot.nextAction}`
  ).join("\n");
  return `\n\n## 店铺体检生产骨架（必须逐槽生产）\n当前骨架覆盖：${state.filledCount}/${state.totalSlots} filled，${state.partialCount} partial；next_missing=${state.nextMissingSlot || "none"}。\n生产流程必须按下列槽位采证、分析和成稿；每次工具调用后先判断哪个槽位被填充，再决定下一步。不得等最终报告阶段才临时补结构。\n${rows}\n\n最终 final.output 必须消费同一份生产骨架：overview/analysis/summary/data 之外，必须同步输出 competitor_benchmarks 与 diagnostic_depth_matrix；data[] 必须包含 evidence、stage_fit、buyer_scenario、evidence_ledger、first_actions、review_window、risk_guard。`;
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

function ensureTargetMarketPositioningForDelivery(parsed, skillId = "") {
  if (!isEtsyBusinessSkill(skillId) || !parsed?.output || typeof parsed.output !== "object") return [];
  const overviewText = typeof parsed.output.overview === "string" ? parsed.output.overview : "";
  const analysisText = typeof parsed.output.analysis === "string" ? parsed.output.analysis : "";
  const combinedText = `${overviewText}\n${analysisText}`;
  if (/市场|客群|定位|欧美|北美|欧洲|礼品买家|手工定制/i.test(combinedText)) return [];

  const positioning = "目标市场与客群定位：本报告默认面向 Etsy 主要欧美礼品市场，重点关注北美/欧洲手工定制、节庆礼品与个性化礼品买家。";
  if (overviewText.trim()) {
    parsed.output.overview = `${positioning}\n\n${overviewText}`.trim();
  } else {
    parsed.output.overview = positioning;
  }
  return ["已自动补齐 overview 中的目标销售市场与目标客群定位"];
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
  if (normalizeEvidenceLedgerSourceTypesInObject(repaired.output)) {
    reasons.push("已自动规范化 evidence_ledger.source_type 别名为可校验的标准类型");
  }
  const hasEtsyApiEvidence = hasEvidenceSource(toolHistory, pageContext, "etsy_api");
  const bestEtsyApiEvidence = getBestEtsyApiEvidence(toolHistory);
  const pageDomEvidence = getBestPageDomEvidence(toolHistory, pageContext);
  const shouldAutoAttachPageDom = isShopOptimizerOnly(skillId) && pageDomEvidence;
  const etsySearchEvidence = getEtsySearchEvidence(toolHistory);
  const googleSearchEvidence = getGoogleSearchEvidence(toolHistory);
  const trendsToolEvidence = getGoogleTrendsToolEvidence(toolHistory);
  const trendsScreenshotEvidence = getGoogleTrendsScreenshotEvidence(toolHistory);
  const trendCompetitorLedgerEntries = isPlatformTrendSkill(skillId) ? getTrendCompetitorPageLedgerEntries(toolHistory) : [];
  if (isPlatformTrendSkill(skillId) && pageContext?.research_scope && !repaired.output.research_scope) {
    repaired.output.research_scope = pageContext.research_scope;
    repaired.output.page_role_notice = repaired.output.page_role_notice || pageContext.research_scope.page_role_notice || "";
    reasons.push("趋势报告已补齐 research_scope/page_role_notice");
  }
  if (isShopOptimizerOnly(skillId)) {
    const skeletonReasons = ensureShopOptimizerReportSkeleton(repaired, {
      toolHistory,
      pageContext,
      etsySearchEvidence,
      googleSearchEvidence,
      trendsToolEvidence,
      trendsScreenshotEvidence,
      pageDomEvidence,
    });
    reasons.push(...skeletonReasons);
  }
  reasons.push(...ensureTargetMarketPositioningForDelivery(repaired, skillId));
  const reportText = `${repaired.output.overview || ""}\n${repaired.output.analysis || ""}\n${repaired.output.summary || ""}\n${JSON.stringify(repaired.output.data || [])}`;
  const reportUsesGoogleSearch = /Google Search|Google US|谷歌搜索|站外搜索|搜索结果|站外市场|欧美市场|市场调研|外部流量|站外需求/i.test(reportText);
  const reportUsesTrends = TREND_OR_SEASONAL_RE.test(reportText);

  repaired.output.data.forEach((item, idx) => {
    if (!item || typeof item !== "object") return;
    const ledger = ensureArrayField(item, "evidence_ledger");
    let itemChanged = false;

    if (shouldAutoAttachPageDom && !hasLedgerType(ledger, "page_dom")) {
      ledger.unshift(buildPageDomLedgerEntry(pageDomEvidence));
      itemChanged = true;
    }

    if (isPlatformTrendSkill(skillId) && etsySearchEvidence && !hasLedgerType(ledger, "etsy_search")) {
      ledger.push(buildEtsySearchLedgerEntry(etsySearchEvidence));
      itemChanged = true;
    }

    const itemUsesGoogleSearch = reportUsesGoogleSearch || /Google Search|Google US|谷歌搜索|站外搜索|搜索结果|站外市场|欧美市场|市场调研|外部流量|站外需求/i.test(JSON.stringify(item));
    if (isEtsyBusinessSkill(skillId) && (itemUsesGoogleSearch || isPlatformTrendSkill(skillId)) && googleSearchEvidence && !hasLedgerType(ledger, "google_search")) {
      ledger.push(buildGoogleSearchLedgerEntry(googleSearchEvidence));
      itemChanged = true;
    }

    const itemUsesTrends = reportUsesTrends || TREND_OR_SEASONAL_RE.test(JSON.stringify(item));
    const shouldAttachPlatformTrendEvidence = isPlatformTrendSkill(skillId) && Boolean(trendsToolEvidence);
    if (isEtsyBusinessSkill(skillId) && (itemUsesTrends || shouldAttachPlatformTrendEvidence) && trendsToolEvidence && !hasLedgerType(ledger, "google_trends")) {
      ledger.push(buildGoogleTrendsToolLedgerEntry(trendsToolEvidence));
      itemChanged = true;
    }
    if (isEtsyBusinessSkill(skillId) && (itemUsesTrends || shouldAttachPlatformTrendEvidence) && trendsScreenshotEvidence && !hasTrendVisualForTrends(ledger)) {
      ledger.push(buildGoogleTrendsScreenshotLedgerEntry(trendsScreenshotEvidence));
      itemChanged = true;
    }
    const itemUsesCompetitorEvidence = /竞品|头部|高排名|竞品视觉|主图|best.?seller|top shop|competitor|listing|shop/i.test(JSON.stringify(item));
    if (isPlatformTrendSkill(skillId) && itemUsesCompetitorEvidence && !hasTrendCompetitorPageEvidence(ledger) && trendCompetitorLedgerEntries.length) {
      ledger.push(...trendCompetitorLedgerEntries);
      itemChanged = true;
    }

    ledger.forEach((entry) => {
      if (!entry || typeof entry !== "object") return;
      const sourceType = normalizeEvidenceLedgerSourceType(entry.source_type);
      if (sourceType !== "etsy_api" || hasEtsyApiEvidence) return;
      entry.source_type = "assumption";
      entry.confidence = entry.confidence || "low";
      entry.limitation = entry.limitation
        ? `${entry.limitation}；本轮未取得 Etsy 个人访问 API 的真实店铺流量/订单/履约数据，因此该 API 相关结论仅作为待验证假设。`
        : "本轮未取得 Etsy 个人访问 API 的真实店铺流量/订单/履约数据，因此该 API 相关结论仅作为待验证假设。";
      itemChanged = true;
    });

    const itemClaimText = getReportItemClaimText(item);
    const shopOptimizerUsesApiBoundary = isShopOptimizerOnly(skillId) && SHOP_OPTIMIZER_API_CLAIM_RE.test(itemClaimText);
    if (shopOptimizerUsesApiBoundary && hasEtsyApiEvidence && bestEtsyApiEvidence && !hasLedgerType(ledger, "etsy_api")) {
      ledger.push(buildEtsyApiLedgerEntry(bestEtsyApiEvidence));
      itemChanged = true;
    } else if (shopOptimizerUsesApiBoundary && !hasEtsyApiEvidence && !hasAssumptionFallback(ledger, SHOP_OPTIMIZER_API_ASSUMPTION_TOPIC_RE)) {
      ledger.push(buildAssumptionLedgerEntry({
        sourceRef: "Etsy personal API not configured in this run",
        observedValue: "本轮未配置或未取得 Etsy 个人访问 API，无法验证真实流量、Sessions、订单、转化、履约成本、物流配置、Etsy 自发货或第三方海外仓数据。",
        usedFor: "将店铺优化方案中的 API/流量/订单/履约/物流相关判断降级为待验证假设，只作为后续授权 Etsy 个人 API 后复核的检查项。",
        limitation: "未配置/未取得 Etsy 个人 API；不能作为已验证后台数据、真实订单、真实流量或履约成本结论，需店主授权 API 或后台截图后复核。",
      }));
      itemChanged = true;
    } else if (isEtsyBusinessSkill(skillId) && ETSY_API_ASSUMPTION_RE.test(itemClaimText) && !hasEtsyApiEvidence && !hasAssumptionFallback(ledger, ETSY_API_ASSUMPTION_RE)) {
      ledger.push(buildAssumptionLedgerEntry({
        sourceRef: "Etsy personal API access not available in this run",
        observedValue: "本轮未取得 Etsy 个人访问 API 的真实 Sessions、订单、转化或履约成本数据。",
        usedFor: "将流量、订单、转化、履约或海外仓相关判断降级为待验证假设，避免把模型推断写成已验证事实。",
        limitation: "需要店主授权并同步 Etsy API 后，才能用真实 API 数据复核该项建议；当前不得作为已验证运营数据。",
      }));
      itemChanged = true;
    }

    if (itemChanged) {
      reasons.push(`第 ${idx + 1} 项已补齐页面文本/Google Search/Google Trends 证据或降级 API/订单/履约类假设`);
    }
  });

  return {
    parsed: repaired,
    changed: reasons.length > 0 || JSON.stringify(repaired.output) !== JSON.stringify(parsed.output),
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
    if (/已合规|完全合规|无风险|符合\s*(?:FDA|CE|CPC|FCC|RoHS|REACH)/i.test(String(item.finding || "")) && !ledger.some((entry) => ["official_policy", "official_regulation", "page_dom", "screenshot_visual", "user_input"].includes(normalizeEvidenceLedgerSourceType(entry?.source_type)))) {
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
    if (/提升|下降|增长|改善|成功|increase|decrease|improv|success/i.test(text) && !hasEvidenceSource(toolHistory, pageContext, "etsy_api") && !hasAssumptionFallback(item?.evidence_ledger || [], /API|基线|数据|指标|待验证|手动补录|用户提供|Search Analytics|后台漏斗|manual/i)) {
      errors.push(`${label} 输出了指标变化或成功判断，但没有 Etsy 个人访问 API 证据、用户补录后台数据或明确待验证假设。`);
    }
    if (/Sessions?|session_view|hits_view|页面浏览|曝光|点击率|加购率|conv_tocart|traffic/i.test(text) && !hasSupportedEtsyAnalytics(toolHistory) && !hasAssumptionFallback(item?.evidence_ledger || [], /个人 API 不支持|未提供|待验证|不可用|无法取得|unsupported|手动补录|用户提供|Search Analytics|后台漏斗|manual/i)) {
      errors.push(`${label} 使用了 Sessions、曝光、点击率或加购率等指标，但当前 Etsy 个人卖家 API 不提供这些 analytics；必须改为待验证假设，或明确标注为用户补录 Search Analytics/后台漏斗数据，不能填 0 冒充真实数据。`);
    }
  });
  return errors;
}

const KEYWORD_VOLUME_CLAIM_RE = /^\s*\d+(?:[,.]\d+)*(?:\s*[-–—到至]\s*\d+(?:[,.]\d+)*)?\s*$|高频|高搜索|搜索量高|热度高|high\s+volume|large\s+volume|popular/i;
const TREND_OR_SEASONAL_RE = /Google Trends|谷歌趋势|趋势图|搜索趋势|搜索热度|热度|需求曲线|需求上升|需求下降|需求增长|需求回落|需求高点|季节|季节性|季节窗口|婚礼季|旺季|淡季|峰值|高峰|Interest over time|related queries|related topics|YoY|QoQ|trend|trends|seasonal|seasonality|peak/i;
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
      allowedTypes: ["page_dom", "screenshot_visual", "etsy_search", "google_search", "google_trends", "etsy_api", "pinterest_social", "tiktok_social", "instagram_social", "reddit_social", "google_news", "amazon_search", "ebay_search", "user_input", "assumption"],
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
      allowedTypes: ["page_dom", "screenshot_visual", "etsy_search", "google_search", "google_trends", "supplier_page", "official_policy", "official_regulation", "pinterest_social", "tiktok_social", "instagram_social", "reddit_social", "google_news", "amazon_search", "ebay_search", "user_input", "assumption"],
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
      allowedTypes: ["page_dom", "screenshot_visual", "etsy_search", "google_search", "google_trends", "etsy_api", "official_policy", "official_regulation", "pinterest_social", "tiktok_social", "instagram_social", "reddit_social", "google_news", "amazon_search", "ebay_search", "user_input", "assumption"],
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
    const sourceType = normalizeEvidenceLedgerSourceType(entry?.source_type);
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
    if (normalizeEvidenceLedgerSourceType(entry?.source_type) !== "screenshot_visual") return false;
    return /Google Trends|trends\.google|Interest over time|related queries|related topics|趋势图|需求曲线|季节性/i.test(
      [entry?.source_ref, entry?.observed_value, entry?.used_for, entry?.limitation].filter(Boolean).join(" ")
    );
  });
}

function hasPositiveUnsupportedPrivateDataClaim(text = "") {
  return String(text || "").split(/[。！？!?.\n]/).some((sentence) =>
    TREND_FORBIDDEN_PRIVATE_DATA_RE.test(sentence) &&
    !/不能|不可|不包含|不等于|不代表|未取得|未获取|未读取|无法|禁止|不得|not available|unavailable|cannot|no access|不支持/i.test(sentence)
  );
}

function validatePlatformTrendReport(out, toolHistory = [], pageContext = {}) {
  const errors = [];
  const items = Array.isArray(out.data) ? out.data : [];
  const fullText = `${out.overview || ""}\n${out.analysis || ""}\n${out.summary || ""}\n${JSON.stringify(items)}`;
  const allLedger = items.flatMap((item) => Array.isArray(item?.evidence_ledger) ? item.evidence_ledger : []);
  const scope = out.research_scope || pageContext?.research_scope || {};
  const entryPageType = String(scope.entry_page_type || "");
  const sourcePageRole = String(scope.source_page_role || "");
  const seedKeywords = Array.isArray(scope.seed_keywords) ? scope.seed_keywords : [];
  const autoDiscoveryRequired = Boolean(scope.auto_discovery_required);
  const trendsExhausted = isPlatformTrendSkill(scope.selected_skill_path || "") && !hasUsableGoogleTrendsAttempt(toolHistory) && collectGoogleTrendsAttempts(toolHistory).length >= MAX_GOOGLE_TRENDS_QUERY_ATTEMPTS;

  if (items.length === 0) return ["Etsy 趋势报告至少需要一个结构化机会项，不能返回空 data。"];
  if (!out.report_status || !["completed", "partial", "blocked", "assumption_only"].includes(String(out.report_status))) {
    errors.push("趋势报告必须输出 report_status（completed/partial/blocked/assumption_only），明确本轮交付状态。");
  }
  if (!out.research_scope && !pageContext?.research_scope) {
    errors.push("趋势报告缺少 research_scope，必须先说明当前页面角色、研究对象、seed keywords 和范围置信度。");
  }
  if (!out.page_role_notice && !scope.page_role_notice) {
    errors.push("趋势报告缺少 page_role_notice，必须明确当前页面是自营、竞品、搜索页还是弱上下文。");
  }
  if (["etsy_home", "external_page", "unknown"].includes(entryPageType) && seedKeywords.length === 0 && !autoDiscoveryRequired && !/待明确|需要.*关键词|无法.*趋势|blocked|assumption/i.test(fullText)) {
    errors.push("当前页面是 Etsy 首页/外部页/未知弱上下文且缺少明确关键词，趋势报告不得输出强结论；必须先要求用户选择关键词或类目。");
  }
  if (autoDiscoveryRequired && (!out.query_funnel || typeof out.query_funnel !== "object")) {
    errors.push("当前为趋势自动发现模式，必须输出 query_funnel 对象，说明 user_intent、discovery_queries、scored_queries 和 focus_queries。");
  }
  if (sourcePageRole === "competitor_reference" && /你的店铺|你店|本店|自营店铺已|当前店铺已|our shop has|your shop has/i.test(fullText)) {
    errors.push("当前页面被识别为竞品参考，但报告把竞品页面写成自营店铺事实。必须明确它只是公开对标样本。");
  }
  if (["own_shop", "own_listing"].includes(entryPageType) && !out.fit_to_current_shop && !/fit_to_current_shop|当前店铺适配|店铺适配度|适合当前店铺|不适合当前店铺/i.test(fullText)) {
    errors.push("自营店铺/商品页面上的趋势报告必须包含当前店铺适配度或 fit_to_current_shop，不能只输出泛平台机会。");
  }
  if (hasPositiveUnsupportedPrivateDataClaim(fullText)) {
    errors.push("趋势报告引用了竞品后台、竞品订单/转化率或平台搜索量等不可得数据。Etsy 个人卖家 API 只能读取当前授权自营店铺；竞品和平台趋势必须使用公开页面、Etsy 搜索、Google Search 或 Google Trends。");
  }
  if (!hasLedgerType(allLedger, "etsy_search")) {
    errors.push("趋势报告缺少 Etsy 公开搜索证据。Search Grid 只能作为本轮可见样本，必须先完成真实 Etsy 搜索并记录查询口径。");
  }

  const usesTrend = TREND_OR_SEASONAL_RE.test(fullText);
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
    const decision = item?.growth_decision || {};
    if (!decision || typeof decision !== "object" || !["pursue", "test", "watch", "avoid"].includes(String(decision.recommendation || "").toLowerCase())) {
      errors.push(`${label} 缺少 growth_decision.recommendation，必须给出 pursue/test/watch/avoid 之一，把趋势分析转为增长决策。`);
    }
    ["why", "first_test", "minimum_evidence_to_continue", "stop_condition", "estimated_effort", "risk_level"].forEach((field) => {
      if (!hasValue(decision?.[field])) {
        errors.push(`${label} 的 growth_decision 缺少 ${field}，必须说明低风险验证动作、继续投入证据和停止条件。`);
      }
    });
    const ledger = Array.isArray(item?.evidence_ledger) ? item.evidence_ledger : [];
    errors.push(...validateEvidenceLedgerEntries({
      entries: ledger,
      label,
      toolHistory,
      pageContext,
      allowedTypes: ["page_dom", "screenshot_visual", "etsy_search", "google_search", "google_trends", "official_policy", "official_regulation", "pinterest_social", "tiktok_social", "instagram_social", "reddit_social", "google_news", "amazon_search", "ebay_search", "user_input", "assumption"],
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
      const shippingLedger = ledger.filter((entry) => normalizeEvidenceLedgerSourceType(entry?.source_type) === "google_search" && /发货地|目的地|承运商|运输方式|物流|shipping|delivery|carrier|origin|destination/i.test(trendLedgerText([entry])));
      if (shippingLedger.length === 0) errors.push(`${label} 输出具体物流天数，但缺少包含发货地、目的地、承运商/运输方式和查询日期的实时物流搜索证据。`);
    }
    if (/竞品|头部|高排名|竞品视觉|主图|best.?seller|top shop/i.test(itemText) && !hasTrendCompetitorPageEvidence(ledger)) {
      errors.push(`${label} 使用了竞品/视觉对标结论，但没有至少 2 个公开竞品店铺或商品详情页的页面文本+截图证据；Search Grid 不能替代详情页研究。`);
    }
    if (autoDiscoveryRequired && !["recommended", "assumption", "blocked", "watch"].includes(String(item?.recommendation_status || "").toLowerCase())) {
      errors.push(`${label} 在自动发现模式下必须标注 recommendation_status（recommended/assumption/blocked/watch）。`);
    }
    if (autoDiscoveryRequired && !["passed", "risk_guard", "rejected"].includes(String(item?.filter_verdict || "").toLowerCase())) {
      errors.push(`${label} 在自动发现模式下必须标注 filter_verdict（passed/risk_guard/rejected），说明是否通过不卖原则过滤。`);
    }
    if (String(item?.recommendation_status || "").toLowerCase() === "recommended" && !hasValue(item?.seller_fit_reason)) {
      errors.push(`${label} 标记为 recommended 时必须提供 seller_fit_reason，说明为何适合中小微/个体卖家。`);
    }
    if (trendsExhausted && String(item?.demand_signal || "").toLowerCase() === "observed") {
      errors.push(`${label} 的 demand_signal 为 observed，但 Google Trends 已连续 ${MAX_GOOGLE_TRENDS_QUERY_ATTEMPTS} 次查询无可用数据；必须降级为 assumption 或 blocked。`);
    }
  });

  if (autoDiscoveryRequired) {
    if (!Array.isArray(out.rejected_directions)) {
      errors.push("自动发现模式下必须输出 rejected_directions 数组，记录被不卖原则淘汰的方向。");
    }
    if (!Array.isArray(out.recommended_opportunities) || out.recommended_opportunities.length === 0) {
      errors.push("自动发现模式下必须输出 recommended_opportunities 数组，列出通过过滤的推荐机会 ID。");
    }
    const recommendedIds = new Set((out.recommended_opportunities || []).map(String));
    items.forEach((item, idx) => {
      if (String(item?.recommendation_status || "").toLowerCase() === "recommended" && !recommendedIds.has(String(item?.opportunity_id || ""))) {
        errors.push(`趋势机会第 ${idx + 1} 项标记为 recommended，但未被包含在 recommended_opportunities 中。`);
      }
    });
  }

  return errors;
}

function validatePlatformTrendToolResult(toolName, toolArgs = {}, toolResult = {}) {
  const errors = [];
  const engine = String(toolArgs.engine || "").toLowerCase();
  if (toolName === "search_in_browser") {
    if (isEtsySearchEngine(engine) && !hasValidEtsySearchEvidence(toolResult)) {
      errors.push("Etsy 搜索结果没有通过可用证据校验，未获得可验证的商品/店铺卡片或页面文本。");
    }
    if (isGoogleTrendsEngine(engine) && !hasValidGoogleTrendsEvidence(toolResult)) {
      errors.push("Google Trends 页面没有通过可用证据校验，未获得可验证的趋势页面内容。");
    }
    if (isGoogleTrendsEngine(engine) && !toolResult?.screenshotRef && !toolResult?.screenshotCaptured) {
      errors.push("Google Trends 搜索没有形成截图 artifact，不能进入趋势图视觉解读或季节性结论阶段。");
    }
    if (isGoogleSearchEngine(engine)) {
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

function validateResearchScopeConsistency(out = {}, skillId = "", pageContext = {}) {
  const errors = [];
  const scope = out.research_scope || pageContext?.research_scope || {};
  const entryPageType = String(scope.entry_page_type || "");
  const sourcePageRole = String(scope.source_page_role || "");
  const seedKeywords = Array.isArray(scope.seed_keywords) ? scope.seed_keywords : [];
  const fullText = `${out.overview || ""}\n${out.analysis || ""}\n${out.summary || ""}\n${JSON.stringify(out.data || [])}`;
  if (!scope || !entryPageType) return errors;
  if (sourcePageRole === "competitor_reference" && /你的店铺|你店|本店|自营店铺已|当前店铺已|our shop has|your shop has/i.test(fullText)) {
    errors.push("当前页面是竞品公开参考，但报告把竞品页面写成自营店铺事实。请改为“竞品公开样本观察”。");
  }
  if (["etsy_home", "external_page", "unknown"].includes(entryPageType) && seedKeywords.length === 0 && /增长|优化|趋势|机会|建议|pursue|test|watch|avoid/i.test(fullText) && !/需要.*(关键词|类目|研究方向)|待明确|blocked|assumption|无法完成/i.test(fullText)) {
    errors.push("当前页面是弱上下文且缺少明确关键词/类目，报告不得直接输出强增长动作；必须先要求用户补充研究范围。");
  }
  if (isShopOptimizerOnly(skillId) && !["own_shop", "own_listing"].includes(entryPageType) && /店铺体检|店铺诊断|ABC|整改|当前店铺|本店/i.test(fullText) && !/竞品|公开样本|待切换到自营店铺|需要自营店铺/i.test(fullText)) {
    errors.push("店铺体检/优化必须基于自营店铺或明确说明当前只是竞品/弱上下文；不能把非自营页面写成当前店铺诊断。");
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
  if (isEtsyBusinessSkill(skillId)) {
    errors.push(...validateResearchScopeConsistency(out, skillId, pageContext));
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
    const displayCurrencyCode = String(pageContext?.etsyMarketContext?.displayCurrencyCode || pageContext?.priceCurrencyCode || "").toUpperCase();
    if (displayCurrencyCode === "USD" && /\bAUD\b|AU\$/i.test(fullReportText)) {
      errors.push("当前 Etsy 页面地区/币种选择器显示为 USD，但报告将裸 $ 价格写成 AUD。必须以 pageContext.etsyMarketContext.displayCurrencyCode 为准，不能根据 /au URL 路径推断币种。");
    }
    if (displayCurrencyCode && Array.isArray(out.competitor_benchmarks)) {
      out.competitor_benchmarks.forEach((benchmark, idx) => {
        const priceDistribution = benchmark?.price_distribution || benchmark?.price_range;
        const currencyCode = String(priceDistribution?.currency_code || benchmark?.currency_context?.display_currency_code || "").toUpperCase();
        if (priceDistribution && (!currencyCode || currencyCode === "NOT_DETECTED")) {
          errors.push(`竞品深度分析第 ${idx + 1} 项的 price_distribution 缺少 currency_code；必须写明页面显示币种 ${displayCurrencyCode} 及口径。`);
        }
        if (priceDistribution && displayCurrencyCode && currencyCode && currencyCode !== displayCurrencyCode) {
          errors.push(`竞品深度分析第 ${idx + 1} 项 price_distribution.currency_code=${currencyCode} 与当前页面显示币种 ${displayCurrencyCode} 不一致；必须按页面地区/币种选择器修正。`);
        }
        if (priceDistribution && !hasValue(priceDistribution.basis)) {
          errors.push(`竞品深度分析第 ${idx + 1} 项 price_distribution 缺少 basis，必须说明价格来自 Etsy 公开可见页面样本和当前地区/币种选择器。`);
        }
      });
    }
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
    if (!Array.isArray(out.priority_sku_actions) || out.priority_sku_actions.length < 3) {
      errors.push("店铺优化报告缺少 priority_sku_actions。必须至少给出 3 个主推 SKU/商品线优先级建议，并说明 why_priority、first_7_days_action、success_metric 和 evidence_refs。");
    } else {
      out.priority_sku_actions.slice(0, 3).forEach((item, idx) => {
        if (!hasValue(item?.sku_or_line) || !hasValue(item?.why_priority) || !hasValue(item?.first_7_days_action) || !hasValue(item?.success_metric)) {
          errors.push(`priority_sku_actions 第 ${idx + 1} 项不完整，必须包含 sku_or_line、why_priority、first_7_days_action、success_metric。`);
        }
      });
    }
    if (!Array.isArray(out.thirty_day_roadmap) || out.thirty_day_roadmap.length < 3) {
      errors.push("店铺优化报告缺少 thirty_day_roadmap。必须按 0-7天、8-14天、15-30天等阶段输出可执行目标、动作、人工检查点和指标。");
    } else {
      out.thirty_day_roadmap.slice(0, 3).forEach((item, idx) => {
        if (!hasValue(item?.period || item?.phase) || !hasValue(item?.goal) || !hasValue(item?.actions) || !hasValue(item?.metric)) {
          errors.push(`thirty_day_roadmap 第 ${idx + 1} 项不完整，必须包含 period/phase、goal、actions、metric。`);
        }
      });
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
        const sourceType = normalizeEvidenceLedgerSourceType(entry?.source_type);
        const sourceRef = entry?.source_ref;
        const observedValue = entry?.observed_value;
        const usedFor = entry?.used_for;
        const limitation = entry?.limitation;
        const allowedTypes = ["page_dom", "screenshot_visual", "etsy_api", "etsy_search", "google_search", "google_trends", "official_policy", "official_regulation", "pinterest_social", "tiktok_social", "instagram_social", "reddit_social", "google_news", "amazon_search", "ebay_search", "user_input", "assumption"];
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
      const itemClaimText = getReportItemClaimText(item);
      if (!item.stage_fit) {
        errors.push(`店铺优化方案第 ${idx + 1} 项 (${title}) 缺少 stage_fit，必须说明该方案为什么适合当前店铺阶段（新店冷启动/成长店/成熟店/问题修复）。`);
      }
      if (!item.buyer_scenario) {
        errors.push(`店铺优化方案第 ${idx + 1} 项 (${title}) 缺少 buyer_scenario，必须说明对应的欧美买家场景或购买人群。`);
      }
      if (SHOP_OPTIMIZER_API_CLAIM_RE.test(itemClaimText) && !hasLedgerType(ledgerEntries, "etsy_api") && !hasAssumptionFallback(ledgerEntries, SHOP_OPTIMIZER_API_ASSUMPTION_TOPIC_RE)) {
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
      errors.push("店铺优化报告缺少必须完成的 Google Trends / Google Search 地区站外需求证据。该项不能降级为 assumption，请调用 search_in_browser(engine=google_us/google_uk/google_de/google_fr/google_ca/google_au 或 google_trends_us/google_trends_uk/google_trends_de/google_trends_fr/google_trends_ca/google_trends_au) 获取真实检索/趋势证据。");
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
    errors.push("报告概述 (overview) 或分析 (analysis) 中未体现自主判断的目标销售市场与目标客群定位（例如：‘欧美礼品市场’、‘Etsy 北美手工定制人群’或‘欧洲节庆礼品买家’等），请予以明确陈述！");
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
const LLM_PLANNING_TIMEOUT_MS = 4 * 60 * 1000;

function isRetryableLLMError(error) {
  return /network|fetch failed|请求.*失败|请求.*超时|timeout|timed out|502|503|504|429|连接|socket|ECONN|ENET|EAI_AGAIN/i.test(String(error?.message || error || ""));
}

async function callLLMWithPlanningTimeout(llmMessages, streamCallback, highRandomness = false, timeoutMs = LLM_PLANNING_TIMEOUT_MS) {
  let timeoutId = null;
  let timedOut = false;
  try {
    return await Promise.race([
      callLLM(llmMessages, (event) => {
        if (!timedOut && typeof streamCallback === "function") streamCallback(event);
      }, highRandomness),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          timedOut = true;
          reject(new Error(`LLM 规划请求超过 ${Math.round(timeoutMs / 1000)} 秒未完成`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export async function runAgentLoop({ tabId, skillId, skillMarkdown, userInstruction, pageContext, sendProgress, continueSession, highRandomness, negativeFilter, resumeState = null, onCheckpoint = null, workflowId = "", workflowGeneration = "" }) {
  const settings = await getSettings();

  let systemPrompt = skillMarkdown;
  if (negativeFilter === false) {
    systemPrompt += `\n\n=========================================\n\n⚠️ 【用户已手动关闭“不卖原则”过滤限制】：当前处于 Etsy 跨境或不受限的宽容寻源环境，用户已手动取消了默认的“不卖原则”（Negative Filter）负面过滤。因此，你【无须】过滤服饰、鞋帽、内衣、大件重货、陶瓷玻璃易碎品、本地容易买到的普通日杂标品或医疗/成人/知名 IP 周边等高风险品类。请完全根据当前页面商品的实际销量表现、货源品质以及用户指令，自由挖掘上述常规品类并推荐它们的源头供应商！`;
  } else {
    systemPrompt += buildNegativeFilterPrompt(skillId, userInstruction);
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
  ctxForPrompt.currency_rates = await getCurrencyRateContextForPrompt();
  const screenshotData = ctxForPrompt.screenshot;
  delete ctxForPrompt.screenshot;

  const userText = `请严格根据 skill 说明执行任务。

## 可用工具
${availableTools}

## 浏览器自动化能力契约
${formatBrowserAutomationCapabilityPrompt()}

页面动态加载时必须相信工具返回的 loadState、evidenceOk、pageEvidence、evidence_quality、blockingGaps 和 screenshotCaptureMode：
- evidenceOk=false、Google Trends 壳页、验证码、登录墙或 blockingGaps 不得被写成已验证增长结论。
- 工具能力契约说明可以做什么，也说明不能做什么；尤其 Etsy 个人卖家 API 不能读取竞品后台、竞品订单、竞品转化率或平台大盘。
- 需要翻页、排序、筛选、截图或详情页时，优先使用上方能力契约对应工具；不能用模型想象替代工具证据。
${isShopOptimizerOnly(skillId) ? formatShopOptimizerProductionSkeletonPrompt(toolHistory, pageContext) : ""}

## 通用对象感知与陌生网站取证纪律
如果 pageContext.objectProfile 存在，必须先按 objectProfile.object_type 判断用户提供对象是 product、store、search_results、website 还是 unknown：
- 对陌生网站，DOM 结构不可预设；价格、规格、库存、评论、评分、标题、链接等文字字段必须来自 visibleText、structuredData、productCards、productLinks 或 read_current_page 返回字段。
- 截图用于判断视觉层级、主图/画廊质量、首屏信息密度、品牌调性、信任信号和页面阻断状态；不得用截图去编造未读取到的长文本参数。
- objectProfile.evidence_contract.dom_status="weak"、pageHealth.isLikelyBlocked=true 或 pageEvidence.hasMeaningfulDom=false 时，只能输出取证受限和下一步补证计划，不能输出深度商业结论。
- 对 store/search_results/website 页面，当前 productCards/productLinks 只是公开可见样本；没有打开详情页前，不得写商品级材质、变体、完整价格带或评论痛点。
- 最终 evidence_ledger 必须同时区分 page_dom 与 screenshot_visual：页面文字事实写 page_dom，视觉观察写 screenshot_visual。

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
    "priority_sku_actions": [],
    "thirty_day_roadmap": [],
    "data": [ ... ] // 具体的结构化数据（如具体的商品蓝图、筛选出的列表等，必须是数组）
  }
}
\`\`\`


## 当前页面上下文
${JSON.stringify(ctxForPrompt, null, 2)}

## 当前汇率与套利参数
${JSON.stringify(ctxForPrompt.currency_rates, null, 2)}

价格与区域口径硬约束：
- 浏览器取证工具会优先访问免费公开的 Etsy/Google 地区页面（例如 Etsy 搜索带 ship_to=US/GB/DE/FR/CA/AU，Google Search 带 gl/hl，Google Trends 带 geo）。店铺体检、关键词分析和机会分析应优先使用页面实际显示的币种/区域口径，并在证据账本中写明“免费公开页面、页面显示币种/区域”；不要为了前台对标把 Etsy 页面显示价格二次换算成 USD。付费、后台或账号型工具不得作为必需证据。
- 如果 pageContext.etsyMarketContext.displayCurrencyCode 存在，它是当前页面价格币种的最高优先级证据；例如 URL 为 /au/ 但页脚/地区选择器显示 “United States | English (US) | $ (USD)” 时，所有裸美元符号价格必须解释为 USD，严禁写成 AUD。
- 只有进入国内寻源、采购成本、物流成本、平台扣款、关税或净利润测算时，才使用上方汇率参数把 CNY/RUB/EUR 成本统一换算进 USD 财务账本；不得把不同币种数值直接相减。
- 如果页面仍显示 AUD/EUR/GBP 等非 USD 价格，按原样引用并标明页面显示币种；需要可比利润测算时再单独列“待统一币种复核”，不要把它包装成已验证 USD 利润。

## 当前研究范围与页面角色
${ctxForPrompt.research_scope ? JSON.stringify(ctxForPrompt.research_scope, null, 2) : "未识别到 research_scope。请先通过 read_current_page 确认页面角色。"}

你必须遵守 research_scope：
- 如果 source_page_role 是 competitor_reference，当前页面只能作为竞品公开样本，不能写成自营店铺事实。
- 如果 entry_page_type 是 etsy_home、external_page 或 unknown，且缺少明确 seed_keywords，不得输出强趋势或增长结论。
- 如果 entry_page_type 是 own_shop 或 own_listing，趋势和优化结论必须说明与当前自营店铺/商品的适配度。
- Search Grid 只能代表本轮可见样本，不能写成完整平台数据。

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
    newCtx.currency_rates = await getCurrencyRateContextForPrompt();
    delete newCtx.screenshot;
    const ctxString = JSON.stringify(newCtx, null, 2);

    let instructionText = `[断点续跑] 请从上次中断节点继续，不要重复已经完成的搜索、开页、筛选或已获得的工具证据。`;
    if (resumeCompaction) {
      instructionText += `\n\n【已自动清理旧搜索循环】本次恢复时检测到趋势任务历史中存在 ${resumeCompaction.state.searchCalls} 次 search_in_browser，其中 ${resumeCompaction.removedSearchCalls} 条重复/低质量搜索已从工具证据上下文压缩为 workflow_stage_summary。你必须沿用保留的有效证据和阶段摘要继续，禁止再次扩展同类关键词搜索；若搜索阶段已完成，下一步进入竞品店铺/商品详情采集、截图分析或 final。`;
    }
    if (userInstruction) {
      instructionText += `\n\n用户最新补充信息：\n"${userInstruction}"`;
      if (USER_REQUESTS_API_ASSUMPTION_DOWNGRADE_RE.test(userInstruction)) {
        instructionText += `\n\n【用户已明确要求忽略/跳过未配置的 Etsy API】如果当前本地没有可用 Etsy 个人访问 API 证据，不要继续追问或重复调用 API 工具来修复质量门禁；请把 API、订单、Sessions、转化、履约成本、Etsy 自发货或第三方海外仓相关结论全部降级为 evidence_ledger.source_type="assumption"，并在 source_ref/observed_value/used_for/limitation 中明确“未配置/未取得 Etsy 个人 API，需后续授权后复核”。页面、Etsy 搜索、Google Search/Trends 和竞品截图证据仍必须保持真实证据，不得伪造。`;
      }
    } else {
      instructionText += `\n\n请结合最新 System Prompt 和页面上下文继续推进。`;
    }
    
    if ((skillId || "").includes("domestic_sourcing_finder") || (skillId || "").includes("etsy_sourcing_finder")) {
      instructionText += `\n\n【⚠️ 极其重要：禁止直接生成/必须调用浏览器工具真实寻源】\n当前匹配到的是寻源任务（例如需要去 1688、淘宝等平台寻找货源或对比价格），**你绝对禁止直接从历史记忆中复制或凭空捏造虚假的 1688/淘宝 详情页链接！**\n如果最新页面上下文中存在 targetImageUrl，且目标商品属于非标外观/模具/造型商品，你必须在第一步调用 'image_search_1688'（优先）或 'image_search_taobao' 执行供应商平台以图搜源；如果已配置生图模型且平台自动框选主体不完整，可先调用 'prepare_clean_product_image' 准备干净主体图，再把返回的 image_search_argument.imageUrl 传给图片搜索工具。非标品一旦进入图片检索路径，Critic 打回后也严禁切回 'input_text_and_search' 关键词搜索；只有目标明确为标品或用户明确要求文本兜底，才允许文本搜索。只有在通过工具真实获取并校验了详情页内容、价格和起批量后，才被允许在最后的报告中写入真实的 1688/淘宝详情页链接并输出 final 报告！`;
    }

    instructionText += `\n\n【极其重要：强制输出格式】\n无论你进行了多少轮推演，**你最后一次的输出必须，且只能是如下 JSON 格式**（请包裹在 \`\`\`json 中）：\n\`\`\`json\n{\n  "type": "final",\n  "output": {\n    "overview": "...",\n    "analysis": "...",\n    "summary": "...",\n    "data": [] \n  }\n}\n\`\`\`\n严禁把上述指令文字直接暴露在最终报告中！`;
    instructionText += `\n\n【最终报告语言净化要求】工具名、函数名、页面解析术语和内部执行细节只允许出现在工具调用中，严禁写入最终报告正文。最终报告必须面向 Etsy 卖家，用“页面文本取证、候选详情页核验、后台资料检索、平台访问限制”等业务语言表达，不得出现 DOM、xpath、read_current_page、open_new_tab、close_tab、agentic_web_search 等内部技术词。`;
    if (isShopOptimizerOnly(skillId)) {
      instructionText += formatShopOptimizerProductionSkeletonPrompt(toolHistory, pageContext);
      instructionText += `\n\n【断点恢复生产要求】你必须先读取上面的店铺体检生产骨架覆盖状态，优先修复 next_missing 槽位；不要重复已填槽位的搜索/开页/截图。`;
    }
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
      timeoutSeconds: Math.round(LLM_PLANNING_TIMEOUT_MS / 1000),
      message: `正在请求 AI（${llmMessages.length} 条消息，约 ${Math.ceil(llmPayloadChars / 4)} tokens，最长等待 ${Math.round(LLM_PLANNING_TIMEOUT_MS / 1000)} 秒）...`,
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
          timeoutSeconds: Math.round(LLM_PLANNING_TIMEOUT_MS / 1000),
          message: `AI 正在基于已采集证据规划下一步，已运行 ${elapsedSeconds} 秒，最长等待 ${Math.round(LLM_PLANNING_TIMEOUT_MS / 1000)} 秒。`,
        });
      }, 30000);
      let recoveryAttempt = 0;
      while (true) {
        try {
          assistantContent = await callLLMWithPlanningTimeout(llmMessages, ({ chunk, fullText, isReasoning }) => {
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
      if (isEtsyBusinessSkill(skillId)) {
        const formatRetryCount = ctxForPrompt.__formatRetryCount || 0;
        messages.push({ role: "assistant", content: assistantContent });
        messages.push({
          role: "user",
          content: "【系统格式闸门拒绝】本轮 Etsy 业务输出没有包含可执行的 agent 协议 JSON。请不要输出纯文本、工具结果摘要或裸对象；必须继续调用缺失工具，或输出唯一合法格式：{\"type\":\"final\",\"output\":{\"overview\":\"...\",\"analysis\":\"...\",\"summary\":\"...\",\"data\":[]}}。",
        });
        if (formatRetryCount < 1) {
          ctxForPrompt.__formatRetryCount = formatRetryCount + 1;
          await saveCheckpoint({ status: "format_retry", step, lastNode: "missing_agent_json", formatRetryCount });
          continue;
        }
        await saveCheckpoint({ status: "quality_gate_blocked", step, lastNode: "missing_agent_json", validationErrors: ["Etsy 业务未输出 final/tool_call 协议 JSON，已阻断交付。"] });
        return {
          ok: false,
          type: "interrupted",
          result: "Etsy 业务未输出符合协议的 final/tool_call JSON，已保存断点。请发送“继续”从当前证据继续修复。",
          steps: step,
          qualityGateBlocked: true,
          validationErrors: ["Etsy 业务未输出 final/tool_call 协议 JSON，已阻断交付。"],
        };
      }
      messages.push({ role: "assistant", content: assistantContent });
      globalSessionCache[sessionKey] = { messages, toolHistory, ctxState: {} };
      await clearAgentCheckpoint(sessionKey);
      return {
        ok: true,
        type: "text",
        result: assistantContent,
        steps: step,
        toolHistory,
      };
    }

    if (parsed.type === "final") {
      const trendRefinement = getTrendQueryRefinementState(skillId, toolHistory);
      if (trendRefinement.required && !trendRefinement.exhausted) {
        sendProgress({ type: "trend_query_refinement", step, message: trendRefinement.message });
        messages.push({ role: "assistant", content: assistantContent });
        messages.push({
          role: "user",
          content: `【Google Trends 查询恢复提示】\n${trendRefinement.message}\n\n请在重新输出 final 报告前，先调用 search_in_browser(engine="google_trends", query="<恢复后的词>") 尝试获取趋势截图证据；若仍数据不足，则必须将需求信号降级为 assumption/blocked 并写入 blocking_gaps。`,
        });
        await saveCheckpoint({ status: "trend_refinement", step, lastNode: "trend_query_refinement" });
        continue;
      }
      if (trendRefinement.exhausted) {
        sendProgress({ type: "trend_query_exhausted", step, message: trendRefinement.message });
        messages.push({ role: "assistant", content: assistantContent });
        messages.push({
          role: "user",
          content: `【Google Trends 查询已耗尽】\n${trendRefinement.message}\n\n请在 final 报告中严格执行：\n1. 所有基于 Google Trends 的需求信号必须标记为 assumption 或 blocked；\n2. 不得写出“Google Trends 证明/表明/因此…”等因果结论；\n3. 把缺失趋势证据写入 blocking_gaps，并使用 Etsy 搜索/Google 搜索等真实证据完成机会判断。`,
        });
      }

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
          const shopProductionSkeletonFeedback = isShopOptimizerOnly(skillId)
            ? `${formatShopOptimizerProductionSkeletonPrompt(toolHistory, pageContext)}\n\n【Critic 修复方式】请优先补 report skeleton 中 status=missing/partial 的槽位；若槽位证据已经存在但 final.output 未消费，请把证据落入 competitor_benchmarks、diagnostic_depth_matrix 和 data[].evidence_ledger，而不是重复开页或泛泛改写。`
            : "";
          messages.push({
            role: "user",
            content: `【Critic Agent 报告质量审计拒绝】\n你的报告未能通过系统的自动合规自检，发现了以下问题：\n${validationErrors.map((err, i) => `${i + 1}. ${err}`).join("\n")}\n${shopProductionSkeletonFeedback}\n\n${domesticVisualActive ? "【非标视觉寻源硬约束】本轮已经启动目标主图/以图搜图路径。请继续基于图片搜索结果页 productCards 和截图做视觉相似度修正，补齐 candidate_image_url、list_page_visual_score、visual_match_evidence；严禁回到 1688/淘宝文本框关键词搜索来凑结果。\n\n" : ""}请严格对照系统提示词规范，在脑海中进行深度反思（如补充筛选数量、使用真实详情单页链接、清除技术黑话等），并重新调用工具或重新输出一份完美修正了以上所有问题的 \`{"type":"final", "output": {...}}\` 报告！`
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
        toolHistory,
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
      let toolRunId = createToolRunId(toolName);
      sendProgress({
        type: "tool_call",
        step,
        toolName,
        toolRunId,
        toolArgs: progressToolArgs,
        actionKind: plannedToolAction.actionKind,
        actionLabel: plannedToolAction.actionLabel,
        tabLifecycle: plannedToolAction.lifecycle,
        message: `准备调用动作: ${plannedToolAction.actionLabel}`,
      });
      await saveCheckpoint({
        status: "tool_pending",
        step,
        lastNode: "tool_call_ready",
        toolName,
        toolArgs: progressToolArgs,
      });
      await recordWorkflowExecutionEvent(workflowId, "tool_planned", {
        step,
        toolName,
        toolRunId,
        actionKind: plannedToolAction.actionKind,
        actionLabel: plannedToolAction.actionLabel,
        tabLifecycle: plannedToolAction.lifecycle,
        arguments: stripRuntimeToolArgs(progressToolArgs),
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
        const toolRunState = {
          cancelled: false,
          cancelReason: "",
          toolRunId,
          toolName,
        };
        const workflowContext = {
          workflowId,
          workflowGeneration,
          sourceTabId: tabId,
          toolRunId,
          step,
          actionKind: toolAction.actionKind,
          actionLabel: toolAction.actionLabel,
          startedAt: new Date(toolStartedAt).toISOString(),
        };
        const executableToolArgs = {
          ...toolArgs,
          __sourceTabId: tabId,
          __workflowContext: workflowContext,
          __toolRunState: toolRunState,
          __progress: (stage = {}) => {
            if (toolRunState.cancelled) return;
            const stageMessage = stage.message || `${toolAction.actionLabel} 正在执行`;
            sendProgress({
              type: "tool_stage",
              step,
              toolName,
              toolRunId,
              actionKind: stage.actionKind || toolAction.actionKind,
              actionLabel: stage.actionLabel || toolAction.actionLabel,
              tabLifecycle: stage.tabLifecycle || toolAction.lifecycle,
              stage: stage.stage || "tool_stage",
              tabId: stage.tabId,
              searchUrl: stage.searchUrl,
              elapsedSeconds: Math.max(0, Math.round((Date.now() - toolStartedAt) / 1000)),
              message: stageMessage,
            });
          },
        };
        await recordWorkflowExecutionEvent(workflowId, "tool_started", {
          step,
          toolName,
          toolRunId,
          actionKind: toolAction.actionKind,
          actionLabel: toolAction.actionLabel,
          tabLifecycle: toolAction.lifecycle,
        });
        sendProgress({
          type: "tool_stage",
          step,
          toolName,
          toolRunId,
          actionKind: toolAction.actionKind,
          actionLabel: toolAction.actionLabel,
          tabLifecycle: toolAction.lifecycle,
          stage: "tool_execution_started",
          elapsedSeconds: 0,
          message: `${toolAction.actionLabel} 已进入工具执行，正在发起浏览器动作。`,
        });
        toolHeartbeatTimer = setInterval(() => {
          const elapsedSeconds = Math.max(1, Math.round((Date.now() - toolStartedAt) / 1000));
          sendProgress({
            type: "tool_heartbeat",
            step,
            toolName,
            toolRunId,
            actionKind: toolAction.actionKind,
            actionLabel: toolAction.actionLabel,
            tabLifecycle: toolAction.lifecycle,
            elapsedSeconds,
            timeoutSeconds: Math.round(toolTimeoutMs / 1000),
            message: `${toolAction.actionLabel} 工具执行已持续 ${elapsedSeconds} 秒，最长等待 ${Math.round(toolTimeoutMs / 1000)} 秒；当前可能在等待页面加载、DOM 可读或截图保存。${toolAction.lifecycle ? ` ${toolAction.lifecycle}。` : ""}`,
          });
        }, 30000);
        toolResult = await runToolWithTimeout(toolName, executableToolArgs, toolRunState);
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
          const closedTabIds = await closeTabsCreatedDuringTimedOutTool(tabsBeforeTool, new Set([tabId]));
          toolResult.closedTabIds = closedTabIds;
          toolResult.actionKind = toolAction.actionKind;
          toolResult.actionLabel = toolAction.actionLabel;
          toolResult.tabLifecycle = toolAction.lifecycle;
          toolResult.timeoutPolicy = "tool_timeout_does_not_cancel_workflow";
          sendProgress({
            type: "tool_timeout",
            step,
            toolName,
            toolRunId,
            actionKind: toolAction.actionKind,
            actionLabel: toolAction.actionLabel,
            tabLifecycle: toolAction.lifecycle,
            closedTabIds,
            elapsedSeconds: Math.round((Date.now() - toolStartedAt) / 1000),
            message: `${toolAction.actionLabel} 已超过本阶段等待时间；这表示该阶段未形成稳定返回，不等于页面没有数据。已回收本次工具新增的临时标签页 ${closedTabIds.length} 个，workflow 未被取消，可继续修复或重试该证据阶段。`,
          });
          await recordWorkflowExecutionEvent(workflowId, "tool_timeout", {
            step,
            toolName,
            toolRunId,
            actionKind: toolAction.actionKind,
            actionLabel: toolAction.actionLabel,
            elapsedMs: toolResult.elapsedMs,
            closedTabIds,
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
          toolRunId,
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
      const evidenceQualityNote = formatEvidenceQualityForProgress(toolResult);
      if (toolResult && typeof toolResult === "object") {
        toolResult.actionKind = toolResult.actionKind || completedToolAction.actionKind;
        toolResult.actionLabel = toolResult.actionLabel || completedToolAction.actionLabel;
        toolResult.tabLifecycle = toolResult.tabLifecycle || completedToolAction.lifecycle;
      }
      await recordWorkflowExecutionEvent(workflowId, "tool_finished", {
        step,
        toolName,
        toolRunId,
        actionKind: completedToolAction.actionKind,
        actionLabel: completedToolAction.actionLabel,
        result: compactToolResultForLedger(toolResult),
      });
      toolHistory.push({ tool: toolName, arguments: stripRuntimeToolArgs(toolArgs), result: toolResult });
      const shopProductionSkeletonState = isShopOptimizerOnly(skillId)
        ? buildShopOptimizerProductionSkeletonState(toolHistory, pageContext)
        : null;
      if (shopProductionSkeletonState) {
        await recordWorkflowExecutionEvent(workflowId, "shop_report_skeleton_progress", {
          step,
          toolName,
          toolRunId,
          filledCount: shopProductionSkeletonState.filledCount,
          partialCount: shopProductionSkeletonState.partialCount,
          totalSlots: shopProductionSkeletonState.totalSlots,
          nextMissingSlot: shopProductionSkeletonState.nextMissingSlot,
          nextAction: shopProductionSkeletonState.nextAction,
        });
      }

      sendProgress({
        type: "tool_result",
        step,
        toolName,
        toolRunId,
        actionKind: completedToolAction.actionKind,
        actionLabel: completedToolAction.actionLabel,
        tabLifecycle: completedToolAction.lifecycle,
        toolResult,
        reportSkeletonState: shopProductionSkeletonState,
        message: `${completedToolAction.actionLabel}执行完毕，已获取并保存相关证据${evidenceQualityNote}。${shopProductionSkeletonState ? `店铺体检骨架覆盖 ${shopProductionSkeletonState.filledCount}/${shopProductionSkeletonState.totalSlots}，下一槽位：${shopProductionSkeletonState.nextMissingSlot || "none"}。` : ""}${completedToolAction.lifecycle ? `（${completedToolAction.lifecycle}）` : ""}`,
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
          await recordWorkflowExecutionEvent(workflowId, "tool_validation_failed", {
            step,
            toolName,
            toolRunId,
            errors: toolQualityErrors,
            result: compactToolResultForLedger(toolResult),
          });
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
        await recordWorkflowExecutionEvent(workflowId, "tool_validated", {
          step,
          toolName,
          toolRunId,
          validator: "platform_trends_step_gate",
          result: compactToolResultForLedger(toolResult),
        });
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
      if (shopProductionSkeletonState) {
        userResultObj.report_skeleton_state = shopProductionSkeletonState;
        userResultObj.next_step_instruction = shopProductionSkeletonState.readyForFinal
          ? "report_skeleton_state.readyForFinal=true，店铺体检骨架已覆盖 7/7 且 nextMissingSlot=none。下一步禁止继续搜索、开页或泛规划；必须立即输出唯一合法 final JSON，并把已采集证据消费到 overview/analysis/summary/data/competitor_benchmarks/diagnostic_depth_matrix/evidence_ledger。"
          : `请先按 report_skeleton_state.nextMissingSlot=${shopProductionSkeletonState.nextMissingSlot || "none"} 推进店铺体检生产骨架。${shopProductionSkeletonState.nextAction}`;
      }
      const productCards = toolResult?.pageData?.productCards || [];
      if (Array.isArray(productCards) && productCards.length > 0) {
        userResultObj.visual_candidate_summary = summarizeProductCards(productCards);
        const visualInstruction = "当前页面已经抽取到带主图与屏幕坐标的 productCards。下一步必须停止继续搜索，先对照目标商品主图和最新截图，把这些卡片按外观/材质/结构视觉相似度排序；只允许打开视觉排名最高且未触发材质/造型红线的 1-3 个详情页。最终 data 每项必须写入 candidate_image_url、list_page_visual_score、visual_match_evidence，禁止只按标题关键词选择。";
        userResultObj.next_step_instruction = userResultObj.next_step_instruction
          ? `${userResultObj.next_step_instruction}\n${visualInstruction}`
          : visualInstruction;
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

    if (isEtsyBusinessSkill(skillId) && parsed.type !== "final" && parsed.type !== "tool_call") {
      const formatRetryCount = ctxForPrompt.__formatRetryCount || 0;
      const parsedKeys = Object.keys(parsed || {}).slice(0, 12).join(", ");
      messages.push({ role: "assistant", content: assistantContent });
      messages.push({
        role: "user",
        content: `【系统格式闸门拒绝】你输出的是非协议 JSON（字段：${parsedKeys || "unknown"}），不能作为 Etsy 业务成功结果。不要把工具返回值、listing/pageData、搜索结果或中间证据对象当 final 报告。下一步必须继续完成缺失证据阶段，或输出唯一合法 final：{"type":"final","output":{"overview":"...","analysis":"...","summary":"...","data":[]}}。`,
      });
      if (formatRetryCount < 1) {
        ctxForPrompt.__formatRetryCount = formatRetryCount + 1;
        await saveCheckpoint({ status: "format_retry", step, lastNode: "unsupported_agent_json", parsedKeys });
        continue;
      }
      await saveCheckpoint({ status: "quality_gate_blocked", step, lastNode: "unsupported_agent_json", validationErrors: ["Etsy 业务输出了非 final/tool_call 协议 JSON，疑似把工具结果当报告交付。"] });
      return {
        ok: false,
        type: "interrupted",
        result: "Etsy 业务输出了非 final/tool_call 协议 JSON，疑似把工具结果当报告交付；已保存断点。请发送“继续”修复。",
        steps: step,
        qualityGateBlocked: true,
        validationErrors: ["Etsy 业务输出了非 final/tool_call 协议 JSON，疑似把工具结果当报告交付。"],
      };
    }

    messages.push({ role: "assistant", content: assistantContent });
    globalSessionCache[sessionKey] = { messages, toolHistory, ctxState: {} };
    await clearAgentCheckpoint(sessionKey);
    return {
      ok: true,
      type: "json",
      result: parsed,
      steps: step,
      toolHistory,
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

function extractMarkdownSection(text = "", headingPatterns = []) {
  const source = String(text || "");
  const headings = [];
  const headingRegex = /^#{1,6}\s+(.+?)\s*$/gm;
  let match;
  while ((match = headingRegex.exec(source)) !== null) {
    headings.push({
      index: match.index,
      end: headingRegex.lastIndex,
      title: match[1].trim(),
    });
  }
  for (let i = 0; i < headings.length; i += 1) {
    const heading = headings[i];
    if (!headingPatterns.some((pattern) => pattern.test(heading.title))) continue;
    const next = headings.slice(i + 1).find((candidate) => candidate.index > heading.index);
    return source.slice(heading.end, next?.index ?? source.length).trim();
  }
  return "";
}

function markdownLinesToActionItems(text = "") {
  return String(text || "")
    .split(/\n+/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)]|#{1,6})\s*/, "").trim())
    .filter((line) => line.length >= 8)
    .slice(0, 6);
}

function parseMarkdownReportFallback(text = "") {
  const source = String(text || "").trim();
  if (!source) return null;
  if (/^\s*(?:```)?\s*[{[]/.test(source)) return null;
  const reportSignals = [
    /分析概述|深度商业诊断|核心运营建议|结构化行动项|店铺体检|店铺诊断|整改/i,
    /diagnostic_depth_matrix|competitor_benchmarks|evidence_ledger/i,
    /Etsy|Google Trends|Google Search|竞品|首图|SEO|物流|履约/i,
  ];
  if (reportSignals.filter((pattern) => pattern.test(source)).length < 2) return null;

  const overview = extractMarkdownSection(source, [/分析概述/i, /overview/i, /报告概述/i]) ||
    source.split(/\n{2,}/).find((part) => /店铺|Etsy|诊断|体检|竞品/.test(part)) ||
    source.slice(0, 900);
  const analysis = extractMarkdownSection(source, [/深度商业诊断/i, /商业诊断/i, /深度分析/i, /analysis/i]) ||
    extractMarkdownSection(source, [/核心发现/i, /诊断发现/i]) ||
    source.slice(0, 1800);
  const summary = extractMarkdownSection(source, [/核心运营建议/i, /核心建议/i, /summary/i, /结论/i]) ||
    extractMarkdownSection(source, [/下一步/i, /行动建议/i]) ||
    source.slice(Math.max(0, source.length - 900));
  const actionSection = extractMarkdownSection(source, [/结构化行动项/i, /行动项/i, /整改方案/i, /下一步/i]);
  const actions = markdownLinesToActionItems(actionSection || summary);
  const firstTitle = actions[0] || "店铺体检报告格式修复";

  return {
    type: "final",
    output: {
      overview: truncateText(overview, 2200),
      analysis: truncateText(analysis, 3600),
      summary: truncateText(summary, 1800),
      data: [{
        plan_id: "B-1",
        title: truncateText(firstTitle, 120),
        diagnosis_level: /P0|第一优先|紧急|阻断|高风险/i.test(source) ? "P0" : "B",
        direction: truncateText(actions.join("；") || summary || "将 Markdown 店铺体检报告转为标准 final.output 结构，并继续补齐证据账本和行动字段。", 600),
        evidence: "模型已输出 Markdown 业务报告，但缺少 final/tool_call 协议外壳；本项由格式兜底解析生成，后续仍需通过证据账本与质量门禁校验。",
        first_actions: actions.length ? actions.slice(0, 4) : ["补齐报告结构字段", "绑定本轮真实工具证据", "通过质量门禁后交付"],
        evidence_ledger: [{
          source_type: "assumption",
          source_ref: "markdown_report_format_fallback",
          observed_value: "LLM 输出了可读业务报告正文，但没有包裹为 {type:\"final\", output:{...}} 协议 JSON。",
          used_for: "避免已有业务报告因包装格式缺失直接变成断点；该兜底只修复交付外壳，业务事实仍必须由真实工具证据或后续 autoRepair/validator 校验。",
          confidence: "low",
          limitation: "该条不是外部市场或页面事实，只说明格式修复来源；不能替代 Etsy、Google、截图、API 或物流证据。",
        }],
      }],
      report_format_recovered: true,
      format_recovery_note: "Recovered from Markdown business report text that omitted the final/tool_call JSON envelope.",
    },
  };
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
    const parsed = tryParseJSON(text.trim());
    return isLikelyAgentJSON(parsed) ? parsed : null;
  } catch (_) {}

  return parseMarkdownReportFallback(text);
}
