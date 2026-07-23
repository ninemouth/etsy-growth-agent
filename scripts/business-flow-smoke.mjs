import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import {
  __testInternals,
  autoRepairFinalReportForDelivery,
  extractJSONBlock,
  normalizeFinalReportShapeForDelivery,
  sanitizeFinalReportForDelivery,
  validateReport,
} from "../modules/agentLoop.js";
import { hasValidEtsySearchEvidence, hasValidGoogleTrendsEvidence } from "../modules/toolRegistry.js";
import { buildResearchScope, shouldClarifyResearchScope } from "../modules/researchScope.js";
import { calculateQuickArbitrage, normalizeCurrencyRates } from "../modules/currencyRates.js";

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const root = process.cwd();
const html = fs.readFileSync(path.join(root, "dashboard.html"), "utf8");
const js = fs.readFileSync(path.join(root, "dashboard.js"), "utf8");
const sidepanelSource = fs.readFileSync(path.join(root, "sidepanel.js"), "utf8");
const sidepanelHtmlSource = fs.readFileSync(path.join(root, "sidepanel.html"), "utf8");
const css = fs.readFileSync(path.join(root, "dashboard.css"), "utf8");
const backgroundSource = fs.readFileSync(path.join(root, "background.js"), "utf8");
const contentSource = fs.readFileSync(path.join(root, "content.js"), "utf8");
const agentLoopSource = fs.readFileSync(path.join(root, "modules", "agentLoop.js"), "utf8");
const toolRegistrySource = fs.readFileSync(path.join(root, "modules", "toolRegistry.js"), "utf8");
const browserSessionManagerSource = fs.readFileSync(path.join(root, "modules", "browserSessionManager.js"), "utf8");
const artifactStoreSource = fs.readFileSync(path.join(root, "modules", "artifactStore.js"), "utf8");
const workflowSchedulerSource = fs.readFileSync(path.join(root, "modules", "workflowScheduler.js"), "utf8");
const shopOptimizerSkillSource = fs.readFileSync(path.join(root, "skills", "etsy_global_shop_optimizer.skill.md"), "utf8");
const baseAuditorSkillSource = fs.readFileSync(path.join(root, "skills", "base_report_auditor.skill.md"), "utf8");
const productOpportunitySkillSource = fs.readFileSync(path.join(root, "skills", "etsy_product_opportunity_explorer.skill.md"), "utf8");
const sourcingSkillSource = fs.readFileSync(path.join(root, "skills", "etsy_sourcing_finder.skill.md"), "utf8");
const operationsSkillSource = fs.readFileSync(path.join(root, "skills", "etsy_operations_tracker.skill.md"), "utf8");
const remainingBusinessSkillSource = [
  productOpportunitySkillSource,
  sourcingSkillSource,
  operationsSkillSource,
  fs.readFileSync(path.join(root, "skills", "etsy_keyword_analysis.skill.md"), "utf8"),
  fs.readFileSync(path.join(root, "skills", "etsy_listing_generator.skill.md"), "utf8"),
  fs.readFileSync(path.join(root, "skills", "etsy_review_analyzer.skill.md"), "utf8"),
  fs.readFileSync(path.join(root, "skills", "etsy_compliance_auditor.skill.md"), "utf8"),
].join("\n");
const runtimeBundleSource = [html, js, sidepanelHtmlSource, sidepanelSource, css].join("\n");

[
  /getShopMockData/,
  /drawMockTrackerCharts/,
  /renderMockStoreData/,
  /mock-api-data-btn/,
  /示例 SKU 队列/,
  /模拟指标/,
  /source-dot\.mock/,
].forEach((pattern) => {
  assert.doesNotMatch(runtimeBundleSource, pattern, `runtime plugin UI must not keep mock data hook: ${pattern}`);
});

assert.doesNotMatch(
  toolRegistrySource,
  /monthly_search_volume:\s*Math\.floor|monthly_sales_estimate:\s*Math\.floor|competition_index:\s*Math\.floor|magnet_score:\s*Math\.floor/,
  "runtime market-data tools must not generate random business metrics"
);
assert.match(
  toolRegistrySource,
  /integrationStatus:\s*"not_implemented"[\s\S]*不会生成随机市场指标/,
  "unimplemented third-party market-data integrations must return an explicit unavailable status"
);

assert.match(agentLoopSource, /type:\s*"tool_heartbeat"/, "long-running tool calls should emit heartbeat progress");
assert.match(agentLoopSource, /type:\s*"tool_stage"/, "browser tools should emit concrete stage progress after the tool has actually started");
assert.match(agentLoopSource, /createToolRunId[\s\S]*toolRunId[\s\S]*type:\s*"tool_heartbeat"[\s\S]*type:\s*"tool_result"/, "tool progress events should carry a per-tool-run id so stale heartbeats cannot appear after a completed action");
assert.match(agentLoopSource, /type:\s*"llm_heartbeat"/, "long-running LLM planning calls should emit heartbeat progress between tool calls");
assert.match(agentLoopSource, /LLM_RECOVERY_RETRIES/, "transient LLM network failures should have a bounded recovery retry");
assert.match(agentLoopSource, /type:\s*"llm_error"[\s\S]*type:\s*"interrupted"/, "final LLM network failures should preserve the checkpoint instead of becoming a fake report");
assert.match(agentLoopSource, /QUALITY_RETRY_LIMIT\s*=\s*2/, "quality repair must have a bounded retry window");
assert.match(agentLoopSource, /inFlightToolRuns[\s\S]*toolRunKey[\s\S]*timed out after/, "tool work must be deduplicated and bounded by a tool-level timeout");
assert.match(agentLoopSource, /type:\s*"reuse_tool_result"[\s\S]*tool_result_reused/, "Etsy business evidence searches must reuse an existing engine/query result instead of reopening a tab");
assert.match(agentLoopSource, /isReusableSearchEvidence[\s\S]*screenshotRef[\s\S]*hasValidGoogleSearchEvidence/, "search evidence reuse should accept screenshot/page evidence, not only strict ok:true results");
assert.match(agentLoopSource, /toolName === "search_in_browser"[\s\S]*!isSourcingSkill\(skillId\)/, "duplicate search reuse should protect all non-sourcing Etsy business skills, not only trends");
assert.match(agentLoopSource, /PLATFORM_TRENDS_ALLOWED_TOOLS[\s\S]*platform_trends_tool_whitelist_guard/, "trend workflows must reject unrelated tools before evidence collection drifts");
assert.match(agentLoopSource, /validatePlatformTrendToolResult[\s\S]*step_quality_blocked/, "trend tool results must pass a per-step evidence gate before the next LLM turn");
assert.match(agentLoopSource, /quality_gate_blocked[\s\S]*不得交付为成功报告/, "reports that still fail validation after retries must be blocked, not delivered");
assert.match(agentLoopSource, /restoredCheckpoint\.status === "quality_gate_blocked"[\s\S]*\? 0/, "user continuation after a quality block must receive a fresh bounded repair window");
assert.match(backgroundSource, /qualityGateBlocked[\s\S]*status: qualityGateBlocked \? "quality_gate_blocked"/, "background must preserve quality-gate interruption state for resumable repair");
assert.match(agentLoopSource, /MAX_LLM_TOTAL_CHARS\s*=\s*140000/, "LLM planning requests should have a total history payload budget");
assert.doesNotMatch(agentLoopSource, /MAX_CONTINUOUS_RUNTIME_MS\s*=\s*15 \* 60 \* 1000/, "normal workflows must not be hard-interrupted by a fixed continuous runtime budget");
assert.doesNotMatch(agentLoopSource, /工作流已达到本次连续运行预算/, "normal workflow delivery must not stop at a fixed continuous runtime budget");
assert.match(backgroundSource, /type:\s*"INTERRUPTED"[\s\S]*不.*saved|type:\s*"INTERRUPTED"/, "interrupted workflows must be delivered as resumable state, not success reports");
assert.match(js, /isInterruptedSavedResult[\s\S]*filter\(\(entry\) => !isInterruptedSavedResult/, "legacy interrupted pseudo-reports must not appear in the report center");
assert.match(backgroundSource, /etsy_platform_trends\.skill\.md/, "platform trend action must use a dedicated trend skill");
assert.match(js, /explore_platform_trends[\s\S]*etsy_platform_trends\.skill\.md/, "dashboard platform trend action must route to dedicated trend skill");
assert.match(sidepanelSource, /explore_platform_trends[\s\S]*skillId:\s*"etsy_platform_trends"/, "sidepanel platform trend action must route to the dedicated trend skill");
assert.match(sidepanelSource, /GROWTH_ACTION_SKILL_PATHS[\s\S]*explore_platform_trends:\s*"skills\/etsy_platform_trends\.skill\.md"[\s\S]*resolvedSkillPath/, "sidepanel platform trend runs must pass the explicit trend skill path");
assert.match(contentSource, /GROWTH_ACTION_SKILL_PATHS[\s\S]*explore_platform_trends:\s*"skills\/etsy_platform_trends\.skill\.md"[\s\S]*skillPath = GROWTH_ACTION_SKILL_PATHS\[growthActionId\]/, "floating overlay platform trend runs must pass the explicit trend skill path instead of relying on shop-page auto routing");
assert.match(backgroundSource, /hasPlatformTrendIntent[\s\S]*skills\/etsy_platform_trends\.skill\.md[\s\S]*return matched[\s\S]*isEtsyShopPage/, "background auto router must prioritize explicit platform trend intent before shop-page optimizer defaults");
assert.match(
  backgroundSource,
  /find_expansion_opportunities:\s*\[\s*"skills\/etsy_product_opportunity_explorer\.skill\.md"\s*\]/,
  "product opportunity exploration must not auto-load sourcing; sourcing should be an explicit follow-up action"
);
assert.doesNotMatch(
  backgroundSource,
  /find_expansion_opportunities:[^\n]+etsy_sourcing_finder/,
  "opportunity reports must not be polluted by sourcing skill output shape"
);
assert.match(
  backgroundSource,
  /ETSY_SKILL_PATHS[\s\S]*"skills\/etsy_crossborder_explorer\.skill\.md"/,
  "cross-border explorer skill must be registered in the known skill path set"
);
assert.match(
  backgroundSource,
  /id:\s*"etsy_crossborder_explorer"[\s\S]*path:\s*"skills\/etsy_crossborder_explorer\.skill\.md"/,
  "cross-border explorer skill must appear in listSkills()"
);
assert.match(
  backgroundSource,
  /validate_opportunity_sourcing:\s*\[\s*"skills\/etsy_sourcing_finder\.skill\.md"\s*\]/,
  "validate_opportunity_sourcing must be an explicit two-stage sourcing action, not auto-loaded into find_expansion_opportunities"
);
assert.match(
  js,
  /validate_opportunity_sourcing[\s\S]*runFollowUpSourcingTask/,
  "dashboard must render sourcing follow-up tasks and wire them to the two-stage action"
);
assert.match(
  sidepanelSource,
  /sidepanel-follow-up-sourcing-btn[\s\S]*activateGrowthAction\("validate_opportunity_sourcing"\)/,
  "sidepanel must render sourcing follow-up tasks that activate the explicit two-stage action"
);
assert.match(agentLoopSource, /newestImageMessage/, "older screenshot data URLs should not be resent on every planning turn");
assert.match(backgroundSource, /runInFlight/, "background should reject duplicate concurrent workflow starts on one port");
assert.match(backgroundSource, /acquireWorkflowLease[\s\S]*releaseWorkflowLease/, "background should use a global workflow lease instead of a per-port lock only");
assert.match(agentLoopSource, /isWorkflowCancellationRequested[\s\S]*workflow_cancellation_requested/, "agent loop should honor durable workflow cancellation at node boundaries");
assert.match(agentLoopSource, /isWorkflowGenerationCurrent[\s\S]*stale_tool_result_discarded/, "late results from an older workflow generation must be discarded");
assert.match(agentLoopSource, /putDataUrlArtifact[\s\S]*workflow-loop-screenshot/, "immediate workflow screenshots should be retained as evidence artifacts");
assert.match(toolRegistrySource, /executeGenericDomSnapshot[\s\S]*allFrames: true[\s\S]*scripting_executeScript_dom_fallback/, "page reading should have an all-frame DOM fallback route");
assert.match(toolRegistrySource, /captureFullPageScreenshot[\s\S]*screenshotCaptureMode/, "Etsy evidence capture should use debugger-backed full-page screenshots with fallback");
assert.match(toolRegistrySource, /getTabForCapture[\s\S]*isCapturableTabUrl[\s\S]*expectedUrl[\s\S]*_captureTabScreenshot\(tabId,\s*\{ expectedUrl:\s*payload\.searchUrl \}\)/, "search screenshots should wait for a capturable http(s) tab URL and use the search URL as a diagnostic fallback");
assert.match(agentLoopSource, /captureFullPageScreenshot[\s\S]*captureVisibleTab_viewport/, "Etsy detail-page loop screenshots should prefer full-page capture and retain viewport fallback");
assert.match(toolRegistrySource, /createOwnedTab[\s\S]*closeOwnedTab/, "Etsy crawl tabs should have centralized workflow ownership");
assert.match(browserSessionManagerSource, /openerTabId[\s\S]*chrome\.tabs\.create/, "workflow-created tabs should preserve the source tab as opener instead of replacing the shop page");
assert.match(browserSessionManagerSource, /function focusCreatedTab[\s\S]*chrome\.tabs\.update\(tab\.id,\s*\{\s*active:\s*true\s*\}[\s\S]*chrome\.windows\.update\(tab\.windowId,\s*\{\s*focused:\s*true\s*\}/, "active workflow tabs should be explicitly selected and their window focused");
assert.match(browserSessionManagerSource, /createOwnedTabCallback[\s\S]*if \(active\) await focusCreatedTab\(tab\)/, "callback-created visible evidence tabs should be focused after creation");
assert.match(browserSessionManagerSource, /protectWorkflowTab[\s\S]*isProtectedWorkflowTab[\s\S]*closeOwnedTab[\s\S]*return false/, "workflow tab manager must refuse to close protected source tabs");
assert.match(browserSessionManagerSource, /cleanupOwnedTabs[\s\S]*protectedIds[\s\S]*filter\(\(id\) => !protectedIds\.has\(id\)\)/, "workflow cleanup must exclude protected source tabs");
assert.match(backgroundSource, /protectWorkflowTab\(checkpointKey,\s*tab\.id\)/, "background must register the originating shop tab as protected for the workflow");
assert.match(agentLoopSource, /__sourceTabId:\s*tabId/, "agent loop should pass the original source tab id into runtime tools");
assert.match(toolRegistrySource, /getSourceOrCurrentTab[\s\S]*read_current_page/, "current-page tools should prefer the workflow source tab over whichever temporary tab is active");
assert.match(toolRegistrySource, /restoreSourceTabFocus[\s\S]*search_tab_closed/, "browser searches should restore focus to the source shop tab after closing temporary evidence tabs");
assert.match(toolRegistrySource, /protectedSourceTab[\s\S]*Refused to close source tab/, "close_tab must refuse to close the original source tab");
assert.match(toolRegistrySource, /navigate_to[\s\S]*createOwnedTab\(\{ workflowId,\s*url:\s*safeEncodeURI\(url\),\s*active:\s*true,\s*openerTabId:\s*__sourceTabId \}\)[\s\S]*waitForTabReadiness\(created\.id/, "navigate_to must open a workflow-owned temporary tab and wait for readiness instead of replacing the source shop tab");
assert.doesNotMatch(toolRegistrySource, /navigate_to[\s\S]{0,900}chrome\.tabs\.update\([^)]*url:/, "navigate_to must not update the current/source tab URL");
assert.match(toolRegistrySource, /createOwnedTabCallback[\s\S]*search_in_browser[\s\S]*google_trends/, "browser search tabs should use workflow ownership");
assert.match(toolRegistrySource, /image_search_1688[\s\S]*createOwnedTabCallback/, "image search tabs should use workflow ownership");
assert.match(toolRegistrySource, /etsy_crawl_page_started[\s\S]*etsy_crawl_page_completed[\s\S]*etsy_crawl_completed/, "Etsy crawl should expose durable stage events rather than one opaque tool call");
assert.match(toolRegistrySource, /etsy_screenshot_observation_started[\s\S]*etsy_screenshot_observation_completed/, "screenshot analysis should expose durable per-page stage events");
assert.match(sidepanelSource, /msg\.type === "llm_started"/, "sidepanel should show LLM request payload telemetry");
assert.match(sidepanelSource, /msg\.type === "tool_stage"/, "sidepanel should show concrete browser tool stages");
assert.match(sidepanelSource, /activeToolRunId[\s\S]*msg\.type === "tool_heartbeat"[\s\S]*msg\.toolRunId !== activeToolRunId[\s\S]*return/, "sidepanel should ignore stale tool heartbeats from completed tool runs");
assert.match(contentSource, /data\.type === "tool_stage"/, "floating overlay should show concrete browser tool stages");
assert.match(contentSource, /activeOverlayToolRunId[\s\S]*data\.type === "tool_heartbeat"[\s\S]*data\.toolRunId !== activeOverlayToolRunId[\s\S]*return/, "floating overlay should ignore stale tool heartbeats from completed tool runs");
assert.match(backgroundSource, /buildResearchScope[\s\S]*pageContext\.research_scope[\s\S]*shouldClarifyResearchScope/, "background should build research_scope before running Etsy workflows and block weak trend scope");
assert.match(agentLoopSource, /当前研究范围与页面角色[\s\S]*source_page_role 是 competitor_reference[\s\S]*entry_page_type 是 etsy_home/, "agent loop prompt should make research_scope a first-class execution constraint");
assert.match(agentLoopSource, /currency_rates[\s\S]*价格与区域口径硬约束[\s\S]*ship_to=US\/GB\/DE\/FR\/CA\/AU[\s\S]*不要为了前台对标把 Etsy 页面显示价格二次换算成 USD[\s\S]*付费、后台或账号型工具不得作为必需证据/, "agent loop prompt should use free regional frontend prices and reserve FX conversion for financial ledgers");
assert.match(agentLoopSource, /店铺体检生产骨架（必须逐槽生产）[\s\S]*不得等最终报告阶段才临时补结构/, "shop optimizer production process should be driven by the same report skeleton before final delivery");
assert.match(agentLoopSource, /report_skeleton_state[\s\S]*nextMissingSlot[\s\S]*推进店铺体检生产骨架/, "tool-result context should carry report skeleton state into the next LLM planning turn");
assert.match(agentLoopSource, /shop_report_skeleton_progress[\s\S]*filledCount[\s\S]*nextMissingSlot/, "workflow runtime should emit durable shop report skeleton progress events");
assert.match(toolRegistrySource, /ship_to=\$\{region\.etsyShipTo\}|ship_to=US/, "Etsy browser evidence URLs should request regional storefronts instead of relying on post-hoc currency conversion");
assert.match(toolRegistrySource, /FREE_MARKET_REGIONS[\s\S]*etsyShipTo: "GB"[\s\S]*amazonHost: "www\.amazon\.de"[\s\S]*ebayHost: "www\.ebay\.com\.au"/, "free public regional sources should cover Etsy, Amazon and eBay market pages");
assert.match(toolRegistrySource, /google_trends_12m_\$\{regionKey\}[\s\S]*google_trends_\$\{regionKey\}_no_date_fallback/, "regional Google Trends engines should share screenshot-friendly fallback attempts");
assert.match(toolRegistrySource, /isFreePublicSearchEngine[\s\S]*amazon[\s\S]*ebay[\s\S]*google_news[\s\S]*google_trends/, "browser search should only auto-handle free public evidence engines");
assert.match(agentLoopSource, /instagram_social[\s\S]*amazon_search[\s\S]*ebay_search/, "evidence ledger should recognize free social and purchase-intent auxiliary sources");
assert.match(baseAuditorSkillSource, /免费、公开、无需付费订阅[\s\S]*不得作为必需证据/, "base auditor should prohibit paid or backend-only tools as required evidence");
assert.match(toolRegistrySource, /function shouldLocalizeSearchQuery[\s\S]*return \/\[\\u4e00-\\u9fa5\]\//, "English Google/Etsy evidence queries should not pay an extra LLM localization call before opening the browser page");
assert.match(agentLoopSource, /__toolRunState[\s\S]*cancelled[\s\S]*inFlightToolRuns\.delete\(key\)/, "timed-out tools should receive a soft cancellation token and stop leaking late browser stages");
assert.match(toolRegistrySource, /__toolRunState\?\.cancelled[\s\S]*搜索工具在创建临时标签页前已被当前工具超时取消/, "browser searches should check the soft cancellation token before opening tabs");
assert.match(backgroundSource, /GET_CURRENCY_RATES[\s\S]*REFRESH_CURRENCY_RATES[\s\S]*SAVE_CURRENCY_RATES/, "background should expose shared currency-rate management endpoints");
assert.match(toolRegistrySource, /code:\s*"VERIFICATION_REQUIRED"[\s\S]*notifyVerificationRequired/, "1688/Taobao verification walls should return an explicit resumable verification code");
assert.match(sidepanelSource, /captcha-resume-btn[\s\S]*我已完成验证[\s\S]*instruction\.value = "继续"/, "sidepanel verification banner should provide a resume action after manual verification");
assert.match(html, /manual-funnel-card[\s\S]*Search Analytics CSV[\s\S]*manual-funnel-save-btn/, "dashboard should expose manual Search Analytics funnel completion controls");
assert.match(js, /MANUAL_FUNNEL_STORAGE_KEY[\s\S]*parseSearchAnalyticsCsv[\s\S]*buildManualFunnelSnapshot/, "dashboard should parse and persist manual Etsy backend funnel data");
assert.match(agentLoopSource, /手动补录\|用户提供\|Search Analytics\|后台漏斗\|manual/, "operations quality gate should allow explicitly sourced user-provided backend funnel metrics");
assert.match(contentSource, /CLARIFICATION_REQUIRED[\s\S]*需要先明确研究范围/, "floating overlay should render weak-context clarification instead of treating it as a generic failure");
assert.match(sidepanelSource, /CLARIFICATION_REQUIRED[\s\S]*需要先明确研究范围/, "sidepanel should render weak-context clarification instead of treating it as a generic failure");
assert.match(baseAuditorSkillSource, /研究范围与页面角色[\s\S]*competitor_reference[\s\S]*个人 API 边界[\s\S]*证据质量/, "base auditor should make research scope, API/public evidence boundaries, and evidence quality mandatory across skills");

const normalizedRates = normalizeCurrencyRates({
  usdToCny: 7.25,
  shippingPerKgUsd: 5.5,
  parcelFeeUsd: 2,
  handlingFeeCny: 2,
  platformFeeRate: 0.12,
  fxLossRate: 0,
  customsThresholdUsd: 220,
});
const quickCalc = calculateQuickArbitrage({ costCny: 10, weightKg: 0.5, priceUsd: 25, rates: normalizedRates });
assert.ok(quickCalc.costUsd > 1 && quickCalc.costUsd < 2, "10 CNY should convert to roughly 1-2 USD, not a RUB-denominated dollar amount");
assert.ok(quickCalc.shippingUsd > 4 && quickCalc.shippingUsd < 6, "0.5 kg shipping should remain in single-digit USD under default assumptions");
assert.ok(quickCalc.netProfitUsd > 14 && quickCalc.netProfitUsd < 20, "quick arbitrage calculator should produce a plausible USD net profit for 25 USD price");
assert.ok(quickCalc.marginRate > 55 && quickCalc.marginRate < 80, "quick arbitrage margin should be plausible after USD normalization");

const ownShopScope = buildResearchScope({
  pageContext: {
    url: "https://www.etsy.com/shop/MidnightReveriee",
    title: "MidnightReveriee - Etsy",
    h1: "MidnightReveriee",
  },
  activeShopId: "shop-1",
  shops: [{ id: "shop-1", name: "MidnightReveriee", shopId: "MidnightReveriee" }],
  growthActionId: "explore_platform_trends",
});
assert.equal(ownShopScope.entry_page_type, "own_shop", "research scope should recognize bound self shop pages");
assert.equal(ownShopScope.source_page_role, "self_reference", "bound self shop pages should be self references");
assert.equal(shouldClarifyResearchScope(ownShopScope), false, "self shop trend runs should not require scope clarification");

const competitorShopScope = buildResearchScope({
  pageContext: {
    url: "https://www.etsy.com/shop/TopWeddingClutch",
    title: "TopWeddingClutch - Etsy",
    h1: "TopWeddingClutch",
  },
  activeShopId: "shop-1",
  shops: [{ id: "shop-1", name: "MidnightReveriee", shopId: "MidnightReveriee" }],
  userInstruction: "分析这个竞品店铺趋势",
  growthActionId: "explore_platform_trends",
});
assert.equal(competitorShopScope.entry_page_type, "competitor_shop", "research scope should not treat unmatched shop pages as self shop");
assert.equal(competitorShopScope.source_page_role, "competitor_reference", "unmatched shop pages should be competitor references");

const etsyHomeWeakScope = buildResearchScope({
  pageContext: { url: "https://www.etsy.com/", title: "Etsy" },
  userInstruction: "分析平台趋势",
  growthActionId: "explore_platform_trends",
});
assert.equal(etsyHomeWeakScope.entry_page_type, "etsy_home", "research scope should recognize Etsy home as weak context");
assert.equal(shouldClarifyResearchScope(etsyHomeWeakScope), false, "Etsy home trend runs without a keyword should enter auto-discovery instead of clarification");
assert.equal(Boolean(etsyHomeWeakScope.auto_discovery_required), true, "Etsy home trend runs without a keyword should set auto_discovery_required");

const etsySearchScope = buildResearchScope({
  pageContext: {
    url: "https://www.etsy.com/search?q=wedding%20clutch",
    title: "Wedding clutch - Etsy",
  },
  growthActionId: "explore_platform_trends",
});
assert.equal(etsySearchScope.entry_page_type, "etsy_search", "research scope should recognize Etsy search pages");
assert.equal(etsySearchScope.target_entity.name, "wedding clutch", "research scope should extract Etsy search query as target keyword");

const competitorContextForShopOptimizer = {
  url: "https://www.etsy.com/shop/TopWeddingClutch",
  title: "TopWeddingClutch - Etsy",
  research_scope: competitorShopScope,
};
const competitorAsSelfShopReport = {
  type: "final",
  output: {
    overview: "## 店铺体检\n当前店铺已具备婚礼包趋势优势。",
    analysis: "本店需要继续强化主图。",
    summary: "你的店铺下一步做 ABC 整改。",
    data: [{
      plan_id: "A-1",
      diagnosis_level: "A",
      direction: "优化当前店铺主图",
      evidence: "竞品页面可见样本。",
      expected_impact: "提升转化。",
      first_actions: ["改主图"],
      risk_guard: "待验证。",
      evidence_ledger: [{
        source_type: "page_dom",
        source_ref: "https://www.etsy.com/shop/TopWeddingClutch",
        observed_value: "竞品店铺公开页面。",
        used_for: "页面角色一致性测试。",
        confidence: "medium",
        limitation: "竞品页面不能代表自营店铺。",
      }],
    }],
  },
};
assert.ok(
  validateReport(competitorAsSelfShopReport, "", "skills/etsy_global_shop_optimizer.skill.md", [], competitorContextForShopOptimizer).some((error) => /竞品公开参考|非自营页面|自营店铺事实/.test(error)),
  "global research-scope validation should block treating competitor pages as own-shop diagnosis",
);
assert.match(sidepanelSource, /msg\.type === "llm_heartbeat"[\s\S]*AI 正在基于已采集证据规划下一步/, "sidepanel should show LLM heartbeat progress instead of appearing stuck between tool calls");
assert.match(sidepanelSource, /msg\.type === "llm_retry"[\s\S]*msg\.type === "llm_error"/, "sidepanel should show bounded LLM network recovery state");
assert.match(agentLoopSource, /etsyAgentCheckpoint:/, "agent loop should persist resumable workflow checkpoints");
assert.match(agentLoopSource, /CHECKPOINT_IMAGE_PLACEHOLDER/, "persisted checkpoints should omit base64 screenshot payloads");
assert.match(agentLoopSource, /type:\s*"checkpoint_restored"/, "agent loop should notify the UI when a checkpoint is restored");
assert.match(agentLoopSource, /stripCheckpointDataUrls[\s\S]*CHECKPOINT_IMAGE_PLACEHOLDER[\s\S]*serializeToolHistoryForCheckpoint/, "persisted tool history should omit raw data-image payloads");
assert.match(agentLoopSource, /compactToolResultForLLM[\s\S]*MAX_LLM_PRODUCT_CARDS[\s\S]*visibleTextSnippet/, "tool results sent back to the LLM should be compressed before the next reasoning turn");
assert.match(agentLoopSource, /compactMessagesForLLM\(messages\)[\s\S]*callLLM\(llmMessages/, "agent loop should compact message history before every LLM request");
assert.match(agentLoopSource, /rawResultPreservedInToolHistory:\s*true/, "compressed LLM payloads should preserve raw evidence in tool history for validators");
assert.match(agentLoopSource, /productCardsCount[\s\S]*truncateText\(ctx\.visibleText/, "initial page context should be summarized before entering the prompt");
assert.match(agentLoopSource, /lastNode:\s*"llm_response_received"/, "agent loop should checkpoint after receiving an LLM response");
assert.match(agentLoopSource, /status:\s*"tool_pending"[\s\S]*lastNode:\s*"tool_call_ready"/, "agent loop should checkpoint before executing a parsed tool call");
assert.match(agentLoopSource, /status:\s*"tool_guard_retry"/, "agent loop should checkpoint guard-driven retry nodes");
assert.match(agentLoopSource, /getEtsyBrowserWorkflowGuardResult[\s\S]*重复 open_new_tab[\s\S]*collect_etsy_shop_pages/, "Etsy browser workflow should prevent repeated tab opening loops and route shop pages into collection");
assert.match(toolRegistrySource, /attachSearchScreenshotArtifact[\s\S]*search-evidence-screenshot[\s\S]*closeTabQuietly/, "browser searches should persist screenshot evidence before auto-closing temporary tabs");
assert.match(agentLoopSource, /本轮已有 3 个或以上已完成取证但未关闭的新标签页/, "Etsy browser workflow should require closing evidence tabs before opening more");
assert.match(agentLoopSource, /runToolWithTimeout[\s\S]*timed out after[\s\S]*toolTimeoutMs/, "agent loop should enforce tool-level timeouts instead of waiting indefinitely");
assert.match(agentLoopSource, /closeTabsCreatedDuringTimedOutTool\(tabsBeforeTool,\s*new Set\(\[tabId\]\)\)[\s\S]*tool_timeout/, "timed-out browser tools should clean up temporary tabs while protecting the source tab");
assert.doesNotMatch(agentLoopSource, /requestWorkflowCancellation\(toolArgs\.workflowId,\s*`\$\{toolName\}_timeout`/, "ordinary tool timeout must not cancel the entire workflow");
assert.match(agentLoopSource, /describeToolAction[\s\S]*Etsy 搜索结果页取证[\s\S]*Etsy 商品详情页取证/, "browser actions should distinguish search result evidence from detail-page evidence");
assert.match(agentLoopSource, /actionLabel:\s*plannedToolAction\.actionLabel[\s\S]*type:\s*"tool_timeout"[\s\S]*actionLabel:\s*toolAction\.actionLabel[\s\S]*type:\s*"tool_result"[\s\S]*actionLabel:\s*completedToolAction\.actionLabel/, "progress events should carry action labels from tool start through timeout and result");
assert.match(agentLoopSource, /timeoutSeconds[\s\S]*最长等待/, "tool heartbeat should expose the maximum wait time to the UI");
assert.match(agentLoopSource, /loopLimitDisabled:\s*true/, "agent loop progress should no longer expose a user-configurable loop step limit");
assert.match(agentLoopSource, /INTERNAL_RUNAWAY_GUARD_STEPS\s*=\s*200/, "agent loop should keep only a high internal runaway guard");
assert.doesNotMatch(agentLoopSource, /Agent loop exceeded maximum steps|max_steps_exceeded/, "agent loop should not fail normal workflows on a fixed max-step cap");
assert.doesNotMatch(agentLoopSource, /Critic Agent 正在进行深层商业推演反思/, "valid final reports should not pay an extra mandatory deep-reflection LLM turn");
assert.doesNotMatch(sidepanelHtmlSource, /maxLoopSteps|最大循环步数/, "sidepanel should not expose max loop step settings");
assert.doesNotMatch(sidepanelSource, /maxLoopSteps/, "sidepanel should not read or persist max loop step settings");
assert.doesNotMatch(contentSource, /llm-max-steps|maxLoopSteps|llmMaxSteps|最大循环步数/, "content settings drawer should not expose or persist max loop step settings");
assert.doesNotMatch(backgroundSource, /maxLoopSteps/, "background defaults should not seed max loop step settings");
assert.match(agentLoopSource, /resumeState\s*=\s*null/, "agent loop should accept workflow-level resume state from background storage");
assert.match(agentLoopSource, /onCheckpoint\s*=\s*null/, "agent loop should expose every saved node to workflow-level checkpoint storage");
assert.match(agentLoopSource, /不要重复已经完成的搜索、开页、筛选或已获得的工具证据/, "resume prompt should prevent repeating completed evidence work");
assert.match(backgroundSource, /WORKFLOW_CHECKPOINTS_KEY\s*=\s*"agentWorkflowCheckpoints"/, "background should persist workflow checkpoints in chrome.storage.local");
assert.match(backgroundSource, /buildWorkflowCheckpointKey[\s\S]*workflowSessionId[\s\S]*growthCaseId/, "workflow checkpoint lookup should support session and growth-case ids");
assert.match(backgroundSource, /lastStage:\s*"port_disconnected"/, "port disconnects should mark the workflow checkpoint as interrupted");
assert.match(backgroundSource, /status:\s*"interrupted"/, "background should preserve disconnected runs as resumable interrupted checkpoints");
assert.match(backgroundSource, /function isCheckpointFollowupInstruction[\s\S]*继续\|继续推进\|恢复\|resume\|continue[\s\S]*忽略\\s\*\(\?:api\|API\)/, "checkpoint resume should accept explicit continue words and API-ignore follow-up instructions");
assert.match(backgroundSource, /function isExplicitResumeRequest[\s\S]*forceNewSession[\s\S]*continueSession[\s\S]*isCheckpointFollowupInstruction/, "checkpoint resume should require an explicit continue/resume/follow-up request");
assert.doesNotMatch(backgroundSource, /shouldResumeFromCheckpoint[\s\S]{0,220}Boolean\(message\.growthCaseId\)/, "growthCaseId alone must not auto-resume an old checkpoint");
assert.match(sidepanelSource, /forceNewSession:\s*!shouldContinueSession/, "sidepanel should default to a fresh task unless the user explicitly continues");
assert.doesNotMatch(sidepanelHtmlSource, /continueSessionCheckbox|延续上一轮的对话记忆/, "sidepanel should not hide resume behavior behind a checkbox");
assert.match(sidepanelHtmlSource, /newSessionBtn[\s\S]*\+ 新会话[\s\S]*sessionHistoryBtn[\s\S]*历史会话 \/ 恢复断点/, "sidepanel should expose direct new-session and session-history controls");
assert.match(sidepanelHtmlSource, /clearSessionHistoryBtn[\s\S]*清空历史/, "sidepanel session history should expose an explicit clear-all-history action");
assert.match(sidepanelSource, /CLEAR_SESSION_HISTORY[\s\S]*startNewSessionMode[\s\S]*renderSessionHistory\(\[\]\)/, "sidepanel clear history should call background cleanup and reset to fresh-session mode");
assert.match(sidepanelSource, /getActiveResumeSessionKey[\s\S]*createWorkflowSessionId/, "sidepanel should create fresh workflow sessions only when no selected or auto-picked resumable session exists");
assert.ok(
  sidepanelHtmlSource.indexOf("session-control session-control-top") > sidepanelHtmlSource.indexOf("growth-command-card") &&
  sidepanelHtmlSource.indexOf("session-control session-control-top") < sidepanelHtmlSource.indexOf("advanced-skill-section"),
  "session controls should be visible near the top of the main view instead of hidden below the instruction area"
);
assert.match(sidepanelSource, /pickLatestResumableSessionForContinue[\s\S]*legacyContinueInstruction[\s\S]*pickLatestResumableSessionForContinue/, "plain continue messages should auto-select the latest resumable checkpoint instead of creating a fresh session id");
assert.match(
  contentSource,
  /chat-session-control[\s\S]*chat-new-session-btn[\s\S]*aria-label="开启新会话"[\s\S]*chat-session-history-btn[\s\S]*aria-label="历史会话"[\s\S]*chat-session-history-panel/,
  "floating content overlay should expose left-floating icon controls for new session and history"
);
assert.match(contentSource, /chat-session-clear-btn[\s\S]*清空历史[\s\S]*CLEAR_SESSION_HISTORY/, "floating overlay history should expose an explicit clear-all-history action");
assert.match(
  contentSource,
  /\.chat-session-control\s*\{[\s\S]*left:\s*-54px[\s\S]*flex-direction:\s*column[\s\S]*\.chat-session-history-panel\s*\{[\s\S]*position:\s*absolute[\s\S]*top:\s*68px/,
  "floating session controls should live to the left of the chat and history should render as an overlay panel"
);
assert.match(contentSource, /OVERLAY_HISTORY_CATEGORIES[\s\S]*平台趋势[\s\S]*竞品研究[\s\S]*getOverlayCheckpointCategoryId/, "floating overlay session history should classify checkpoints by business category");
assert.match(contentSource, /chat-session-history-filter[\s\S]*data-history-category[\s\S]*chat-session-history-badge[\s\S]*chat-session-history-target[\s\S]*chat-session-history-role/, "floating overlay history cards should show category, target and page role");
assert.match(sidepanelSource, /SESSION_HISTORY_CATEGORIES[\s\S]*店铺体检[\s\S]*平台趋势[\s\S]*getCheckpointCategoryId/, "sidepanel session history should expose the same business categories");
assert.match(sidepanelSource, /session-history-filter[\s\S]*data-session-category[\s\S]*session-history-badge[\s\S]*session-history-target[\s\S]*session-history-role/, "sidepanel history cards should show category, target and page role");
assert.match(backgroundSource, /research_scope:\s*pageContext\.research_scope \|\| null[\s\S]*researchScope:\s*pageContext\.research_scope \|\| null/, "workflow checkpoints should persist research scope for session history classification");
assert.match(contentSource, /pickLatestOverlayResumableSessionForContinue[\s\S]*legacyContinueInstruction[\s\S]*pickLatestOverlayResumableSessionForContinue/, "floating overlay plain continue messages should auto-select the latest resumable checkpoint");
assert.match(contentSource, /isOverlayCheckpointFollowupInstruction[\s\S]*忽略\\s\*\(\?:api\|API\)[\s\S]*legacyContinueInstruction = isOverlayCheckpointFollowupInstruction/, "floating overlay should treat API-ignore messages as checkpoint follow-ups");
assert.match(contentSource, /workflowSessionId[\s\S]*continueSession[\s\S]*forceNewSession/, "floating overlay should pass explicit session intent into RUN_SKILL");
assert.match(contentSource, /const startOverlayNewSessionMode[\s\S]*overlaySessionMode = "new"[\s\S]*updateOverlaySessionModeUI\(\)/, "floating overlay should reset state through an explicit fresh-session mode function");
assert.match(contentSource, /chat-session-mode-text[\s\S]*新会话：不会沿用旧断点/, "floating overlay should make fresh-session mode visible instead of hidden behind implicit behavior");
assert.ok(contentSource.includes("const isSellerPage = isEtsy && /\\/(shop|seller)\\//i.test(window.location.pathname);"), "floating overlay must recognize real Etsy /shop/... storefront URLs as seller pages");
assert.match(contentSource, /if \(isSellerPage\) \{\s*return \["diagnose_store_growth"\];\s*\}/, "Etsy shop homepages should expose only the store diagnosis business shortcut");
assert.doesNotMatch(contentSource, /bindShopBtn|updateActiveShopTooltip|绑定此店铺到 AI 大盘/, "floating dock should keep shop binding inside settings instead of adding another homepage button");
assert.match(contentSource, /resumableEntries\.length > 0[\s\S]*已暂停自动运行[\s\S]*return;[\s\S]*runOverlayGrowthActionNow/, "floating overlay action clicks should pause for session choice when resumable checkpoints exist");
assert.match(contentSource, /OVERLAY_PENDING_ACTION_KEY[\s\S]*saveOverlayPendingGrowthAction[\s\S]*chrome\.storage\.local\.set/, "floating overlay should persist the pending business action so + new session survives UI/script refreshes");
assert.match(contentSource, /isSameOverlayPage[\s\S]*leftUrl\.origin[\s\S]*leftUrl\.pathname[\s\S]*leftUrl\.search/, "floating overlay pending actions should tolerate hash changes while preventing cross-page accidental starts");
assert.match(contentSource, /openGrowthAction[\s\S]*await saveOverlayPendingGrowthAction[\s\S]*resumableEntries\.length > 0/, "floating overlay action clicks must save a pending action before asking the user to choose resume or new session");
assert.match(contentSource, /chat-session-resume-btn[\s\S]*resolveOverlayActionToRun[\s\S]*resume:\s*true/, "choosing a history item from the floating overlay should resume the pending action through the durable pending resolver");
assert.match(contentSource, /chat-new-session-btn[\s\S]*resolveOverlayActionToRun[\s\S]*runOverlayGrowthActionNow[\s\S]*resume:\s*false/, "clicking + new session from a pending floating action should resolve durable pending state and start a fresh run explicitly");
assert.match(contentSource, /chat-new-session-btn[\s\S]*typedInstruction[\s\S]*sendMessage\(\)/, "clicking + new session with typed input should start a fresh instruction instead of only changing hidden session state");
assert.match(contentSource, /activeAgentPort[\s\S]*CANCEL_WORKFLOW[\s\S]*pauseActiveWorkflow/, "floating overlay pause button should request workflow cancellation through the active port");
assert.match(contentSource, /sendBtn\.innerText = pausing \? "暂停中" : "暂停"/, "floating overlay send button should become a pause button while a workflow is running");
assert.match(backgroundSource, /message\.type === "CANCEL_WORKFLOW"[\s\S]*requestWorkflowCancellation[\s\S]*lastStage:\s*"user_paused"/, "background should persist user-paused workflows as resumable checkpoints");
assert.match(backgroundSource, /message\.type === "CLEAR_SESSION_HISTORY"[\s\S]*clearAllSessionHistory/, "background should expose a single cleanup endpoint for session history");
assert.match(backgroundSource, /clearAllSessionHistory[\s\S]*activeWorkflowRuns > 0[\s\S]*clearAllWorkflowRuntime[\s\S]*clearTaskLogs/, "session history cleanup should avoid active workflows and clear runtime snapshots plus logs");
assert.match(workflowSchedulerSource, /acquireWorkflowSlot[\s\S]*releaseWorkflowSlot[\s\S]*getWorkflowSchedulerState/, "runtime should have a global workflow scheduler instead of per-port-only state");
assert.match(backgroundSource, /acquireWorkflowSlot[\s\S]*updateWorkflowSlot[\s\S]*releaseWorkflowSlot/, "background harness should acquire and release the global scheduler slot for every workflow");
assert.match(backgroundSource, /GET_WORKFLOW_RUNTIME_STATUS[\s\S]*getWorkflowSchedulerState/, "UI should be able to query the real background workflow runtime state");
assert.match(agentLoopSource, /__workflowContext[\s\S]*toolRunId[\s\S]*recordWorkflowExecutionEvent/, "tool execution should receive a unified workflow context and write execution ledger events");
assert.match(agentLoopSource, /tool_planned[\s\S]*tool_started[\s\S]*tool_finished/, "tool execution ledger should record planned, started and finished events");
assert.match(agentLoopSource, /stage:\s*"tool_execution_started"[\s\S]*正在发起浏览器动作/, "tool progress should distinguish accepted execution from later browser/page-read waiting");
assert.match(toolRegistrySource, /getWorkflowIdFromArgs[\s\S]*__workflowContext[\s\S]*isToolCancellationRequested/, "tool registry should understand the unified workflow context and cancellation checks");
assert.doesNotMatch(contentSource, /Привет|Здравствуйте|Спасибо|Пожалуйста/, "content overlay should not contain Russian copy in the Etsy plugin UI");
assert.match(backgroundSource, /resumeState:\s*shouldResumeFromCheckpoint\s*\?/, "background should pass resumable workflow state into the agent loop");
assert.match(backgroundSource, /onCheckpoint:\s*async/, "background should persist checkpoint updates emitted by the agent loop");
assert.match(js, /interrupted:\s*"已保存断点"/, "dashboard should show interrupted runs as saved checkpoints");
assert.match(js, /后台连接中断，已保存断点，可再次运行继续。/, "dashboard disconnects should not be shown as ordinary failed runs");
assert.match(toolRegistrySource, /closedTabId/, "browser search should report automatically closed temporary tabs");
assert.match(toolRegistrySource, /open_new_tab[\s\S]*waitForTabReadiness\(tab\.id/, "open_new_tab should wait on the newly opened tab by tabId instead of relying on the active tab");
assert.match(toolRegistrySource, /hasUsablePageEvidence[\s\S]*evidenceOk[\s\S]*ok: evidenceOk/, "open_new_tab must not report success without usable page evidence");
assert.match(toolRegistrySource, /Tab closed or not found[\s\S]*ok: false/, "open_new_tab must mark missing tabs as failed evidence");
assert.match(toolRegistrySource, /timedOut[\s\S]*readError/, "open_new_tab should report timeout/read-error state for workflow guards");
assert.match(toolRegistrySource, /function getReadinessProfile[\s\S]*google_trends[\s\S]*minWaitMs:\s*2500[\s\S]*minStableReads:\s*2[\s\S]*etsy[\s\S]*minWaitMs:\s*1600[\s\S]*minStableReads:\s*2/, "newly opened browser tabs should have platform-aware minimum loading residency and stable-read requirements before evidence capture");
assert.match(toolRegistrySource, /function pageDataSignature[\s\S]*visibleText[\s\S]*productLinks[\s\S]*productCards[\s\S]*trendText/, "tab readiness should use a content signature so dynamic pages must stabilize before capture");
assert.match(toolRegistrySource, /async function waitForTabReadiness[\s\S]*tab_readiness_wait_started[\s\S]*stableReads[\s\S]*content_stable[\s\S]*readiness_timeout/, "tab evidence tools should wait for stable readable DOM evidence instead of relying only on chrome tab complete");
assert.match(toolRegistrySource, /function buildEvidenceQuality[\s\S]*load_state[\s\S]*stable_reads[\s\S]*screenshot_captured[\s\S]*dom_evidence_ok[\s\S]*risk/, "browser evidence tools should standardize evidence_quality for report and debug surfaces");
assert.match(toolRegistrySource, /open_new_tab[\s\S]*waitForTabReadiness\(tab\.id[\s\S]*stableReads[\s\S]*readinessElapsedMs[\s\S]*readinessAttempts/, "open_new_tab should return stable-read readiness telemetry after waiting for stable page evidence");
assert.match(toolRegistrySource, /navigate_to[\s\S]*waitForTabReadiness\(created\.id[\s\S]*readinessElapsedMs[\s\S]*readinessAttempts/, "navigate_to should use the same loading/readiness gate as other temporary tabs");
assert.match(toolRegistrySource, /search_in_browser[\s\S]*minimumTabResidencyMs[\s\S]*requiredStableReads[\s\S]*contentStable[\s\S]*readinessElapsedMs/, "search_in_browser should not close evidence tabs before the minimum loading residency and stable-read window");
assert.match(agentLoopSource, /function formatEvidenceQualityForProgress[\s\S]*stableReads[\s\S]*证据质量/, "agent progress should format evidence quality for user-visible tool completion logs");
assert.match(agentLoopSource, /type:\s*"tool_result"[\s\S]*evidenceQualityNote/, "tool_result progress should surface evidence quality instead of only reporting generic tool success");
assert.match(toolRegistrySource, /shouldAutoCloseSearchTab[\s\S]*google_trends/, "Google and Trends search tabs should be auto-closed after evidence capture");
assert.match(toolRegistrySource, /search_tab_opening[\s\S]*search_tab_opened[\s\S]*search_page_reading[\s\S]*search_evidence_ready/, "browser search should report real tab-open/read/evidence stages instead of only a pre-call log");
assert.match(toolRegistrySource, /restoreSourceTabFocusBounded[\s\S]*Promise\.race[\s\S]*search_in_browser[\s\S]*search_tab_closed[\s\S]*resolve\(\{[\s\S]*restoreSourceTabFocusBounded\(__sourceTabId\)\.catch/, "browser search should not block tool completion on source-tab focus restoration after closing evidence tabs");
assert.match(toolRegistrySource, /hasValidEtsySearchEvidence/, "Etsy search evidence should have a runtime validity gate");
assert.match(toolRegistrySource, /buildBrowserSearchAttempts[\s\S]*etsy_market_fallback[\s\S]*google_trends_\$\{regionKey\}_no_date_fallback/, "Etsy and regional Google Trends browser searches should retry alternate evidence URLs");
assert.match(toolRegistrySource, /hasValidGoogleTrendsEvidence/, "Google Trends search evidence should have a runtime validity gate");
assert.match(toolRegistrySource, /shouldAutoCloseSearchTab[\s\S]*isFreePublicSearchEngine\(normalizedEngine\)/, "free public search tabs should be auto-closed after evidence capture unless keepTab is set");
assert.match(toolRegistrySource, /collect_etsy_shop_pages/, "tool registry should expose a traditional Etsy shop pagination collection loop");
assert.match(toolRegistrySource, /collect_etsy_listing_reviews[\s\S]*reviewPagination[\s\S]*etsy_review_crawl_completed/, "tool registry should expose bounded Etsy review pagination collection with durable evidence events");
assert.match(toolRegistrySource, /collect_etsy_shop_pages[\s\S]*sameTabId\(targetTabId,\s*__sourceTabId\)[\s\S]*createOwnedTab\(\{ workflowId,\s*url:\s*safeEncodeURI\(sourceUrl\),\s*active:\s*true,\s*openerTabId:\s*__sourceTabId \}\)[\s\S]*chrome\.tabs\.update\(targetTabId,\s*\{ url:\s*safeEncodeURI\(nextPageUrl\)/, "Etsy shop pagination must clone the source tab before navigating next pages");
assert.match(toolRegistrySource, /collect_etsy_listing_reviews[\s\S]*sameTabId\(targetTabId,\s*__sourceTabId\)[\s\S]*createOwnedTab\(\{ workflowId,\s*url:\s*safeEncodeURI\(sourceUrl\),\s*active:\s*true,\s*openerTabId:\s*__sourceTabId \}\)[\s\S]*chrome\.tabs\.update\(targetTabId,\s*\{ url:\s*safeEncodeURI\(nextUrl\)/, "Etsy review pagination must clone the source tab before navigating review pages");
assert.match(contentSource, /extractEtsyReviews[\s\S]*reviewPagination[\s\S]*lowStarCount/, "content script should expose visible Etsy review samples and low-star coverage");
assert.match(toolRegistrySource, /collect_etsy_competitor_shops[\s\S]*collect_etsy_shop_pages[\s\S]*keepTab:\s*false/, "tool registry should expose batch competitor shop collection that reuses the pagination collector and closes temporary tabs");
assert.match(toolRegistrySource, /etsyShopCrawlCache[\s\S]*cacheHit/, "Etsy shop collection should reuse in-session crawl evidence instead of reopening the same competitor shop");
assert.match(toolRegistrySource, /screenshotCaptured[\s\S]*screenshotRef[\s\S]*completedFullCrawl/, "Etsy shop collection loop should capture per-page screenshot evidence without returning raw base64 in checkpoints");
assert.match(toolRegistrySource, /currentSessionData\.products\.set/, "Etsy shop collection loop should accumulate visible product cards while reading pages");
assert.match(toolRegistrySource, /analyze_etsy_shop_crawl_screenshots[\s\S]*evidenceLedgerEntries/, "tool registry should expose independent visual analysis for cached Etsy shop crawl screenshots");
assert.match(toolRegistrySource, /stage_observations[\s\S]*stage_synthesis[\s\S]*stage_report_inputs/, "screenshot analysis should return staged observations, synthesis, and report-ready inputs");
assert.match(toolRegistrySource, /buildScreenshotSynthesis[\s\S]*buildScreenshotReportInputs/, "screenshot analysis should synthesize per-image observations before final report inputs");
assert.match(toolRegistrySource, /putDataUrlArtifact[\s\S]*artifactStore:\s*"indexeddb_blob_with_memory_fallback"/, "Etsy shop crawl screenshots should be stored as artifact refs instead of chrome.storage.local payloads");
assert.match(artifactStoreSource, /STORE_NAME\s*=\s*"artifacts"[\s\S]*indexedDB\.open[\s\S]*createObjectStore\(STORE_NAME[\s\S]*new Blob/, "large screenshot artifacts should use IndexedDB Blob storage");
assert.doesNotMatch(artifactStoreSource, /chrome\.storage\.local\.set/, "artifact store must not persist large screenshot blobs through chrome.storage.local");
assert.match(contentSource, /extractEtsySearchCards/, "content script should extract Etsy-specific listing cards");
assert.match(contentSource, /search\\\/shops[\s\S]*shopUrl/, "content script should extract Etsy shop search cards");
assert.match(contentSource, /visibleOrderRank/, "content script should expose visible product order rank for competitor storefront interpretation");
assert.match(contentSource, /sortLabel[\s\S]*hasNextPage[\s\S]*etsyShopProductContext/, "content script should expose Etsy shop sort and pagination context");
assert.match(contentSource, /pageHealth/, "content script should report page health for blocked or empty Etsy pages");
assert.match(js, /<html lang="zh-CN" dir="ltr">/, "PDF print template should declare Chinese language and stable text direction");
assert.match(js, /charset=UTF-8/, "PDF print template should force UTF-8 content type");
assert.match(js, /PingFang SC[\s\S]*Microsoft YaHei[\s\S]*Noto Sans CJK SC/, "PDF print template should include a Chinese font fallback stack");
assert.doesNotMatch(js, /const bodyHtml = marked\.parse\(rep\.content \|\| ""\);/, "report center PDF export should use sanitized shared markdown rendering");
assert.match(shopOptimizerSkillSource, /engine="etsy"[\s\S]*不允许作为最终交付/, "shop optimizer should require direct Etsy ranking/search evidence");
assert.match(shopOptimizerSkillSource, /google_uk[\s\S]*google_trends_au[\s\S]*不允许作为最终交付/, "shop optimizer should require direct free regional Google Search or Trends evidence");
assert.match(shopOptimizerSkillSource, /Etsy international shipping delivery time[\s\S]*禁止凭模型常识写“香港发货 7-12 工作日”/, "shop optimizer should require realtime logistics research before delivery-time claims");
assert.match(shopOptimizerSkillSource, /新店与垂直婚礼配饰店铺诊断专项规则/, "shop optimizer should include new-shop wedding accessory diagnosis rules");
assert.match(shopOptimizerSkillSource, /不能把“获取 5-10 个评价”写成孤立第一动作/, "shop optimizer should constrain review-building advice to compliant trust signals");
assert.match(backgroundSource, /etsy\\.com\\\/shop\\\//, "Etsy shop pages should route to the shop optimizer by default");
assert.match(agentLoopSource, /Etsy 站内搜索\/热卖榜\/高排名竞品店铺对标证据。该项不能降级为 assumption/, "critic should reject shop optimizer reports without real Etsy ranking evidence");
assert.match(agentLoopSource, /竞品店铺\/商品详情页截图视觉证据/, "critic should require competitor screenshot evidence for shop optimizer reports");
assert.match(agentLoopSource, /competitor_benchmarks/, "critic should require structured competitor benchmark data");
assert.match(agentLoopSource, /collect_etsy_shop_pages[\s\S]*completedFullCrawl/, "critic should recognize completed Etsy shop pagination crawl evidence for full-shop coverage claims");
assert.match(agentLoopSource, /validateKeywordReport/, "keyword analysis must have a dedicated runtime validator");
assert.match(agentLoopSource, /validateListingReport/, "listing generation must have a dedicated runtime validator");
assert.match(agentLoopSource, /validateProductOpportunityReport/, "product opportunity exploration must have a dedicated runtime validator");
assert.ok(
  validateReport({
    type: "final",
    output: {
      overview: "关键词分析",
      analysis: "输出高频搜索词。",
      summary: "建议使用高搜索词。",
      data: [{
        keyword: "personalized wedding clutch",
        estimated_volume: "高频",
        evidence_ledger: [{
          source_type: "assumption",
          source_ref: "待验证假设",
          observed_value: "未取得真实搜索量。",
          used_for: "占位说明。",
          confidence: "low",
          limitation: "待验证。",
        }],
      }],
    },
  }, "", "skills/etsy_keyword_analysis.skill.md").some((error) => /搜索量|高频|Google Trends|Google Search/.test(error)),
  "keyword reports must reject high-volume claims without real external evidence"
);
assert.ok(
  validateReport({
    type: "final",
    output: {
      overview: "Listing 生成",
      analysis: "儿童玩具 Listing 可直接发布。",
      summary: "直接上架。",
      data: [{
        title: "Personalized Kids Toy",
        recommendation: "可直接发布",
        evidence_ledger: [{
          source_type: "user_input",
          source_ref: "用户输入",
          observed_value: "用户提供儿童玩具方向。",
          used_for: "生成 Listing。",
          confidence: "medium",
          limitation: "未做合规审查。",
        }],
      }],
    },
  }, "", "skills/etsy_listing_generator.skill.md").some((error) => /敏感|合规|直接发布/.test(error)),
  "listing generator must block direct-publish language for sensitive categories without compliance evidence"
);
assert.ok(
  validateReport({
    type: "final",
    output: {
      overview: "机会探索",
      analysis: "该品类是蓝海爆品。",
      summary: "建议立即采购上架。",
      data: [{
        title: "Wedding clutch opportunity",
        opportunity_score: 92,
        recommendation: "立即采购并上架",
        evidence_ledger: [{
          source_type: "assumption",
          source_ref: "待验证假设",
          observed_value: "没有完成 Etsy/Google/Trends 搜索。",
          used_for: "占位。",
          confidence: "low",
          limitation: "待验证。",
        }],
      }],
    },
  }, "", "skills/etsy_product_opportunity_explorer.skill.md").some((error) => /蓝海|爆品|合规|采购|上架/.test(error)),
  "product opportunity reports must reject unsupported blue-ocean and purchase/listing recommendations"
);
assert.match(agentLoopSource, /collect_etsy_competitor_shops[\s\S]*competitorsCollected[\s\S]*cacheHits/, "agent loop should compress batch competitor crawl results before sending them back to the LLM");
assert.match(agentLoopSource, /collect_etsy_competitor_shops[\s\S]*internal_runaway_guard/, "agent loop should know batch competitor collection without reintroducing fixed max-loop failures");
assert.match(agentLoopSource, /skipImmediateLoopScreenshotTools[\s\S]*collect_etsy_shop_pages[\s\S]*collect_etsy_competitor_shops/, "bulk Etsy shop crawls should not attach redundant immediate screenshots to the next LLM planning call");
assert.match(agentLoopSource, /MAX_LLM_CRAWL_PRODUCT_CARDS\s*=\s*16/, "shop diagnosis compression should preserve enough visible product samples for competitor structure analysis");
assert.match(agentLoopSource, /productEvidenceSummary/, "shop diagnosis compression should preserve aggregate product evidence for pricing, reviews, promotions and titles");
assert.match(agentLoopSource, /analyze_etsy_shop_crawl_screenshots[\s\S]*独立截图解读/, "critic should require independent visual analysis after cached shop crawl screenshots are captured");
assert.match(agentLoopSource, /stage_observations[\s\S]*stage_synthesis[\s\S]*stage_report_inputs/, "agent loop compression should preserve staged screenshot analysis conclusions for the next reasoning step");
assert.match(agentLoopSource, /validateOperationsReport[\s\S]*baseline_window[\s\S]*attribution_confidence/, "operations reports should require baseline windows and attribution confidence");
assert.match(agentLoopSource, /isReviewSkill[\s\S]*sampleCount[\s\S]*主要反馈/, "review reports should not generalize from insufficient samples");
assert.match(js, /GROWTH_CONTRACT_VERSION/);
assert.match(js, /normalizeGrowthCaseRecord[\s\S]*runHistory[\s\S]*nextReviewAt[\s\S]*eventIds/, "growth cases should use a versioned stable contract");
assert.match(toolRegistrySource, /growthCaseId = ""[\s\S]*event\.growthCaseId/, "monitor change events should retain their growth case association");
assert.match(backgroundSource, /GET_ETSY_API_CONNECTION_STATUS/);
assert.match(shopOptimizerSkillSource, /collect_etsy_competitor_shops[\s\S]*减少重复开页和 LLM 往返/, "shop optimizer should prefer batch competitor shop collection when multiple competitor URLs are available");
assert.match(shopOptimizerSkillSource, /stage_observations[\s\S]*stage_synthesis[\s\S]*stage_report_inputs/, "shop optimizer should require staged screenshot conclusions to flow into final report fields");
assert.match(shopOptimizerSkillSource, /collect_etsy_shop_pages[\s\S]*边读 DOM 边累积商品卡片/, "shop optimizer should require browser pagination collection when competitor shop API data is unavailable");
assert.match(shopOptimizerSkillSource, /analyze_etsy_shop_crawl_screenshots[\s\S]*独立视觉解读/, "shop optimizer should require analysis of cached crawl screenshots after pagination collection");
assert.match(shopOptimizerSkillSource, /competitor_benchmarks[\s\S]*listing_order_insight/, "shop optimizer should require per-competitor product structure and visible order analysis");
assert.match(agentLoopSource, /Google Trends 截图视觉解读证据/, "critic should require Google Trends screenshot interpretation when trends are used");
assert.match(shopOptimizerSkillSource, /Google Trends 页面截图解读趋势图/, "shop optimizer should require screenshot-based Google Trends interpretation");
assert.match(agentLoopSource, /isGoogleTrendsGuardedWorkflow[\s\S]*isShopOptimizerOnly[\s\S]*getTrendQueryGuardError/, "shop optimizer should share Google Trends duplicate and exhaustion guards");
assert.doesNotMatch(remainingBusinessSkillSource, /俄文|俄语|озон|Ozon|CE\/CE|FDA\/IP\/FDA|欧美礼品市场市场|蓝海爆品/, "remaining Etsy skill prompts must not keep Ozon/RU leftovers or unsupported blue-ocean wording");
assert.doesNotMatch(operationsSkillSource, /Session View 提升|Conv to Cart 提升|加购率提升至少 X/, "operations tracker must not use personal-API-unsupported analytics as validated examples");
assert.match(operationsSkillSource, /当前个人卖家 API 不提供这些指标/, "operations tracker must state the personal Etsy API analytics boundary");
assert.match(productOpportunitySkillSource, /经证据验证的机会假设/, "opportunity skill should frame opportunities as evidence-backed hypotheses, not guaranteed blue-ocean winners");
assert.match(sourcingSkillSource, /英文\/目的地语言/, "sourcing skill should use Etsy destination-language packaging, not Ozon/RU packaging assumptions");
assert.doesNotMatch(js, /第三方海外仓备货可行性/, "dashboard opportunity cards should not push warehouse feasibility before maturity evidence");
assert.match(agentLoopSource, /涉及配送\/物流\/时效判断，但缺少实时物流主题 google_search 证据/, "critic should reject logistics claims without realtime logistics search evidence");
assert.match(agentLoopSource, /选品机会书\/选品机会分析/, "critic should reject shop optimizer reports that are framed as opportunity books");
assert.match(agentLoopSource, /stage_fit/, "critic should require shop optimizer plans to explain stage fit");
assert.match(agentLoopSource, /buyer_scenario/, "critic should require shop optimizer plans to name the buyer scenario");
assert.match(sidepanelSource, /isCheckpointFollowupInstruction[\s\S]*继续\|继续推进\|恢复\|resume\|continue[\s\S]*忽略\\s\*\(\?:api\|API\)/, "sidepanel should treat plain continue and API-ignore messages as session resume requests");
assert.match(agentLoopSource, /USER_REQUESTS_API_ASSUMPTION_DOWNGRADE_RE[\s\S]*用户已明确要求忽略\/跳过未配置的 Etsy API[\s\S]*source_type="assumption"/, "resumed workflows should tell the model to downgrade missing Etsy API evidence when the user asks to ignore API");
assert.match(sidepanelSource, /valueToReadableMarkdown[\s\S]*renderMarkdown\(valueToReadableMarkdown\(val\)\)/, "sidepanel report renderer should expand nested overview/analysis/summary objects instead of stringifying them");
assert.doesNotMatch(sidepanelSource, /renderMarkdown\(String\(val\)\)/, "sidepanel report renderer must not stringify nested report sections into [object Object]");
assert.match(js, /valueToReadableMarkdown[\s\S]*resultToReportMarkdown[\s\S]*深度商业诊断/, "dashboard report center should expand nested report objects into readable markdown sections");
assert.match(contentSource, /renderDepthMatrixMarkdown[\s\S]*店铺体检深度矩阵[\s\S]*renderCompetitorBenchmarksMarkdown[\s\S]*竞品店铺商品结构解析[\s\S]*renderEvidenceLedgerSummaryMarkdown[\s\S]*证据账本摘要/, "floating overlay final report should render depth matrix, competitor benchmarks, and evidence ledger summary");

const proseThenBareFinalJson = `The critic agent has identified several issues with my report.
Let me create a corrected report.{
  "type": "final",
  "output": {
    "overview": "Etsy 店铺优化诊断",
    "analysis": "已经完成页面、搜索与竞品对标分析。",
    "summary": "优先修复首图、标题和信任资产。",
    "data": []
  }
}`;
assert.equal(
  extractJSONBlock(proseThenBareFinalJson)?.type,
  "final",
  "parser should extract a bare final JSON object after critic prose instead of returning text"
);
const bareReportJson = `Critic notes...{
  "overview": "Etsy 店铺优化诊断",
  "analysis": "已完成页面文本、竞品和趋势证据整理。",
  "summary": "优先修复页面信任资产。",
  "data": []
}`;
const normalizedBareReport = normalizeFinalReportShapeForDelivery(extractJSONBlock(bareReportJson));
assert.equal(normalizedBareReport.parsed?.type, "final", "bare report JSON should be normalized into a final envelope");
assert.equal(normalizedBareReport.parsed?.output?.overview, "Etsy 店铺优化诊断", "bare report output fields should be preserved during final normalization");
const markdownShopHealthReport = `### 分析概述

本次诊断针对 Etsy 店铺 GrainFrameStudio，已完成 Etsy 搜索、Google Search US、Google Trends US 和 2 个竞品详情页取证。

### 深度商业诊断

核心发现：首图缺少英文卖点，SEO 标题缺少 street photography / travel photographer 场景词，物流时效需实时确认。

### 核心运营建议

第一优先级 B-1 首图与画廊英文视觉卖点改版；第二优先级 B-2 SEO 标题重构与 attributes 填充。

### 结构化行动项

#### 1. 首图与画廊英文视觉卖点改版
- 为 Ricoh GR IV、Panasonic LUMIX S9 主推款首图添加英文卖点文案
- 增加尺寸参照图和材质微距图`;
const parsedMarkdownShopHealthReport = extractJSONBlock(markdownShopHealthReport);
assert.equal(parsedMarkdownShopHealthReport?.type, "final", "markdown shop health reports should be recovered into the final protocol envelope");
assert.match(parsedMarkdownShopHealthReport.output.overview, /GrainFrameStudio/, "markdown fallback should preserve the overview section");
assert.match(parsedMarkdownShopHealthReport.output.analysis, /首图缺少英文卖点/, "markdown fallback should preserve the diagnosis section");
assert.ok(Array.isArray(parsedMarkdownShopHealthReport.output.data), "markdown fallback should create a data array for later skeleton repair");
assert.equal(
  parsedMarkdownShopHealthReport.output.data[0].evidence_ledger[0].source_type,
  "assumption",
  "markdown fallback should mark the format recovery ledger as an assumption, not external evidence"
);

const jargonReport = {
  type: "final",
  output: {
    overview: "已通过 DOM 和 read_current_page 完成 Etsy 商品页审计，目标定位为欧美礼品市场。",
    analysis: "需要继续使用 xpath 线索和 open_new_tab 进入候选详情页。",
    summary: "agentic_web_search 已补充店铺资料，但不能把内部流程写给卖家。",
    data: [
      {
        evidence: "click_by_selector 后确认候选页面存在平台访问限制，当前结论仅用于说明页面访问状态，不作为已验证销售判断。",
        source_ref: "read_current_page#1",
        evidence_ledger: [
          {
            source_type: "assumption",
            source_ref: "read_current_page#1",
            observed_value: "DOM、xpath 与 open_new_tab 等内部术语需要在交付前转为业务语言。",
            used_for: "验证最终报告交付前的语言净化不会触发不必要重做。",
            confidence: "medium",
            limitation: "这是 smoke 测试样例，不声明真实 Etsy 页面或 API 证据。",
          },
        ],
      },
    ],
  },
};
const sanitizedJargonReport = sanitizeFinalReportForDelivery(jargonReport);
assert.equal(sanitizedJargonReport.changed, true, "final reports with internal jargon should be sanitized before validation");
assert.doesNotMatch(
  [
    sanitizedJargonReport.parsed.output.overview,
    sanitizedJargonReport.parsed.output.analysis,
    sanitizedJargonReport.parsed.output.summary,
    sanitizedJargonReport.parsed.output.data[0].evidence,
  ].join("\n"),
  /read_current_page|open_new_tab|click_by_selector|agentic_web_search|DOM|xpath/i,
  "sanitized report body should not expose internal tool or parser terms"
);
assert.equal(sanitizedJargonReport.parsed.output.data[0].source_ref, "read_current_page#1", "technical source refs should remain stable for evidence tracing");
assert.deepEqual(validateReport(sanitizedJargonReport.parsed, "", "skills/etsy_product_opportunity_explorer.skill.md"), [], "sanitized final report should pass report validation without critic redo");

const apiAssumptionReport = {
  type: "final",
  output: {
    overview: "Etsy 商品机会报告，目标销售市场为欧美礼品市场，目标客群为美国/欧洲节日礼品与个性化定制买家。",
    analysis: "面向欧美礼品市场买家，在未绑定 Etsy API 的情况下，订单、流量与履约判断必须降级为待验证假设。",
    summary: "先用页面和搜索证据做运营假设，授权后再用 API 复核。",
    data: [
      {
        title: "API 数据复核与履约节奏假设",
        evidence: "当前页面文本和搜索证据只能支持方向性判断，不能证明真实订单、Sessions 或履约成本。",
        evidence_ledger: [
          {
            source_type: "page_dom",
            source_ref: "当前 Etsy 页面",
            observed_value: "页面可见商品标题和基础定位信息。",
            used_for: "判断基础 Listing 优化方向。",
            confidence: "medium",
            limitation: "页面文本不能替代 Etsy API 的 Sessions、订单或转化数据。",
          },
        ],
        recommendation: "待授权 Etsy API 后复核 Sessions、订单、履约成本和转化。",
      },
    ],
  },
};
const basicEtsyPageContext = {
  url: "https://www.etsy.com/listing/mock",
  title: "Mock Etsy Listing",
  visibleText: "Mock Etsy listing with meaningful title description category materials and seller details for page evidence.",
  pageHealth: { hasMeaningfulDom: true, isLikelyBlocked: false },
};
const repairedApiAssumptionReport = autoRepairFinalReportForDelivery(apiAssumptionReport, {
  skillId: "skills/etsy_product_opportunity_explorer.skill.md",
  toolHistory: [],
  pageContext: basicEtsyPageContext,
});
assert.equal(repairedApiAssumptionReport.changed, true, "API/order claims without API evidence should be downgraded automatically");

const invalidEtsySearchResult = {
  ok: true,
  searchUrl: "https://www.etsy.com/search?q=wedding%20clutch",
  pageData: {
    url: "https://www.etsy.com/search?q=wedding%20clutch",
    title: "etsy.com",
    visibleText: "",
    productCards: [],
    productLinks: [],
    pageHealth: {
      platform: "etsy",
      pageType: "etsy_search",
      visibleTextLength: 0,
      productEvidenceCount: 0,
      hasMeaningfulDom: false,
      isLikelyBlocked: true,
      blockSignals: ["etsy_empty_shell"],
    },
  },
};
const validEtsySearchResult = {
  ok: true,
  searchUrl: "https://www.etsy.com/search?q=wedding%20clutch",
  pageData: {
    url: "https://www.etsy.com/search?q=wedding%20clutch",
    title: "Wedding clutch - Etsy",
    visibleText: "Wedding clutch results Bestseller FREE shipping $42.00 124 reviews Star Seller",
    productCards: [{
      href: "https://www.etsy.com/listing/123456789/personalized-wedding-clutch",
      listingUrl: "https://www.etsy.com/listing/123456789/personalized-wedding-clutch",
      title: "Personalized Wedding Clutch",
      shopName: "TopBridalStudio",
      price: "$42.00",
      imageSrc: "https://i.etsystatic.com/mock.jpg",
      reviewCount: "124 reviews",
    }],
    productLinks: [{ href: "https://www.etsy.com/listing/123456789/personalized-wedding-clutch", text: "Personalized Wedding Clutch" }],
    pageHealth: {
      platform: "etsy",
      pageType: "etsy_search",
      visibleTextLength: 84,
      productEvidenceCount: 2,
      hasMeaningfulDom: true,
      isLikelyBlocked: false,
      blockSignals: [],
    },
  },
};
assert.equal(hasValidEtsySearchEvidence(invalidEtsySearchResult), false, "empty or blocked Etsy pages should not count as valid search evidence");
assert.equal(hasValidEtsySearchEvidence(validEtsySearchResult), true, "Etsy listing cards should count as valid search evidence");
const hugeCrawlResult = {
  ok: true,
  tool: "collect_etsy_shop_pages",
  sourceUrl: "https://www.etsy.com/shop/HugeShop",
  pagesCollected: 6,
  completedFullCrawl: false,
  totalVisibleProductCards: 360,
  uniqueListingCount: 360,
  artifactStore: "indexeddb_blob_with_memory_fallback",
  pages: Array.from({ length: 6 }, (_, pageIdx) => ({
    pageIndex: pageIdx + 1,
    url: `https://www.etsy.com/shop/HugeShop?page=${pageIdx + 1}`,
    title: "HugeShop",
    sortLabel: "Most Recent",
    productCardsVisible: 60,
    visibleTextSnippet: "wedding clutch ".repeat(500),
    screenshotCaptured: true,
    screenshotRef: `artifact://etsy-shop-crawl-screenshot/mock-${pageIdx}`,
    productCards: Array.from({ length: 60 }, (_, cardIdx) => ({
      visibleOrderRank: cardIdx + 1,
      title: `Personalized wedding clutch ${cardIdx} ${"bridal ".repeat(20)}`,
      price: "$42.00",
      href: `https://www.etsy.com/listing/${pageIdx}${cardIdx}`,
      imageSrc: `https://i.etsystatic.com/mock-${pageIdx}-${cardIdx}.jpg`,
      shippingText: "Free shipping ".repeat(20),
      promotionText: "Sale ".repeat(20),
    })),
  })),
};
const compactHugeCrawlResult = __testInternals.compactToolResultForLLM("collect_etsy_shop_pages", hugeCrawlResult);
assert.equal(compactHugeCrawlResult.totalVisibleProductCards, 360, "compressed crawl result should preserve aggregate product counts");
assert.equal(compactHugeCrawlResult.pages.length, 6, "compressed crawl result should keep enough pages for shop diagnosis breadth");
assert.equal(compactHugeCrawlResult.pages[0].productCards.length, 16, "compressed crawl result should keep enough product samples per page for price/category analysis");
assert.equal(compactHugeCrawlResult.productEvidenceSummary.productSamples.length, 24, "compressed crawl result should keep a cross-page product evidence summary");
assert.ok(compactHugeCrawlResult.productEvidenceSummary.priceSamples.includes("$42.00"), "compressed crawl result should preserve price samples");
assert.ok(
  JSON.stringify(compactHugeCrawlResult).length < JSON.stringify(hugeCrawlResult).length / 2,
  "compressed crawl result should be much smaller than raw crawl evidence"
);
const hugeBatchCrawlResult = {
  ok: true,
  tool: "collect_etsy_competitor_shops",
  competitorsRequested: 3,
  competitorsCollected: 3,
  cacheHits: 1,
  pagesCollected: 6,
  screenshotRefs: hugeCrawlResult.pages.map((page) => page.screenshotRef),
  allPages: hugeCrawlResult.pages,
  artifactStore: "indexeddb_blob_with_memory_fallback",
  screenshotPolicy: "Per-page screenshots are stored as referenced artifacts.",
  nextStep: "Pass allPages to analyze_etsy_shop_crawl_screenshots.",
  shops: [0, 1, 2].map((shopIdx) => ({
    ok: true,
    competitorName: `Competitor ${shopIdx + 1}`,
    url: `https://www.etsy.com/shop/Competitor${shopIdx + 1}`,
    cacheHit: shopIdx === 0,
    pagesCollected: 2,
    completedFullCrawl: false,
    stoppedReason: "max_pages_reached",
    totalVisibleProductCards: 120,
    uniqueListingCount: 120,
    sortLabels: ["Most Recent"],
    pages: hugeCrawlResult.pages.slice(shopIdx * 2, shopIdx * 2 + 2),
  })),
};
const compactHugeBatchCrawlResult = __testInternals.compactToolResultForLLM("collect_etsy_competitor_shops", hugeBatchCrawlResult);
assert.equal(compactHugeBatchCrawlResult.competitorsCollected, 3, "compressed batch crawl result should preserve competitor counts");
assert.equal(compactHugeBatchCrawlResult.cacheHits, 1, "compressed batch crawl result should preserve cache-hit counts");
assert.equal(compactHugeBatchCrawlResult.shops[0].pages[0].productCards.length, 16, "compressed batch crawl result should preserve enough product samples per page");
assert.ok(compactHugeBatchCrawlResult.shops[0].productEvidenceSummary.productSamples.length > 0, "compressed batch crawl result should preserve per-shop product evidence summaries");
assert.ok(compactHugeBatchCrawlResult.allPages[0].productCards.length > 0, "compressed batch crawl allPages should retain product samples for screenshot-analysis handoff");
assert.ok(
  JSON.stringify(compactHugeBatchCrawlResult).length < JSON.stringify(hugeBatchCrawlResult).length / 2,
  "compressed batch crawl result should be much smaller than raw batch crawl evidence"
);
assert.equal(hasValidEtsySearchEvidence({
  ok: true,
  searchUrl: "https://www.etsy.com/search/shops?search_query=wedding%20clutch",
  pageData: {
    url: "https://www.etsy.com/search/shops?search_query=wedding%20clutch",
    title: "Wedding clutch shops - Etsy",
    visibleText: "Etsy shops results Star Seller 1,245 reviews handmade bridal clutch",
    productCards: [{
      href: "https://www.etsy.com/shop/TopBridalStudio",
      shopUrl: "https://www.etsy.com/shop/TopBridalStudio",
      shopName: "TopBridalStudio",
      text: "Star Seller 1,245 reviews handmade bridal clutch",
    }],
    productLinks: [],
    pageHealth: {
      platform: "etsy",
      pageType: "etsy_search",
      visibleTextLength: 67,
      productEvidenceCount: 1,
      hasMeaningfulDom: true,
      isLikelyBlocked: false,
      blockSignals: [],
    },
  },
}), true, "Etsy shop cards should count as valid search evidence");
assert.equal(hasValidGoogleTrendsEvidence({
  ok: true,
  searchUrl: "https://trends.google.com/trends/explore?date=today%2012-m&geo=US&q=wedding%20clutch",
  pageData: {
    url: "https://trends.google.com/trends/explore?date=today%2012-m&geo=US&q=wedding%20clutch",
    title: "Google Trends",
    visibleText: "Google Trends Explore Interest over time Related queries wedding clutch bridal purse",
    pageHealth: { isLikelyBlocked: false },
  },
}), true, "readable Google Trends pages should count as trend evidence");
assert.equal(hasValidGoogleTrendsEvidence({
  ok: true,
  searchUrl: "https://trends.google.com/trends/explore?date=today%2012-m&geo=US&q=wedding%20clutch",
  pageData: {
    url: "https://trends.google.com/trends/explore?date=today%2012-m&geo=US&q=wedding%20clutch",
    title: "Google Trends",
    visibleText: "",
    pageHealth: { isLikelyBlocked: true },
  },
}), false, "blocked or empty Google Trends pages should not count as trend evidence");

const shopOptimizerReportWithEtsyEvidence = {
  type: "final",
  output: {
    overview: "## Etsy 店铺优化诊断\n目标市场为Etsy 主要欧美礼品市场，当前为 B 级低评价成长店，需要补齐信任资产。",
    analysis: "已读取当前店铺页面文本和截图，并对标同类高排名竞品店铺。竞品店铺商品结构解析：TopBridalStudio 可见 12+ SKU，主价格带 $49-$89；BellaOliviaGifts 可见 16+ SKU，主价格带 $24.99-$79.98。Google Search US 已验证 wedding clutch 站外表达。",
    summary: "优先执行 B-1 婚礼场景首图与标题改版，7 天后复盘点击和加购。",
    diagnostic_depth_matrix: [
      { dimension: "店铺定位与经营阶段", finding: "低评价成长店，主营婚礼手拿包与伴娘礼品", evidence: "当前店铺页文本与 Etsy 店铺上下文", gap: "信任资产与垂直定位仍需强化", action: "先补 About、政策、FAQ 和婚礼场景定位" },
      { dimension: "视觉首图与画廊", finding: "当前视觉统一但缺少尺寸、包装和婚礼场景信号", evidence: "当前店铺截图与竞品截图", gap: "首图点击理由不足", action: "重做首图、模特手持图和包装/尺寸图" },
      { dimension: "SEO 标题与 Attributes", finding: "需围绕 wedding clutch / bridesmaid gift clutch 重构标题前 60 字", evidence: "Etsy 搜索与 Google Search US", gap: "关键词结构和属性填写需要复核", action: "重写标题并补齐 Color、Material、Occasion 等 attributes" },
      { dimension: "商品矩阵与价格带", finding: "竞品主价格带集中在 $24.99-$89，并有高价定制款", evidence: "competitor_benchmarks 的 product_samples 和 price_distribution", gap: "当前店铺需要区分引流款、主推款和利润款", action: "建立引流款/定制主推款/利润款矩阵" },
      { dimension: "竞品对标与可见排序", finding: "TopBridalStudio 和 BellaOliviaGifts 均把个性化婚礼场景款前置", evidence: "collect_etsy_shop_pages 截图和页面文本", gap: "当前陈列顺序缺少明确场景层级", action: "按 bride/bridesmaid/wedding guest 场景重排第一屏" },
      { dimension: "Google/Trends 站外需求", finding: "Google Trends 页面可读，related queries 与 bridal / bridesmaid 场景相关", evidence: "Google Search US 与 Google Trends US", gap: "趋势曲线只能作为可见图表方向，需后续导出复核", action: "围绕婚礼季窗口安排标题和首图实验" },
      { dimension: "信任资产、评价与履约", finding: "低评价阶段不适合立即广告放量，优先补政策、FAQ、发货说明", evidence: "当前店铺阶段、竞品评价门槛和政策信号", gap: "物流时效和承运商需实时确认", action: "完善 Shipping Profile，实时确认目的地时效后再更新描述" },
    ],
    data: [{
      plan_id: "B-1",
      title: "婚礼场景首图与标题改版",
      diagnosis_level: "B",
      direction: "围绕 bride、bridesmaid 与 wedding guest 场景重做首图和标题。",
      evidence: "当前店铺页面、截图、Etsy 搜索和 Google Search US 均支持先做信任资产改版。",
      stage_fit: "低评价成长店应先补齐信任资产，不建议立即广告放量。",
      buyer_scenario: "bride / bridesmaid / wedding guest",
      evidence_ledger: [
        { source_type: "page_dom", source_ref: "当前店铺页", observed_value: "店铺主营婚礼手拿包与伴娘礼品", used_for: "判断店铺定位", confidence: "high", limitation: "仅代表当前页面可见文本" },
        { source_type: "screenshot_visual", source_ref: "当前店铺截图", observed_value: "首屏商品视觉统一但缺少尺寸/包装信任信息", used_for: "判断视觉整改", confidence: "medium", limitation: "截图不能替代完整详情页" },
        { source_type: "screenshot_visual", source_ref: "竞品店铺截图: https://www.etsy.com/shop/TopBridalStudio", observed_value: "竞品首屏使用婚礼场景图、模特手持图和英文 Personalized 卖点，画廊含包装与尺寸说明。", used_for: "对标高排名竞品的视觉调性、首图卖点和画廊结构", confidence: "medium", limitation: "截图只能判断可见首屏和画廊露出，不能代表全部商品详情" },
        { source_type: "screenshot_visual", source_ref: "竞品店铺截图: https://www.etsy.com/shop/BellaOliviaGifts", observed_value: "竞品首屏多 SKU 陈列，促销标签和 photo clutch 场景词靠前，画廊强调个性化照片与母亲礼品场景。", used_for: "对标第二个高排名竞品的 SKU 陈列、促销信号和场景分层", confidence: "medium", limitation: "截图只能判断可见排序和首屏商品结构，不能直接推断真实销量或上架时间" },
        { source_type: "etsy_search", source_ref: "Etsy search: wedding clutch", observed_value: "高排名竞品店铺使用婚礼场景图、评价背书和 free shipping 标签", used_for: "对标竞品店铺方法", confidence: "medium", limitation: "搜索结果第一页样本" },
        { source_type: "google_search", source_ref: "Google Search US: wedding clutch", observed_value: "站外表达以 wedding clutch、bridesmaid gift clutch 为主", used_for: "验证标题词方向", confidence: "medium", limitation: "需要 Google Trends 二次确认季节性" },
        { source_type: "google_trends", source_ref: "Google Trends US: wedding clutch", observed_value: "近 12 个月趋势页可读，显示 Interest over time 和 related queries 模块。", used_for: "验证欧美礼品市场季节性需求方向", confidence: "medium", limitation: "不能读取精确 YoY/QoQ 数字，只能基于图表方向做运营判断" },
        { source_type: "screenshot_visual", source_ref: "Google Trends 截图: https://trends.google.com/trends/explore?date=today%2012-m&geo=US&q=wedding%20clutch", observed_value: "Trends 图表显示 wedding clutch 需求曲线存在婚礼季波峰，related queries 与 bridal / bridesmaid 场景相关。", used_for: "截图解读趋势图的季节性窗口和需求表达", confidence: "medium", limitation: "截图只能判断可见曲线方向和相关词，不能替代导出数据" },
      ],
      expected_impact: "提升点击率和加购信任。",
      first_actions: ["重做首图", "重写标题前 60 字", "补包装和尺寸图"],
      manual_confirmations: ["确认新首图已发布"],
      review_window: "7 天",
      risk_guard: "不得伪造评价或趋势数据。",
    }],
    competitor_benchmarks: [
      {
        competitor_name: "TopBridalStudio",
        competitor_url: "https://www.etsy.com/shop/TopBridalStudio",
        page_type: "shop",
        sampled_products_count: 3,
        visible_sku_count_estimate: "12+ visible products in first shop grid under Sort: Most Recent",
        category_mix: ["bridal clutch", "bridesmaid gift", "evening bag"],
        product_samples: [
          { title: "Personalized Bridal Clutch", price: "$42.00", category_or_scenario: "bride gift", promotion_signal: "free shipping", visible_order_rank: 1 },
          { title: "Pearl Wedding Purse", price: "$68.00", category_or_scenario: "wedding guest bag", promotion_signal: "star seller", visible_order_rank: 2 },
          { title: "Custom Bridesmaid Clutch", price: "$88.00", category_or_scenario: "bridesmaid gift", promotion_signal: "sale", visible_order_rank: 3 },
        ],
        price_distribution: { min: "$42.00", max: "$185.00", main_band: "$49-$89", premium_band: "$140+" },
        promotion_signals: ["free shipping", "star seller", "sale"],
        shop_review_signal: { rating: "4.9", review_count: "174 reviews", scope: "visible shop/search signal" },
        listing_order_insight: {
          visible_sort_order: "Personalized bridal clutch and pearl wedding purse appear first in the visible shop grid.",
          observed_order_basis: "Sort: Most Recent; only visible storefront order and search card rank were observed.",
          interpretation_limit: "Visible order may reflect shop merchandising or Etsy sorting; it cannot prove true upload time, sales rank, or complete SKU order.",
        },
        visual_method: "Model hand-held wedding scene, personalized text overlay, packaging image.",
        seo_method: "Personalized Bridal Clutch + Bride Name + Wedding Purse.",
        fulfillment_signal: "Free shipping label visible; exact carrier not confirmed.",
        evidence_refs: ["etsy_search:wedding clutch", "page_dom:TopBridalStudio", "screenshot_visual:TopBridalStudio"],
      },
      {
        competitor_name: "BellaOliviaGifts",
        competitor_url: "https://www.etsy.com/shop/BellaOliviaGifts",
        page_type: "shop",
        sampled_products_count: 3,
        visible_sku_count_estimate: "16+ visible products in first shop grid under Sort: Most Recent",
        category_mix: ["photo clutch", "mother of bride gift", "wedding party gift"],
        product_samples: [
          { title: "Personalized Photo Clutch", price: "$24.99", category_or_scenario: "photo gift", promotion_signal: "sale", visible_order_rank: 1 },
          { title: "Mother of Groom Clutch", price: "$39.99", category_or_scenario: "mother gift", promotion_signal: "free shipping", visible_order_rank: 2 },
          { title: "Custom Wedding Clutch", price: "$79.98", category_or_scenario: "wedding party gift", promotion_signal: "coupon", visible_order_rank: 3 },
        ],
        price_distribution: { min: "$24.99", max: "$79.98", main_band: "$24.99-$49.99", premium_band: "$79.98" },
        promotion_signals: ["sale", "free shipping", "coupon"],
        shop_review_signal: { rating: "4.8", review_count: "245 reviews", scope: "visible shop/search signal" },
        listing_order_insight: {
          visible_sort_order: "Photo clutch and mother-of-bride gift products appear before generic wedding clutch products.",
          observed_order_basis: "Sort: Most Recent; only the visible shop grid order was observed after opening the competitor page.",
          interpretation_limit: "Visible order is a merchandising signal only; it cannot prove exact listing publish order or sales velocity.",
        },
        visual_method: "Multi-SKU gift grid with promo labels and personalized photo examples.",
        seo_method: "Personalized Wedding Clutch + Photo + Mother of Groom + Wedding Party Gifts.",
        fulfillment_signal: "Free delivery label visible; transit time needs separate verification.",
        evidence_refs: ["etsy_search:wedding clutch", "page_dom:BellaOliviaGifts", "screenshot_visual:BellaOliviaGifts"],
      },
    ],
  },
};
const meaningfulPageContext = {
  url: "https://www.etsy.com/shop/MidnightReveriee",
  title: "MidnightReveriee - Etsy",
  visibleText: "MidnightReveriee wedding clutch bridesmaid gifts",
  screenshot: "data:image/jpeg;base64,mock",
  pageHealth: { hasMeaningfulDom: true, isLikelyBlocked: false },
  etsyShopProductContext: {
    sortLabel: "Most Recent",
    visibleProductOrderBasis: "Visible shop grid order under sort control: Most Recent",
    pagination: { hasPagination: true, hasNextPage: true, nextPageUrl: "https://www.etsy.com/shop/MidnightReveriee?page=2" },
  },
};
const googleSearchHistory = {
  tool: "search_in_browser",
  arguments: { engine: "google_us", query: "wedding clutch" },
  result: {
    ok: true,
    evidenceOk: true,
    searchUrl: "https://www.google.com/search?q=wedding+clutch",
    screenshotRef: "__GOOGLE_SEARCH_SCREENSHOT_mock__",
    screenshotCaptured: true,
    pageData: {
      url: "https://www.google.com/search?q=wedding+clutch",
      title: "wedding clutch - Google Search",
      visibleText: "wedding clutch bridal clutch bridesmaid gift clutch evening bag personalized wedding purse Etsy Pinterest Vogue wedding guest accessories bridal shower gift search results and market wording examples",
      pageHealth: { isLikelyBlocked: false },
    },
  },
};
const googleTrendsHistory = {
  tool: "search_in_browser",
  arguments: { engine: "google_trends", query: "wedding clutch" },
  result: {
    ok: true,
    evidenceOk: true,
    screenshotRef: "__GOOGLE_TRENDS_SCREENSHOT_mock__",
    screenshotCaptured: true,
    pageData: {
      url: "https://trends.google.com/trends/explore?date=today%2012-m&geo=US&q=wedding%20clutch",
      title: "Google Trends",
      visibleText: "Google Trends Explore Interest over time Related queries wedding clutch bridal purse",
      pageHealth: { isLikelyBlocked: false },
    },
  },
};
const competitorOpenHistory = {
  tool: "open_new_tab",
  arguments: { url: "https://www.etsy.com/shop/TopBridalStudio" },
  result: { ok: true, tabId: 9, screenshotRef: "__OPEN_TAB_SCREENSHOT_TOP__", pageData: { url: "https://www.etsy.com/shop/TopBridalStudio", visibleText: "TopBridalStudio wedding clutch personalized bridal bags" } },
};
const competitorOpenHistory2 = {
  tool: "open_new_tab",
  arguments: { url: "https://www.etsy.com/shop/BellaOliviaGifts" },
  result: { ok: true, tabId: 10, screenshotRef: "__OPEN_TAB_SCREENSHOT_BELLA__", pageData: { url: "https://www.etsy.com/shop/BellaOliviaGifts", visibleText: "BellaOliviaGifts personalized photo clutch wedding party gifts" } },
};
const competitorCrawlHistory = {
  tool: "collect_etsy_shop_pages",
  arguments: { url: "https://www.etsy.com/shop/TopBridalStudio", maxPages: 2 },
  result: {
    ok: true,
    sourceUrl: "https://www.etsy.com/shop/TopBridalStudio",
    pagesCollected: 2,
    completedFullCrawl: false,
    stoppedReason: "max_pages_reached",
    totalVisibleProductCards: 48,
    uniqueListingCount: 48,
    pages: [
      {
        pageIndex: 1,
        url: "https://www.etsy.com/shop/TopBridalStudio",
        sortLabel: "Most Recent",
        productCardsVisible: 24,
        screenshotCaptured: true,
        screenshotRef: "__ETSY_SHOP_CRAWL_SCREENSHOT_mock_1__",
        pagination: { hasPagination: true, hasNextPage: true, nextPageUrl: "https://www.etsy.com/shop/TopBridalStudio?page=2" },
      },
      {
        pageIndex: 2,
        url: "https://www.etsy.com/shop/TopBridalStudio?page=2",
        sortLabel: "Most Recent",
        productCardsVisible: 24,
        screenshotCaptured: true,
        screenshotRef: "__ETSY_SHOP_CRAWL_SCREENSHOT_mock_2__",
        pagination: { hasPagination: true, hasNextPage: true, nextPageUrl: "https://www.etsy.com/shop/TopBridalStudio?page=3" },
      },
    ],
  },
};
const batchCompetitorCrawlHistory = {
  tool: "collect_etsy_competitor_shops",
  arguments: {
    urls: [
      "https://www.etsy.com/shop/TopBridalStudio",
      "https://www.etsy.com/shop/BellaOliviaGifts",
    ],
    maxPagesPerShop: 2,
  },
  result: {
    ok: true,
    tool: "collect_etsy_competitor_shops",
    competitorsRequested: 2,
    competitorsCollected: 2,
    cacheHits: 0,
    pagesCollected: 2,
    screenshotRefs: [
      "__ETSY_SHOP_CRAWL_SCREENSHOT_mock_1__",
      "__ETSY_SHOP_CRAWL_SCREENSHOT_mock_2__",
    ],
    allPages: [
      {
        pageIndex: 1,
        url: "https://www.etsy.com/shop/TopBridalStudio",
        competitorUrl: "https://www.etsy.com/shop/TopBridalStudio",
        competitorName: "TopBridalStudio",
        sortLabel: "Most Recent",
        productCardsVisible: 24,
        screenshotCaptured: true,
        screenshotRef: "__ETSY_SHOP_CRAWL_SCREENSHOT_mock_1__",
        pagination: { hasPagination: true, hasNextPage: true, nextPageUrl: "https://www.etsy.com/shop/TopBridalStudio?page=2" },
      },
      {
        pageIndex: 1,
        url: "https://www.etsy.com/shop/BellaOliviaGifts",
        competitorUrl: "https://www.etsy.com/shop/BellaOliviaGifts",
        competitorName: "BellaOliviaGifts",
        sortLabel: "Recommended",
        productCardsVisible: 18,
        screenshotCaptured: true,
        screenshotRef: "__ETSY_SHOP_CRAWL_SCREENSHOT_mock_2__",
        pagination: { hasPagination: true, hasNextPage: false, nextPageUrl: "" },
      },
    ],
    shops: [
      {
        ok: true,
        competitorName: "TopBridalStudio",
        url: "https://www.etsy.com/shop/TopBridalStudio",
        pagesCollected: 1,
        totalVisibleProductCards: 24,
        uniqueListingCount: 24,
        pages: [],
        listingDetails: [{ ok: true, listingUrl: "https://www.etsy.com/listing/101/top-bridal-clutch", screenshotRef: "__DETAIL_SCREENSHOT_TOP__" }],
      },
      {
        ok: true,
        competitorName: "BellaOliviaGifts",
        url: "https://www.etsy.com/shop/BellaOliviaGifts",
        pagesCollected: 1,
        totalVisibleProductCards: 18,
        uniqueListingCount: 18,
        pages: [],
        listingDetails: [{ ok: true, listingUrl: "https://www.etsy.com/listing/102/bella-photo-clutch", screenshotRef: "__DETAIL_SCREENSHOT_BELLA__" }],
      },
    ],
  },
};
const competitorScreenshotAnalysisHistory = {
  tool: "analyze_etsy_shop_crawl_screenshots",
  arguments: {
    competitorName: "TopBridalStudio",
    pages: competitorCrawlHistory.result.pages,
  },
  result: {
    ok: true,
    analysisWorkflow: "staged_screenshot_observation_to_synthesis_to_report_inputs",
    competitorName: "TopBridalStudio",
    screenshotsRequested: 2,
    screenshotsAnalyzed: 2,
    stage_observations: [
      {
        stage: "screenshot_observation",
        competitorName: "TopBridalStudio",
        pageIndex: 1,
        url: "https://www.etsy.com/shop/TopBridalStudio",
        screenshotRef: "__ETSY_SHOP_CRAWL_SCREENSHOT_mock_1__",
        ok: true,
        visual_tone: "bridal soft luxury",
        hero_or_first_grid_signals: ["model hand-held wedding scene"],
        product_image_patterns: ["personalized clutch closeups"],
        promotion_or_trust_signals: ["free shipping", "star seller"],
        layout_and_merchandising: "personalized bridal clutches appear first",
        report_observation: "竞品首屏以婚礼手持场景和个性化礼品文字强化新娘/伴娘购买场景。",
      },
    ],
    stage_synthesis: [
      {
        competitorName: "TopBridalStudio",
        pagesAnalyzed: 2,
        urls: ["https://www.etsy.com/shop/TopBridalStudio"],
        visual_tone_summary: "bridal soft luxury",
        hero_signal_summary: ["model hand-held wedding scene"],
        product_image_pattern_summary: ["personalized clutch closeups"],
        promotion_or_trust_signal_summary: ["free shipping", "star seller"],
        merchandising_summary: ["personalized bridal clutches appear first"],
        limitation_summary: "截图只能判断可见陈列，不能证明真实销量。",
        productSamples: [{ title: "Personalized Bridal Clutch", price: "$42.00", rank: 1 }],
      },
    ],
    stage_report_inputs: {
      evidenceLedgerEntries: [
        {
          source_type: "screenshot_visual",
          source_ref: "竞品店铺分页截图: https://www.etsy.com/shop/TopBridalStudio",
          observed_value: "竞品首屏以婚礼手持场景和个性化礼品文字强化新娘/伴娘购买场景。",
          used_for: "对标竞品店铺视觉调性、首图/网格陈列、促销/信任信号和可见排序方法",
          confidence: "medium",
          limitation: "截图只能判断当前页可见视觉和陈列，不能证明真实销量、完整库存、真实上架时间或全店完整 SKU。",
        },
      ],
      competitorBenchmarkDrafts: [{ competitor_name: "TopBridalStudio", visual_method: "bridal soft luxury" }],
      diagnosticDepthHints: [{ dimension: "视觉首图与画廊", finding: "bridal soft luxury", evidence: "stage_observations", gap: "当前店铺需补视觉信任信号", action: "补模特手持和包装图" }],
      nextStepInstruction: "沿用阶段结论补齐 final.output 字段。",
    },
    analyses: [
      {
        pageIndex: 1,
        url: "https://www.etsy.com/shop/TopBridalStudio",
        screenshotRef: "__ETSY_SHOP_CRAWL_SCREENSHOT_mock_1__",
        ok: true,
        visual_tone: "bridal soft luxury",
        report_observation: "竞品首屏以婚礼手持场景和个性化礼品文字强化新娘/伴娘购买场景。",
      },
      {
        pageIndex: 2,
        url: "https://www.etsy.com/shop/TopBridalStudio?page=2",
        screenshotRef: "__ETSY_SHOP_CRAWL_SCREENSHOT_mock_2__",
        ok: true,
        visual_tone: "giftable bridal accessories",
        report_observation: "第二页继续使用统一婚礼色调、包装和礼品化陈列，促销与信任信号靠近商品网格。",
      },
    ],
    evidenceLedgerEntries: [
      {
        source_type: "screenshot_visual",
        source_ref: "竞品店铺分页截图: https://www.etsy.com/shop/TopBridalStudio",
        observed_value: "竞品首屏以婚礼手持场景和个性化礼品文字强化新娘/伴娘购买场景。",
        used_for: "对标竞品店铺视觉调性、首图/网格陈列、促销/信任信号和可见排序方法",
        confidence: "medium",
        limitation: "截图只能判断当前页可见视觉和陈列，不能证明真实销量、完整库存、真实上架时间或全店完整 SKU。",
      },
    ],
  },
};
const compactStagedScreenshotAnalysis = __testInternals.compactToolResultForLLM(
  "analyze_etsy_shop_crawl_screenshots",
  competitorScreenshotAnalysisHistory.result
);
assert.equal(compactStagedScreenshotAnalysis.analysisWorkflow, "staged_screenshot_observation_to_synthesis_to_report_inputs", "compressed screenshot analysis should preserve staged workflow marker");
assert.equal(compactStagedScreenshotAnalysis.stage_observations[0].visual_tone, "bridal soft luxury", "compressed screenshot analysis should preserve per-screenshot observations");
assert.equal(compactStagedScreenshotAnalysis.stage_synthesis[0].competitorName, "TopBridalStudio", "compressed screenshot analysis should preserve competitor-level synthesis");
assert.equal(compactStagedScreenshotAnalysis.stage_report_inputs.competitorBenchmarkDrafts[0].competitor_name, "TopBridalStudio", "compressed screenshot analysis should preserve report-ready competitor benchmark drafts");
const completedCompetitorCrawlHistory = {
  ...competitorCrawlHistory,
  result: {
    ...competitorCrawlHistory.result,
    completedFullCrawl: true,
    stoppedReason: "no_next_page",
    pages: [
      ...competitorCrawlHistory.result.pages,
      {
        pageIndex: 3,
        url: "https://www.etsy.com/shop/TopBridalStudio?page=3",
        sortLabel: "Most Recent",
        productCardsVisible: 8,
        screenshotCaptured: true,
        screenshotRef: "__ETSY_SHOP_CRAWL_SCREENSHOT_mock_3__",
        pagination: { hasPagination: true, hasNextPage: false, nextPageUrl: "" },
      },
    ],
  },
};
const completedCurrentShopCrawlHistory = {
  tool: "collect_etsy_shop_pages",
  arguments: { url: "https://www.etsy.com/shop/MidnightReveriee", maxPages: 2 },
  result: {
    ok: true,
    sourceUrl: "https://www.etsy.com/shop/MidnightReveriee",
    pagesCollected: 2,
    completedFullCrawl: true,
    stoppedReason: "no_next_page",
    totalVisibleProductCards: 32,
    uniqueListingCount: 32,
    pages: [
      {
        pageIndex: 1,
        url: "https://www.etsy.com/shop/MidnightReveriee",
        sortLabel: "Most Recent",
        productCardsVisible: 24,
        screenshotCaptured: true,
        screenshotRef: "__ETSY_SHOP_CRAWL_SCREENSHOT_current_1__",
        pagination: { hasPagination: true, hasNextPage: true, nextPageUrl: "https://www.etsy.com/shop/MidnightReveriee?page=2" },
      },
      {
        pageIndex: 2,
        url: "https://www.etsy.com/shop/MidnightReveriee?page=2",
        sortLabel: "Most Recent",
        productCardsVisible: 8,
        screenshotCaptured: true,
        screenshotRef: "__ETSY_SHOP_CRAWL_SCREENSHOT_current_2__",
        pagination: { hasPagination: true, hasNextPage: false, nextPageUrl: "" },
      },
    ],
  },
};
const completedCrawlScreenshotAnalysisHistory = {
  tool: "analyze_etsy_shop_crawl_screenshots",
  arguments: {
    screenshotRefs: [
      "__ETSY_SHOP_CRAWL_SCREENSHOT_current_1__",
      "__ETSY_SHOP_CRAWL_SCREENSHOT_current_2__",
      "__ETSY_SHOP_CRAWL_SCREENSHOT_mock_1__",
      "__ETSY_SHOP_CRAWL_SCREENSHOT_mock_2__",
      "__ETSY_SHOP_CRAWL_SCREENSHOT_mock_3__",
    ],
  },
  result: {
    ok: true,
    screenshotsRequested: 5,
    screenshotsAnalyzed: 5,
    analyses: [
      { ok: true, screenshotRef: "__ETSY_SHOP_CRAWL_SCREENSHOT_current_1__", report_observation: "当前店铺首页截图已完成视觉解读。" },
      { ok: true, screenshotRef: "__ETSY_SHOP_CRAWL_SCREENSHOT_current_2__", report_observation: "当前店铺第二页截图已完成视觉解读。" },
      { ok: true, screenshotRef: "__ETSY_SHOP_CRAWL_SCREENSHOT_mock_1__", report_observation: "竞品第一页截图已完成视觉解读。" },
      { ok: true, screenshotRef: "__ETSY_SHOP_CRAWL_SCREENSHOT_mock_2__", report_observation: "竞品第二页截图已完成视觉解读。" },
      { ok: true, screenshotRef: "__ETSY_SHOP_CRAWL_SCREENSHOT_mock_3__", report_observation: "竞品第三页截图已完成视觉解读。" },
    ],
    evidenceLedgerEntries: [
      {
        source_type: "screenshot_visual",
        source_ref: "当前店铺与竞品店铺分页截图",
        observed_value: "已逐页完成当前店铺与竞品店铺分页截图视觉解读。",
        used_for: "校验完整分页采集后的视觉陈列和页面口径",
        confidence: "medium",
        limitation: "截图仍不能证明真实销量、完整库存或私有后台数据。",
      },
    ],
  },
};
assert.notDeepEqual(
  validateReport(shopOptimizerReportWithEtsyEvidence, "", "skills/etsy_global_shop_optimizer.skill.md", [
    { tool: "search_in_browser", arguments: { engine: "etsy", query: "wedding clutch" }, result: invalidEtsySearchResult },
    googleSearchHistory,
    googleTrendsHistory,
    competitorOpenHistory,
    competitorOpenHistory2,
  ], meaningfulPageContext),
  [],
  "shop optimizer critic should reject invalid or blocked Etsy search evidence"
);
assert.deepEqual(
  validateReport(shopOptimizerReportWithEtsyEvidence, "", "skills/etsy_global_shop_optimizer.skill.md", [
    { tool: "search_in_browser", arguments: { engine: "etsy", query: "wedding clutch" }, result: validEtsySearchResult },
    googleSearchHistory,
    googleTrendsHistory,
    competitorOpenHistory,
    competitorOpenHistory2,
  ], meaningfulPageContext),
  [],
  "shop optimizer critic should accept valid Etsy listing/search evidence"
);
assert.notDeepEqual(
  validateReport(shopOptimizerReportWithEtsyEvidence, "", "skills/etsy_global_shop_optimizer.skill.md", [
    { tool: "search_in_browser", arguments: { engine: "etsy", query: "wedding clutch" }, result: validEtsySearchResult },
    googleSearchHistory,
    googleTrendsHistory,
    competitorCrawlHistory,
    competitorOpenHistory2,
  ], meaningfulPageContext),
  [],
  "shop optimizer critic should reject cached crawl screenshots that have not been independently analyzed"
);
assert.deepEqual(
  validateReport(shopOptimizerReportWithEtsyEvidence, "", "skills/etsy_global_shop_optimizer.skill.md", [
    { tool: "search_in_browser", arguments: { engine: "etsy", query: "wedding clutch" }, result: validEtsySearchResult },
    googleSearchHistory,
    googleTrendsHistory,
    competitorCrawlHistory,
    competitorScreenshotAnalysisHistory,
    competitorOpenHistory2,
  ], meaningfulPageContext),
  [],
  "shop optimizer critic should accept collect_etsy_shop_pages after cached screenshots are independently analyzed"
);
assert.notDeepEqual(
  validateReport(shopOptimizerReportWithEtsyEvidence, "", "skills/etsy_global_shop_optimizer.skill.md", [
    { tool: "search_in_browser", arguments: { engine: "etsy", query: "wedding clutch" }, result: validEtsySearchResult },
    googleSearchHistory,
    googleTrendsHistory,
    batchCompetitorCrawlHistory,
  ], meaningfulPageContext),
  [],
  "shop optimizer critic should reject batch competitor crawl screenshots that have not been independently analyzed"
);
assert.deepEqual(
  validateReport(shopOptimizerReportWithEtsyEvidence, "", "skills/etsy_global_shop_optimizer.skill.md", [
    { tool: "search_in_browser", arguments: { engine: "etsy", query: "wedding clutch" }, result: validEtsySearchResult },
    googleSearchHistory,
    googleTrendsHistory,
    batchCompetitorCrawlHistory,
    competitorScreenshotAnalysisHistory,
  ], meaningfulPageContext),
  [],
  "shop optimizer critic should accept collect_etsy_competitor_shops after cached screenshots are independently analyzed"
);
const shallowCompetitorReport = globalThis.structuredClone(shopOptimizerReportWithEtsyEvidence);
delete shallowCompetitorReport.output.competitor_benchmarks;
assert.notDeepEqual(
  validateReport(shallowCompetitorReport, "", "skills/etsy_global_shop_optimizer.skill.md", [
    { tool: "search_in_browser", arguments: { engine: "etsy", query: "wedding clutch" }, result: validEtsySearchResult },
    googleSearchHistory,
    googleTrendsHistory,
    competitorOpenHistory,
    competitorOpenHistory2,
  ], meaningfulPageContext),
  [],
  "shop optimizer critic should reject reports without per-competitor product structure benchmarks"
);
const contradictoryCompetitorReport = globalThis.structuredClone(shopOptimizerReportWithEtsyEvidence);
contradictoryCompetitorReport.output.analysis += " 本轮未能完整抓取 3 个竞品店铺的完整页面文本与全屏截图，但已完成竞品画廊和视觉方法反向工程。";
const searchOnlyCompetitorHistory = [
  { ...competitorOpenHistory, result: { ...competitorOpenHistory.result, screenshotRef: undefined } },
  { ...competitorOpenHistory2, result: { ...competitorOpenHistory2.result, screenshotRef: undefined } },
];
assert.notDeepEqual(
  validateReport(contradictoryCompetitorReport, "", "skills/etsy_global_shop_optimizer.skill.md", [
    { tool: "search_in_browser", arguments: { engine: "etsy", query: "wedding clutch" }, result: validEtsySearchResult },
    googleSearchHistory,
    googleTrendsHistory,
    ...searchOnlyCompetitorHistory,
  ], meaningfulPageContext),
  [],
  "shop optimizer critic should reject deep competitor claims that admit missing page-level capture"
);
const falseFullCoverageReport = globalThis.structuredClone(shopOptimizerReportWithEtsyEvidence);
falseFullCoverageReport.output.analysis += " 已抓取全店所有商品和全部 SKU 的完整价格分布。";
assert.notDeepEqual(
  validateReport(falseFullCoverageReport, "", "skills/etsy_global_shop_optimizer.skill.md", [
    { tool: "search_in_browser", arguments: { engine: "etsy", query: "wedding clutch" }, result: validEtsySearchResult },
    googleSearchHistory,
    googleTrendsHistory,
    competitorOpenHistory,
    competitorOpenHistory2,
  ], meaningfulPageContext),
  [],
  "shop optimizer critic should reject full-shop product coverage claims without API or pagination crawl evidence"
);
const falseCountCoverageReport = globalThis.structuredClone(shopOptimizerReportWithEtsyEvidence);
falseCountCoverageReport.output.overview += " 已读取全店 17 款商品。";
assert.notDeepEqual(
  validateReport(falseCountCoverageReport, "", "skills/etsy_global_shop_optimizer.skill.md", [
    { tool: "search_in_browser", arguments: { engine: "etsy", query: "wedding clutch" }, result: validEtsySearchResult },
    googleSearchHistory,
    googleTrendsHistory,
    competitorOpenHistory,
    competitorOpenHistory2,
  ], meaningfulPageContext),
  [],
  "shop optimizer critic should reject visible sample counts presented as full-shop counts"
);
assert.deepEqual(
  validateReport(falseFullCoverageReport, "", "skills/etsy_global_shop_optimizer.skill.md", [
    { tool: "search_in_browser", arguments: { engine: "etsy", query: "wedding clutch" }, result: validEtsySearchResult },
    googleSearchHistory,
    googleTrendsHistory,
    completedCurrentShopCrawlHistory,
    completedCompetitorCrawlHistory,
    completedCrawlScreenshotAnalysisHistory,
    competitorOpenHistory2,
  ], meaningfulPageContext),
  [],
  "shop optimizer critic should allow full-shop coverage claims only after a completed pagination crawl"
);
const shopOptimizerReportWithApiClaims = globalThis.structuredClone(shopOptimizerReportWithEtsyEvidence);
shopOptimizerReportWithApiClaims.output.data[0].recommendation = "待 Etsy API 复核 Sessions、订单、转化与 Etsy 自发货履约节奏后再扩大广告。";
const validShopEvidenceHistory = [
  { tool: "search_in_browser", arguments: { engine: "etsy", query: "wedding clutch" }, result: validEtsySearchResult },
  googleSearchHistory,
  googleTrendsHistory,
  competitorOpenHistory,
  competitorOpenHistory2,
];
const shopProductionSkeletonState = __testInternals.buildShopOptimizerProductionSkeletonState(validShopEvidenceHistory, meaningfulPageContext);
assert.equal(shopProductionSkeletonState.reportSkeleton, "etsy_shop_health_v1", "shop production state should identify the shared report skeleton");
assert.equal(shopProductionSkeletonState.totalSlots, 7, "shop production state should track the seven shop-health report slots");
assert.ok(shopProductionSkeletonState.filledCount >= 5, "evidence-complete shop runs should mark most report skeleton slots as filled before final delivery");
assert.equal(
  shopProductionSkeletonState.slots.find((slot) => slot.id === "competitor_benchmarks")?.status,
  "filled",
  "opened competitor evidence should fill the competitor_benchmarks production slot"
);
assert.equal(
  shopProductionSkeletonState.slots.find((slot) => slot.id === "external_demand")?.status,
  "filled",
  "Etsy, Google Search and Google Trends evidence should fill the external-demand production slot"
);
assert.equal(
  shopProductionSkeletonState.slots.find((slot) => slot.id === "trust_fulfillment")?.status,
  "partial",
  "fulfillment should remain partial without a realtime shipping/logistics search"
);
const shopProductionSkeletonPrompt = __testInternals.formatShopOptimizerProductionSkeletonPrompt(validShopEvidenceHistory, meaningfulPageContext);
assert.match(shopProductionSkeletonPrompt, /店铺体检生产骨架/, "skeleton prompt should label the production skeleton");
assert.match(shopProductionSkeletonPrompt, /competitor_benchmarks/, "skeleton prompt should map production slots to final competitor_benchmarks fields");
assert.match(shopProductionSkeletonPrompt, /不要前台二次换算 USD/, "skeleton prompt should keep regional storefront prices through the production process");
const toolDomHistory = [
  ...validShopEvidenceHistory,
  {
    tool: "read_current_page",
    arguments: {},
    result: {
      url: "https://www.etsy.com/shop/MidnightReveriee",
      title: "MidnightReveriee - Etsy",
      visibleText: "MidnightReveriee wedding clutch bridesmaid gifts French Chic Soft Luxury Bridal Clutches Bridesmaid Gifts",
      productCards: [{ title: "Pearl wedding clutch", price: "$42.00", href: "https://www.etsy.com/listing/mock" }],
      pageHealth: { hasMeaningfulDom: true, isLikelyBlocked: false },
    },
  },
];
const visualOnlyPageContext = {
  url: "https://www.etsy.com/shop/MidnightReveriee",
  title: "MidnightReveriee - Etsy",
  screenshot: "data:image/jpeg;base64,mock",
  pageHealth: { hasMeaningfulDom: false, isLikelyBlocked: false },
};
const missingPageDomLedgerReport = globalThis.structuredClone(shopOptimizerReportWithEtsyEvidence);
missingPageDomLedgerReport.output.data.forEach((item) => {
  item.evidence_ledger = item.evidence_ledger.filter((entry) => entry.source_type !== "page_dom");
});
assert.notDeepEqual(
  validateReport(missingPageDomLedgerReport, "", "skills/etsy_global_shop_optimizer.skill.md", toolDomHistory, visualOnlyPageContext),
  [],
  "shop optimizer critic should still reject reports that omit page_dom ledger entries"
);
const repairedMissingPageDomLedgerReport = autoRepairFinalReportForDelivery(missingPageDomLedgerReport, {
  skillId: "skills/etsy_global_shop_optimizer.skill.md",
  toolHistory: toolDomHistory,
  pageContext: visualOnlyPageContext,
});
assert.equal(repairedMissingPageDomLedgerReport.changed, true, "shop optimizer reports should auto-attach page_dom ledger when real page text exists in tool history");
assert.deepEqual(
  validateReport(repairedMissingPageDomLedgerReport.parsed, "", "skills/etsy_global_shop_optimizer.skill.md", toolDomHistory, visualOnlyPageContext),
  [],
  "auto-attached page_dom evidence should prevent non-quality critic redo"
);
const missingShopGoogleSearchLedgerReport = globalThis.structuredClone(shopOptimizerReportWithEtsyEvidence);
missingShopGoogleSearchLedgerReport.output.data.forEach((item) => {
  item.evidence_ledger = item.evidence_ledger.filter((entry) => entry.source_type !== "google_search");
});
assert.notDeepEqual(
  validateReport(missingShopGoogleSearchLedgerReport, "", "skills/etsy_global_shop_optimizer.skill.md", validShopEvidenceHistory, meaningfulPageContext),
  [],
  "shop optimizer reports that use Google Search conclusions should fail before google_search ledger auto-repair"
);
const repairedMissingShopGoogleSearchLedgerReport = autoRepairFinalReportForDelivery(missingShopGoogleSearchLedgerReport, {
  skillId: "skills/etsy_global_shop_optimizer.skill.md",
  toolHistory: validShopEvidenceHistory,
  pageContext: meaningfulPageContext,
});
assert.equal(repairedMissingShopGoogleSearchLedgerReport.changed, true, "shop optimizer reports should auto-attach Google Search ledger when verified search evidence exists");
assert.ok(
  repairedMissingShopGoogleSearchLedgerReport.parsed.output.data[0].evidence_ledger.some((entry) => entry.source_type === "google_search"),
  "auto-repair should add google_search evidence to shop optimizer reports"
);
assert.deepEqual(
  validateReport(repairedMissingShopGoogleSearchLedgerReport.parsed, "", "skills/etsy_global_shop_optimizer.skill.md", validShopEvidenceHistory, meaningfulPageContext),
  [],
  "auto-repaired Google Search ledger should prevent non-quality shop optimizer critic redo"
);
const missingShopTrendLedgerReport = globalThis.structuredClone(shopOptimizerReportWithEtsyEvidence);
missingShopTrendLedgerReport.output.data.forEach((item) => {
  item.evidence_ledger = item.evidence_ledger.filter((entry) => !["google_trends", "screenshot_visual"].includes(entry.source_type) || !/Google Trends|趋势/i.test(`${entry.source_ref || ""} ${entry.observed_value || ""}`));
});
assert.notDeepEqual(
  validateReport(missingShopTrendLedgerReport, "", "skills/etsy_global_shop_optimizer.skill.md", validShopEvidenceHistory, meaningfulPageContext),
  [],
  "shop optimizer reports that use Trends conclusions should fail before google_trends ledger auto-repair"
);
const repairedMissingShopTrendLedgerReport = autoRepairFinalReportForDelivery(missingShopTrendLedgerReport, {
  skillId: "skills/etsy_global_shop_optimizer.skill.md",
  toolHistory: validShopEvidenceHistory,
  pageContext: meaningfulPageContext,
});
assert.equal(repairedMissingShopTrendLedgerReport.changed, true, "shop optimizer reports should auto-attach Google Trends ledger when verified Trends evidence exists");
assert.ok(
  repairedMissingShopTrendLedgerReport.parsed.output.data[0].evidence_ledger.some((entry) => entry.source_type === "google_trends"),
  "auto-repair should add google_trends evidence to shop optimizer reports"
);
assert.ok(
  repairedMissingShopTrendLedgerReport.parsed.output.data[0].evidence_ledger.some((entry) => entry.source_type === "screenshot_visual" && /Google Trends|趋势/i.test(`${entry.source_ref || ""} ${entry.observed_value || ""}`)),
  "auto-repair should add Google Trends visual interpretation ledger to shop optimizer reports"
);
assert.deepEqual(
  validateReport(repairedMissingShopTrendLedgerReport.parsed, "", "skills/etsy_global_shop_optimizer.skill.md", validShopEvidenceHistory, meaningfulPageContext),
  [],
  "auto-repaired Google Trends ledger should prevent non-quality shop optimizer critic redo"
);
assert.notDeepEqual(
  validateReport(shopOptimizerReportWithApiClaims, "", "skills/etsy_global_shop_optimizer.skill.md", validShopEvidenceHistory, meaningfulPageContext),
  [],
  "shop optimizer reports with API/order/fulfillment claims should fail before assumption downgrade"
);
const repairedShopOptimizerApiClaims = autoRepairFinalReportForDelivery(shopOptimizerReportWithApiClaims, {
  skillId: "skills/etsy_global_shop_optimizer.skill.md",
  toolHistory: validShopEvidenceHistory,
  pageContext: meaningfulPageContext,
});
assert.equal(repairedShopOptimizerApiClaims.changed, true, "shop optimizer API/order/fulfillment claims should be downgraded automatically when API evidence is absent");
assert.deepEqual(
  validateReport(repairedShopOptimizerApiClaims.parsed, "", "skills/etsy_global_shop_optimizer.skill.md", validShopEvidenceHistory, meaningfulPageContext),
  [],
  "auto-repaired shop optimizer API assumptions should pass validation without critic redo"
);
const shopOptimizerReportWithAvailableApiClaims = globalThis.structuredClone(shopOptimizerReportWithApiClaims);
const validShopEvidenceHistoryWithApi = [
  {
    tool: "etsy_api_get_store_snapshot",
    arguments: {},
    result: {
      ok: true,
      result: {
        listings: [{ title: "Personalized wedding clutch" }],
        receipts: [],
        capabilities: {
          listings: { supported: true },
          receipts: { supported: true },
          analytics: { supported: false },
        },
      },
    },
  },
  ...validShopEvidenceHistory,
];
const repairedShopOptimizerAvailableApiClaims = autoRepairFinalReportForDelivery(shopOptimizerReportWithAvailableApiClaims, {
  skillId: "skills/etsy_global_shop_optimizer.skill.md",
  toolHistory: validShopEvidenceHistoryWithApi,
  pageContext: meaningfulPageContext,
});
assert.equal(repairedShopOptimizerAvailableApiClaims.changed, true, "shop optimizer API/order/fulfillment claims should auto-attach available Etsy API boundary evidence");
assert.ok(
  repairedShopOptimizerAvailableApiClaims.parsed.output.data[0].evidence_ledger.some((entry) => entry.source_type === "etsy_api" && /analytics/.test(`${entry.observed_value || ""} ${entry.limitation || ""}`)),
  "auto-repaired API ledger should preserve supported/unsupported Etsy API capability boundaries"
);
assert.deepEqual(
  validateReport(repairedShopOptimizerAvailableApiClaims.parsed, "", "skills/etsy_global_shop_optimizer.skill.md", validShopEvidenceHistoryWithApi, meaningfulPageContext),
  [],
  "auto-attached Etsy API boundary evidence should prevent non-quality critic redo"
);
const shopOptimizerReportWithPrivateMetricPlan = globalThis.structuredClone(shopOptimizerReportWithEtsyEvidence);
shopOptimizerReportWithPrivateMetricPlan.output.data[0].title = "清退低相关 SKU，重建垂直婚礼场景专营店";
shopOptimizerReportWithPrivateMetricPlan.output.data[0].direction = "先清退低相关 SKU，并在后续接入 Etsy API 后复核流量、订单、履约、Shipping Profile 和第三方海外仓成本。";
shopOptimizerReportWithPrivateMetricPlan.output.data[0].evidence = "当前只读取了公开店铺页、截图、Etsy Search、Google Search 与 Google Trends；API/订单/履约数据未配置。";
shopOptimizerReportWithPrivateMetricPlan.output.data[0].first_actions = [
  "按公开店铺页和竞品样本筛出低相关 SKU",
  "将 API/流量/订单/履约指标列为待店主授权后复核",
  "先完善 Shipping Profile 的公开说明，避免承诺未验证的物流时效",
];
shopOptimizerReportWithPrivateMetricPlan.output.data[0].evidence_ledger = shopOptimizerReportWithPrivateMetricPlan.output.data[0].evidence_ledger
  .filter((entry) => entry.source_type !== "etsy_api" && entry.source_type !== "assumption");
assert.notDeepEqual(
  validateReport(shopOptimizerReportWithPrivateMetricPlan, "", "skills/etsy_global_shop_optimizer.skill.md", validShopEvidenceHistory, meaningfulPageContext),
  [],
  "shop optimizer private API/traffic/order/fulfillment plans should fail before explicit assumption downgrade when API is not configured"
);
const repairedShopOptimizerPrivateMetricPlan = autoRepairFinalReportForDelivery(shopOptimizerReportWithPrivateMetricPlan, {
  skillId: "skills/etsy_global_shop_optimizer.skill.md",
  toolHistory: validShopEvidenceHistory,
  pageContext: meaningfulPageContext,
});
assert.equal(repairedShopOptimizerPrivateMetricPlan.changed, true, "shop optimizer private API/traffic/order/fulfillment plans should be downgraded when Etsy API is absent");
assert.ok(
  repairedShopOptimizerPrivateMetricPlan.parsed.output.data[0].evidence_ledger.some((entry) =>
    entry.source_type === "assumption"
    && /API/.test(`${entry.source_ref || ""} ${entry.observed_value || ""} ${entry.used_for || ""} ${entry.limitation || ""}`)
    && /流量|订单|履约/.test(`${entry.observed_value || ""} ${entry.used_for || ""} ${entry.limitation || ""}`)
    && /未配置|未取得|待验证/.test(`${entry.observed_value || ""} ${entry.used_for || ""} ${entry.limitation || ""}`)
  ),
  "auto-repair should add a validator-compatible assumption ledger for missing Etsy personal API evidence"
);
assert.deepEqual(
  validateReport(repairedShopOptimizerPrivateMetricPlan.parsed, "", "skills/etsy_global_shop_optimizer.skill.md", validShopEvidenceHistory, meaningfulPageContext),
  [],
  "missing Etsy personal API should not block shop optimizer delivery after explicit assumption downgrade"
);
const shopOptimizerReportWithSourceTypeAliases = JSON.parse(JSON.stringify(shopOptimizerReportWithEtsyEvidence));
shopOptimizerReportWithSourceTypeAliases.output.data[0].evidence_ledger[0].source_type = "current_page_dom";
shopOptimizerReportWithSourceTypeAliases.output.data[0].evidence_ledger[1].source_type = "current_page_screenshot";
shopOptimizerReportWithSourceTypeAliases.output.data[0].evidence_ledger[2].source_type = "competitor_screenshot";
shopOptimizerReportWithSourceTypeAliases.output.data[0].evidence_ledger[5].source_type = "google_search_us";
assert.deepEqual(
  validateReport(shopOptimizerReportWithSourceTypeAliases, "", "skills/etsy_global_shop_optimizer.skill.md", validShopEvidenceHistory, meaningfulPageContext),
  [],
  "shop optimizer validator should accept source_type aliases as canonical evidence classes instead of blocking delivery"
);
shopOptimizerReportWithSourceTypeAliases.output.data[0].evidence_ledger.push({
  source_type: "own_shop_api",
  source_ref: "Etsy personal API not configured",
  observed_value: "用户未配置 Etsy 个人 API，本轮不使用 API 数据。",
  used_for: "验证 API 别名在无 API 证据时会被自动降级。",
  confidence: "low",
  limitation: "未配置 Etsy 个人访问 API，需后续授权后复核。",
});
const repairedShopOptimizerSourceTypeAliases = autoRepairFinalReportForDelivery(shopOptimizerReportWithSourceTypeAliases, {
  skillId: "skills/etsy_global_shop_optimizer.skill.md",
  toolHistory: validShopEvidenceHistory,
  pageContext: meaningfulPageContext,
});
assert.equal(repairedShopOptimizerSourceTypeAliases.changed, true, "source_type aliases should be normalized before delivery");
assert.deepEqual(
  repairedShopOptimizerSourceTypeAliases.parsed.output.data[0].evidence_ledger.map((entry) => entry.source_type).slice(0, 6),
  ["page_dom", "screenshot_visual", "screenshot_visual", "screenshot_visual", "etsy_search", "google_search"],
  "auto-repair should canonicalize page, screenshot and Google Search source_type aliases"
);
assert.ok(
  repairedShopOptimizerSourceTypeAliases.parsed.output.data[0].evidence_ledger.some((entry) =>
    entry.source_type === "assumption" && /Etsy|API|未配置|未取得/i.test(`${entry.source_ref || ""} ${entry.observed_value || ""} ${entry.limitation || ""}`)
  ),
  "auto-repair should canonicalize API aliases and then downgrade them when no Etsy API evidence exists"
);

const thinShopHealthReport = {
  type: "final",
  output: {
    overview: "店铺体检报告：当前店铺视觉统一，但需要更明确的垂直定位和欧美买家场景。",
    analysis: "已读取当前店铺页面，并完成 Etsy 搜索、Google Search US 和 Google Trends US 取证。建议优先优化首图、标题与商品矩阵。",
    summary: "先改主推款首图和标题，再复盘点击与加购。",
    data: [{
      plan_id: "B-1",
      title: "首图与标题整改",
      diagnosis_level: "B",
      direction: "优化主推款首图卖点、SEO 标题和商品矩阵。",
    }],
  },
};
assert.notDeepEqual(
  validateReport(thinShopHealthReport, "", "skills/etsy_global_shop_optimizer.skill.md", validShopEvidenceHistory, meaningfulPageContext),
  [],
  "thin shop health reports should fail before skeleton auto-repair"
);
const repairedThinShopHealthReport = autoRepairFinalReportForDelivery(thinShopHealthReport, {
  skillId: "skills/etsy_global_shop_optimizer.skill.md",
  toolHistory: validShopEvidenceHistory,
  pageContext: meaningfulPageContext,
});
assert.equal(repairedThinShopHealthReport.changed, true, "shop optimizer auto-repair should generate a report skeleton for thin reports when evidence exists");
assert.ok(
  Array.isArray(repairedThinShopHealthReport.parsed.output.diagnostic_depth_matrix) &&
  repairedThinShopHealthReport.parsed.output.diagnostic_depth_matrix.length >= 7,
  "shop health skeleton should include the required 7 diagnostic dimensions"
);
assert.ok(
  repairedThinShopHealthReport.parsed.output.competitor_benchmarks.length >= 2,
  "shop health skeleton should generate per-competitor benchmarks from opened competitor pages"
);
assert.ok(
  repairedThinShopHealthReport.parsed.output.data[0].evidence_ledger.some((entry) => entry.source_type === "etsy_search") &&
  repairedThinShopHealthReport.parsed.output.data[0].evidence_ledger.some((entry) => entry.source_type === "google_search") &&
  repairedThinShopHealthReport.parsed.output.data[0].evidence_ledger.some((entry) => entry.source_type === "google_trends"),
  "shop health skeleton should bind Etsy, Google Search and Google Trends evidence ledgers"
);
assert.deepEqual(
  validateReport(repairedThinShopHealthReport.parsed, "", "skills/etsy_global_shop_optimizer.skill.md", validShopEvidenceHistory, meaningfulPageContext),
  [],
  "auto-generated shop health skeleton should prevent QA from bouncing evidence-complete thin reports"
);

const dom = new JSDOM(html, {
  url: "chrome-extension://test/dashboard.html",
  runScripts: "outside-only",
  pretendToBeVisual: true,
});

const { window } = dom;
window.HTMLCanvasElement.prototype.getContext = () => ({
  scale() {},
  clearRect() {},
  beginPath() {},
  roundRect() {},
  fill() {},
  fillText() {},
  set fillStyle(_value) {},
  set font(_value) {},
  set textAlign(_value) {},
});

const storage = {
  trackedProducts: [],
  savedResults: [],
  monitorChangeEvents: [],
  monitorReports: [],
  monitorTasks: [],
  growthExperiments: [],
  growthWorkflowTaskState: {},
  growthCases: [],
  growthActionRuns: [],
  etsySkuAnalyticsSnapshot: {
    shopId: "shop-1",
    syncedAt: "2026-07-09T08:00:00Z",
    result: {
      metrics: ["hits_view", "session_view", "ordered_units", "conv_tocart"],
      data: [
        {
          dimensions: [{ id: "SKU-001", name: "厨房收纳架" }],
          metrics: [1200, 410, 4, 1.4],
        },
        {
          dimensions: [{ id: "SKU-002", name: "浴室置物架" }],
          metrics: [900, 280, 2, 0.8],
        },
      ],
    },
  },
  etsyStoreSnapshotCache: null,
  etsyShops: [{ id: "shop-1", name: "测试店铺", clientId: "client-1", warehouseType: "Etsy 自发货" }],
  activeShopId: "shop-1",
};

const messages = [];
let alertText = "";
let connectedPort = null;

function makePort() {
  const messageListeners = [];
  const disconnectListeners = [];
  return {
    name: "etsy-agent-loop",
    onMessage: { addListener: (fn) => messageListeners.push(fn) },
    onDisconnect: { addListener: (fn) => disconnectListeners.push(fn) },
    postMessage(message) {
      messages.push(message);
      setTimeout(() => {
        messageListeners.forEach((fn) => fn({
          type: "PROGRESS",
          data: { type: "thinking", message: "正在读取 Seller API 与店铺证据" },
        }));
      }, 0);
      setTimeout(() => {
        messageListeners.forEach((fn) => fn({
          type: "SUCCESS",
          result: {
            type: "final",
            skillId: message.skillPath,
            result: {
              overview: "店铺体检报告：定位、人群与商品矩阵需要先收敛。",
              analysis: "Seller API 显示多个 SKU 有曝光但低加购，当前问题不是单张海报，而是目标客群、价格带和商品结构混乱。",
              summary: "先完成店铺定位重构，再推进 SKU 标题、主图、价格与履约细节。",
              data: [
                {
                  title: "确认目标客群和主价格带",
                  diagnosis_level: "P0",
                  evidence: "2 个核心 SKU 均有曝光但加购弱，且无可放大 SKU。",
                  first_actions: ["确认主客群", "收敛商品矩阵", "列出应下架或弱化 SKU"],
                },
              ],
            },
          },
        }));
      }, 5);
    },
    disconnect() {
      disconnectListeners.forEach((fn) => fn());
    },
  };
}

window.chrome = {
  storage: {
    local: {
      get(keys, callback) {
        if (Array.isArray(keys)) {
          callback(Object.fromEntries(keys.map((key) => [key, storage[key]])));
          return;
        }
        if (typeof keys === "string") {
          callback({ [keys]: storage[keys] });
          return;
        }
        callback({ ...storage });
      },
      set(values, callback) {
        Object.assign(storage, values);
        callback?.();
      },
      clear(callback) {
        Object.keys(storage).forEach((key) => delete storage[key]);
        callback?.();
      },
    },
  },
  runtime: {
    getURL: (filePath) => `chrome-extension://test/${filePath}`,
    sendMessage: async (message) => {
      if (message.type === "GET_SAVED_RESULTS") return { ok: true, data: storage.savedResults };
      if (message.type === "DELETE_RESULT") {
        storage.savedResults = storage.savedResults.filter((item) => String(item.id) !== String(message.id));
        return { ok: true };
      }
      return { ok: true, data: {} };
    },
    connect({ name }) {
      assert.equal(name, "etsy-agent-loop");
      connectedPort = makePort();
      return connectedPort;
    },
  },
};

window.marked = {
  parse: (text = "") => `<article>${String(text)
    .replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[char]))
    .replace(/\n/g, "<br>")}</article>`,
};
window.alert = (message) => {
  alertText = message;
};
window.confirm = () => true;

const context = dom.getInternalVMContext();
context.chrome = window.chrome;
context.marked = window.marked;
context.alert = window.alert;
context.confirm = window.confirm;
vm.runInContext(js, context, { filename: "dashboard.js" });

window.document.dispatchEvent(new window.Event("DOMContentLoaded", { bubbles: true }));
await wait();

assert.equal(window.document.querySelectorAll(".canvas-command-bar .growth-action-btn").length, 0, "workflow header should not expose direct business action buttons");
assert.equal(window.document.querySelectorAll(".canvas-focus-tab").length, 0, "workflow header should not expose redundant focus tabs");
assert.ok(window.document.querySelector(".workflow-zoom-dock"), "workflow zoom controls should live in the bottom dock");
assert.doesNotMatch(window.document.querySelector(".workflow-canvas-space")?.textContent || "", /滚轮缩放，按住空白处拖动画布/, "workflow helper hint should be removed");
assert.match(window.document.querySelector('.root-node[data-root-id="store_health"]')?.textContent || "", /API 已同步/, "workflow root should expose Seller API evidence status before running");

window.document.querySelector('.root-node[data-root-id="platform_trends"]').click();
await wait();
assert.equal(messages.length, 0, "clicking a workflow root should not start RUN_SKILL");
assert.equal(window.document.querySelector('.root-node[data-root-id="platform_trends"]')?.classList.contains("selected"), true, "root click should select the matching workflow root");
assert.match(window.document.getElementById("workflow-pip").textContent, /平台趋势/, "root click should open the matching root detail");
assert.match(window.document.getElementById("workflow-pip").textContent, /运行前证据检查/, "workflow PIP should expose pre-run evidence checklist");
assert.match(window.document.getElementById("workflow-pip").textContent, /需前台页面/, "platform trend flow should warn when page context is needed");

window.document.querySelector('.root-node[data-root-id="store_health"]').click();
await wait();
const runButton = window.document.querySelector('.scrum-board-head .growth-action-btn[data-action="diagnose_store_growth"]');
assert.ok(runButton, "store diagnosis button should exist on workflow canvas");
runButton.click();

for (let i = 0; i < 30; i += 1) {
  await wait(10);
  if (storage.growthActionRuns?.[0]?.status === "completed") break;
}

assert.ok(connectedPort, "dashboard should connect to the agent loop port");
assert.equal(messages[0]?.type, "RUN_SKILL", "dashboard should start a real RUN_SKILL flow");
assert.equal(messages[0]?.growthActionId, "diagnose_store_growth", "RUN_SKILL should carry growth action id");
assert.ok(messages[0]?.growthRunId, "RUN_SKILL should carry growth run id");
assert.ok(messages[0]?.growthCaseId?.startsWith("store_health_"), "RUN_SKILL should carry growth case id");
assert.ok(messages[0]?.workflowSessionId?.startsWith("workflow_session_"), "dashboard should start each growth run with a unique workflow session id");
assert.equal(messages[0]?.forceNewSession, true, "dashboard growth runs should default to a new workflow session");
assert.equal(messages[0]?.continueSession, false, "dashboard growth runs should not implicitly resume old checkpoints");

const run = storage.growthActionRuns[0];
assert.equal(run.status, "completed", "growth action run should complete");
assert.ok(run.workflowSessionId?.startsWith("workflow_session_"), "stored growth run should retain its workflow session id");
assert.ok(run.savedResultId, "completed run should link to a saved report");

const storeCase = storage.growthCases.find((item) => item.type === "store_health");
assert.ok(storeCase, "store health case should be created");
assert.equal(storeCase.status, "completed", "store health case should be completed after successful run");
assert.ok(storeCase.reportIds.includes(String(run.savedResultId)), "case should retain saved report id");
assert.equal(storeCase.runs[0].status, "completed", "case run history should be completed");

assert.equal(storage.savedResults.length, 1, "dashboard should save a report when background did not return savedEntry");
assert.equal(storage.savedResults[0].growthCaseId, storeCase.id, "saved report should link back to growth case");

await wait();
const rootTitles = [...window.document.querySelectorAll(".root-node strong")].map((node) => node.textContent.trim());
assert.deepEqual(rootTitles.slice(0, 7), ["店铺体检", "竞品跟踪", "商品页转化", "平台趋势", "机会扩品", "供应商货源", "执行与复盘"], "workflow roots should stay product-scoped");
assert.equal(rootTitles.includes("店铺定位重构"), false, "positioning must not be rendered as an independent root");

window.document.querySelector('.nav-menu button[data-tab="reports"]').click();
assert.equal(window.document.querySelectorAll(".report-item").length, 1, "report center should show generated report");

storage.savedResults.unshift({
  id: "wrapped-final-report",
  createdAt: "2026-07-10T10:00:00Z",
  skillId: "skills/etsy_sourcing_finder.skill.md",
  skillName: "Etsy 货源筛选",
  result: {
    type: "final",
    output: {
      overview: "Etsy 松鼠喂食器跨境供应链审计",
      analysis: "已经进入采购平台结果页，应先筛选候选卡片再打开详情页审计。",
      summary: "停止重复搜索，优先完成视觉初筛和详情页穿透。",
      data: [
        {
          plan_id: "SRC-001",
          diagnosis_level: "P1",
          direction: "图片搜索结果页筛选",
          evidence: "当前已有候选商品卡片。",
          first_actions: ["按主图相似度排序", "打开 1-3 个详情页"],
        },
      ],
    },
  },
});
context.renderReportsList([], storage.savedResults);
const wrappedReportText = window.document.getElementById("report-viewer-content").textContent;
assert.match(wrappedReportText, /Etsy 松鼠喂食器跨境供应链审计/, "wrapped final reports should render as business report content");
assert.doesNotMatch(wrappedReportText, /"type":\s*"final"/, "wrapped final reports should not render raw JSON by default");

storage.savedResults.unshift({
  id: "embedded-json-report",
  createdAt: "2026-07-10T10:05:00Z",
  skillId: "skills/etsy_sourcing_finder.skill.md",
  skillName: "Etsy-1688寻源账本",
  result: `让我构建最终报告。 json ${JSON.stringify({
    type: "final",
    output: {
      overview: "Etsy 金属喂食器跨境供应链审计报告",
      analysis: "1688 图片搜索受限，本轮需要人工寻源验证，不得输出采购直达链接。",
      summary: "先联系 2-3 家金属花园装饰品供应商，再复核物流和关税。",
      data: [
        {
          plan_id: "SRC-002",
          diagnosis_level: "待验证假设",
          direction: "1688 货源寻源 - 图片搜索受限",
          evidence: "图片搜索受平台限制，未获得真实详情页。",
          first_actions: ["联系供应商", "要求实物图对比"],
        },
      ],
    },
  })}`,
});
context.renderReportsList([], storage.savedResults);
const embeddedReportText = window.document.getElementById("report-viewer-content").textContent;
assert.match(embeddedReportText, /Etsy 金属喂食器跨境供应链审计报告/, "embedded final JSON text should render as business report content");
assert.doesNotMatch(embeddedReportText, /"type":\s*"final"/, "embedded final JSON text should not render raw JSON by default");

storage.savedResults.unshift({
  id: "nested-object-report",
  createdAt: "2026-07-10T10:10:00Z",
  skillId: "skills/etsy_global_shop_optimizer.skill.md",
  skillName: "Etsy 店铺优化诊断",
  result: {
    type: "final",
    output: {
      overview: {
        shop_stage: "新店冷启动",
        core_problem: "信任资产不足，婚礼/晚宴场景定位需要收敛",
      },
      analysis: {
        evidence_chain: {
          page_dom: "已读取店铺页面文本与商品结构",
          competitor: "已对标 JuniperAndLace 的婚礼场景陈列",
        },
      },
      summary: {
        immediate_priority: "先补 About、FAQ、Shipping Profile 和首图画廊",
      },
      diagnostic_depth_matrix: [
        { dimension: "店铺定位与经营阶段", finding: "新店冷启动", evidence: "页面文本", gap: "信任资产不足", action: "补 About 与政策" },
        { dimension: "视觉首图与画廊", finding: "缺少尺寸/包装信号", evidence: "截图", gap: "点击理由不足", action: "重做首图" },
        { dimension: "SEO 标题与 Attributes", finding: "关键词结构待优化", evidence: "Etsy 搜索", gap: "长尾词覆盖不足", action: "重写标题" },
        { dimension: "商品矩阵与价格带", finding: "价格层级待拆分", evidence: "竞品样本", gap: "引流/利润款角色不清", action: "重组矩阵" },
        { dimension: "竞品对标与可见排序", finding: "竞品前置个性化婚礼款", evidence: "竞品店铺采集", gap: "陈列层级不足", action: "重排第一屏" },
        { dimension: "Google/Trends 站外需求", finding: "婚礼场景需求可见", evidence: "Google Trends", gap: "需导出复核", action: "按季节窗口实验" },
        { dimension: "信任资产、评价与履约", finding: "低评价阶段", evidence: "页面和竞品评价", gap: "政策/物流说明不足", action: "完善 Shipping Profile" },
      ],
      competitor_benchmarks: [{
        competitor_name: "JuniperAndLace",
        competitor_url: "https://www.etsy.com/shop/JuniperAndLace",
        sampled_products_count: 2,
        visible_sku_count_estimate: "首屏 16 个可见商品",
        category_mix: ["lace clutch", "bridal clutch"],
        price_distribution: { min: "$36", max: "$240", main_band: "$60-$90" },
        promotion_signals: ["Star Seller", "free shipping"],
        shop_review_signal: { rating: "5.0", review_count: "1.1k reviews" },
        listing_order_insight: { visible_sort_order: "Lace clutch first", observed_order_basis: "Sort: Most Recent", interpretation_limit: "可见排序不能证明销量" },
        visual_method: "婚礼场景和细节微距",
        seo_method: "Personalized Bridal Clutch",
        product_samples: [
          { title: "Lace Bridal Clutch", price: "$68", category_or_scenario: "bride", promotion_signal: "free shipping", visible_order_rank: 1 },
          { title: "Custom Fabric Clutch", price: "$88", category_or_scenario: "bridesmaid", promotion_signal: "Star Seller", visible_order_rank: 2 },
        ],
      }],
      data: [{
        plan_id: "A-1",
        title: { zh: "新店信任基石", en: "Trust Foundation" },
        diagnosis_level: "A",
        direction: { focus: "聚焦婚礼/晚宴场景", remove: ["非相关 SKU", "泛礼品表达"] },
        evidence: { page_dom: "0 评价店铺", competitor: "JuniperAndLace 垂直定位" },
        first_actions: [{ task: "撰写英文 About" }, { task: "优化 Shipping Profile" }],
      }],
    },
  },
});
context.renderReportsList([], storage.savedResults);
const nestedObjectReportText = window.document.getElementById("report-viewer-content").textContent;
assert.doesNotMatch(nestedObjectReportText, /\[object Object\]/, "nested object report sections should not render as [object Object]");
assert.match(nestedObjectReportText, /新店冷启动/, "nested overview object values should render as readable report text");
assert.match(nestedObjectReportText, /信任资产不足/, "nested overview object details should be preserved");
assert.match(nestedObjectReportText, /JuniperAndLace/, "nested analysis object values should render");
assert.match(nestedObjectReportText, /新店信任基石|Trust Foundation/, "nested card title objects should render as readable text");
assert.match(nestedObjectReportText, /店铺体检深度矩阵/, "report center should render diagnostic depth matrix as a structured section");
assert.match(nestedObjectReportText, /竞品店铺商品结构解析/, "report center should render competitor benchmarks as a structured section");
assert.match(nestedObjectReportText, /价格分布/, "competitor benchmark table should expose pricing distribution columns");
assert.match(nestedObjectReportText, /Lace Bridal Clutch/, "competitor benchmark product samples should render");

assert.match(css, /\.report-viewer\s*\{[\s\S]*?overflow:\s*hidden;/, "report viewer shell should not rely on page-level overflow");
assert.match(css, /\.report-viewer-content\s*>\s*\.md-report\s*\{[\s\S]*?overflow:\s*auto;/, "report body should own vertical scrolling for long reports");
assert.match(css, /\.md-report img\s*\{[\s\S]*?max-width:\s*min\(420px,\s*100%\);/, "report images should be constrained inside the reader");

window.document.querySelector('.nav-menu button[data-tab="workflow"]').click();
window.document.querySelector('.root-node[data-root-id="store_health"]').click();
await wait();
const pipText = window.document.getElementById("workflow-pip").textContent;
assert.match(pipText, /案件: 已生成报告/, "workflow PIP should expose case status");
assert.match(pipText, /最近运行: 已生成报告/, "workflow PIP should expose run status");
const taskText = [...window.document.querySelectorAll(".workflow-task-card")]
  .map((card) => card.textContent)
  .join("\n");
assert.match(taskText, /确认目标客群和主价格带/, "AI report should generate an actionable workflow task");
assert.equal(alertText, "", "successful dashboard run should not show fallback alert");

console.log(JSON.stringify({
  runStatus: run.status,
  caseStatus: storeCase.status,
  savedResults: storage.savedResults.length,
  reportCenterItems: window.document.querySelectorAll(".report-item").length,
  firstRoot: rootTitles[0],
}, null, 2));
