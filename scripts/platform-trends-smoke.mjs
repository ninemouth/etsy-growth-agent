import assert from "node:assert/strict";
import {
  __testInternals,
  autoRepairFinalReportForDelivery,
  extractJSONBlock,
  isPlatformTrendSkill,
  validateReport,
} from "../modules/agentLoop.js";
import { hasValidGoogleTrendsEvidence } from "../modules/toolRegistry.js";

const skillId = "skills/etsy_platform_trends.skill.md";
assert.equal(isPlatformTrendSkill(skillId), true, "dedicated platform trend skill must be recognized");
assert.equal(
  __testInternals.searchEvidenceKey({ engine: "google_trends", searchType: "listing", query: "  “Personalized   Wedding Clutch” " }),
  "google_trends:listing:personalized wedding clutch",
  "trend search dedupe keys should ignore quote, case, and whitespace drift",
);
assert.equal(
  __testInternals.checkpointSkillMatches({ skillId: "skills/etsy_platform_trends.skill.md" }, "skills/etsy_global_shop_optimizer.skill.md"),
  false,
  "local latest checkpoint fallback must not restore a trend run into shop optimizer",
);
assert.equal(
  __testInternals.checkpointSkillMatches({}, "skills/etsy_global_shop_optimizer.skill.md"),
  false,
  "legacy checkpoints without skillId should not cross skill boundaries",
);
assert.equal(
  extractJSONBlock(JSON.stringify({
    ok: true,
    message: "Successfully navigated to product detail page.",
    tabId: 1936446025,
    url: "https://www.etsy.com/listing/1768235753/personalized-beaded-clutch-bag-gifts",
    title: "Personalized Beaded Clutch Bag Gifts",
    pageData: { h1: "Personalized Beaded Clutch Bag Gifts", pageType: "etsy_listing" },
    evidenceOk: true,
    screenshotCaptured: true,
    screenshotRef: "artifact://listing-detail-screenshot/1783987245123-abc123def",
    limitation: "Single competitor listing evidence - need at least one more for comparison",
  })),
  null,
  "bare listing detail tool result must not be accepted as a final trend report or successful JSON response",
);
assert.equal(hasValidGoogleTrendsEvidence({
  ok: true,
  searchUrl: "https://trends.google.com/trends/explore?date=today%2012-m&geo=US&q=wedding%20clutch",
  pageData: {
    url: "https://trends.google.com/trends/explore?date=today%2012-m&geo=US&q=wedding%20clutch",
    title: "Google Trends",
    visibleText: "Google Trends Explore",
  },
}), false, "Google Trends shell pages should not count as reliable trend evidence");
assert.equal(hasValidGoogleTrendsEvidence({
  ok: true,
  searchUrl: "https://trends.google.com/trends/explore?date=today%2012-m&geo=US&q=wedding%20clutch",
  pageData: {
    url: "https://trends.google.com/trends/explore?date=today%2012-m&geo=US&q=wedding%20clutch",
    title: "Google Trends",
    visibleText: "Google Trends Explore Interest over time Related queries Related topics",
  },
}), true, "Google Trends evidence should require core trend modules, not just the shell");

const pageContext = {
  url: "https://www.etsy.com/shop/ExampleShop",
  title: "ExampleShop - Etsy",
  visibleText: "Etsy shop wedding accessories listings and reviews",
  screenshot: "artifact://current-shop.png",
  research_scope: {
    entry_page_type: "own_shop",
    source_page_role: "self_reference",
    target_entity: {
      type: "shop",
      name: "ExampleShop",
      url: "https://www.etsy.com/shop/ExampleShop",
      is_self: true,
      confidence: "high",
    },
    seed_keywords: ["personalized wedding clutch"],
    scope_confidence: "high",
    page_role_notice: "当前页面识别为自营 Etsy 店铺，报告应服务于当前店铺增长。",
  },
};

const toolHistory = [
  {
    tool: "search_in_browser",
    arguments: { engine: "etsy", query: "personalized wedding clutch" },
    result: {
      ok: true,
      pageData: {
        url: "https://www.etsy.com/search?q=personalized%20wedding%20clutch",
        visibleText: "Etsy search results wedding clutch $35 bestseller",
        productCards: [{ href: "https://www.etsy.com/listing/1/wedding-clutch", shopUrl: "https://www.etsy.com/shop/TopWeddingStudio", title: "Personalized wedding clutch", price: "$35" }],
      },
    },
  },
  {
    tool: "search_in_browser",
    arguments: { engine: "google_trends", query: "personalized wedding clutch" },
    result: {
      ok: true,
      screenshotCaptured: true,
      screenshotRef: "artifact://google-trends-wedding-clutch.png",
      screenshotCaptureMode: "captureVisibleTab_viewport",
      evidence_quality: {
        load_state: "content_stable",
        stable_reads: 2,
        readiness_attempts: 6,
        readiness_elapsed_ms: 4200,
        risk: "low",
      },
      pageData: {
        url: "https://trends.google.com/trends/explore?geo=US&q=personalized%20wedding%20clutch",
        title: "Google Trends",
        visibleText: "Google Trends Explore Interest over time Related queries Related topics",
      },
    },
  },
  {
    tool: "search_in_browser",
    arguments: { engine: "google_us", query: "personalized wedding clutch" },
    result: { ok: true, pageData: { url: "https://www.google.com/search?q=personalized+wedding+clutch", visibleText: "Google US search results for personalized wedding clutch show bridal clutch, bridesmaid gift, custom name purse, wedding guest bag, satin evening bag, and Etsy marketplace pages as visible public demand-language samples." } },
  },
];

const competitorDetailHistory = [
  ...toolHistory,
  {
    tool: "navigate_to",
    arguments: { url: "https://www.etsy.com/listing/2/competitor-clutch" },
    result: {
      ok: true,
      evidenceOk: true,
      finalUrl: "https://www.etsy.com/listing/2/competitor-clutch",
      screenshotCaptured: true,
      screenshotRef: "artifact://competitor-detail-1.png",
      pageData: {
        url: "https://www.etsy.com/listing/2/competitor-clutch",
        title: "Personalized Bridal Clutch",
        h1: "Personalized Bridal Clutch",
        visibleText: "Price $49. Bestseller. Personalized bridal clutch with satin lining and wedding gift positioning.",
      },
    },
  },
  {
    tool: "navigate_to",
    arguments: { url: "https://www.etsy.com/listing/3/competitor-evening-bag" },
    result: {
      ok: true,
      evidenceOk: true,
      finalUrl: "https://www.etsy.com/listing/3/competitor-evening-bag",
      screenshotCaptured: true,
      screenshotRef: "artifact://competitor-detail-2.png",
      pageData: {
        url: "https://www.etsy.com/listing/3/competitor-evening-bag",
        title: "Beaded Evening Bag",
        h1: "Beaded Evening Bag",
        visibleText: "Price $58. Wedding guest evening bag with beaded detail, gift packaging and fast processing claims.",
      },
    },
  },
];

const trendState = __testInternals.getPlatformTrendEvidenceState(toolHistory);
assert.equal(trendState.searchStageComplete, true, "Etsy + Google Search + Google Trends screenshot should complete the trend search stage");
const stageRedirect = __testInternals.getPlatformTrendStageGuard({
  toolName: "search_in_browser",
  toolArgs: { engine: "google_us", query: "another wedding clutch keyword" },
  toolHistory,
});
assert.equal(stageRedirect.type, "redirect_tool_call", "after trend search evidence is complete, further search should redirect to competitor collection");
assert.equal(stageRedirect.toTool, "collect_etsy_competitor_shops", "trend state machine should move from search to competitor crawl");

const runawaySearchHistory = Array.from({ length: 8 }, (_, index) => ({
  tool: "search_in_browser",
  arguments: { engine: index % 2 === 0 ? "google_us" : "etsy", query: `wedding clutch loop ${index}` },
  result: { ok: false, pageData: { visibleText: "" }, evidenceStatus: "invalid_or_blocked" },
}));
const runawayGuard = __testInternals.getPlatformTrendStageGuard({
  toolName: "search_in_browser",
  toolArgs: { engine: "google_us", query: "wedding clutch loop 9" },
  toolHistory: runawaySearchHistory,
});
assert.equal(runawayGuard.type, "tool_error", "repeated trend search loops must stop before creating unbounded tool history");
assert.match(runawayGuard.error, /连续搜索循环|停止扩展关键词/, "runaway search guard should explain the stage problem instead of hiding it as a timeout");

const pollutedCheckpointHistory = [
  ...toolHistory,
  ...Array.from({ length: 40 }, (_, index) => ({
    tool: "search_in_browser",
    arguments: { engine: index % 3 === 0 ? "etsy" : index % 3 === 1 ? "google_us" : "google_trends", query: `polluted wedding clutch ${index}` },
    result: { ok: false, pageData: { visibleText: "" }, evidenceStatus: "invalid_or_blocked" },
  })),
];
const compactedCheckpoint = __testInternals.compactPlatformTrendRunawayToolHistory(pollutedCheckpointHistory);
assert.equal(compactedCheckpoint.changed, true, "polluted trend checkpoint history should be compacted on resume");
assert.ok(compactedCheckpoint.removedSearchCalls >= 20, "resume compaction should remove most repeated low-quality searches");
assert.equal(
  compactedCheckpoint.toolHistory.some((entry) => entry.tool === "workflow_stage_summary" && entry.result?.summaryType === "platform_trend_runaway_search_compaction"),
  true,
  "resume compaction should preserve an auditable stage summary",
);
assert.equal(
  __testInternals.getPlatformTrendEvidenceState(compactedCheckpoint.toolHistory).searchStageComplete,
  true,
  "resume compaction must preserve valid trend search evidence",
);

const ledger = [
  { source_type: "etsy_search", source_ref: "https://www.etsy.com/search?q=personalized%20wedding%20clutch", observed_value: "可见搜索结果包含婚礼手拿包商品卡片，样本中价格为 $35-$58。", used_for: "估计公开搜索样本价格带和标题词。", confidence: "medium", limitation: "仅覆盖 Etsy US 本轮可见搜索样本，不代表全平台分布。" },
  { source_type: "google_search", source_ref: "https://www.google.com/search?q=personalized+wedding+clutch", observed_value: "Google US 公开结果用于补充场景词和外部内容线索。", used_for: "辅助确定买家场景表达，不作为 Etsy 搜索量或转化率证明。", confidence: "low", limitation: "公开搜索结果受地区、时间和个性化影响，不能代表平台需求规模。" },
  { source_type: "google_trends", source_ref: "https://trends.google.com/trends/explore?geo=US&q=personalized%20wedding%20clutch", observed_value: "US、近 12 个月 Trends 页面可读，包含 Interest over time 和 related queries。", used_for: "验证关键词是否值得继续做季节性观察。", confidence: "medium", limitation: "未取得精确搜索量；相对热度不能直接等同 Etsy 订单需求。" },
  { source_type: "screenshot_visual", source_ref: "Google Trends 截图 https://trends.google.com/trends/explore?geo=US&q=personalized%20wedding%20clutch", observed_value: "截图显示可见时间范围和曲线方向，related queries 露出 bridal 场景词。", used_for: "解释趋势图和下一轮关键词验证方向。", confidence: "medium", limitation: "截图只能解释当前可见图表，不能证明显著峰值或转化率。" },
  { source_type: "page_dom", source_ref: "https://www.etsy.com/shop/TopWeddingStudio", observed_value: "公开竞品店铺页面文本显示婚礼配饰定位和商品结构。", used_for: "分析竞品定位和可见商品陈列。", confidence: "medium", limitation: "只代表公开页面，不包含竞品后台、订单或真实销量。" },
  { source_type: "screenshot_visual", source_ref: "竞品店铺截图 https://www.etsy.com/shop/TopWeddingStudio", observed_value: "首屏使用婚礼场景图和尺寸展示，商品网格强调个性化。", used_for: "对标竞品视觉和陈列方法。", confidence: "medium", limitation: "截图不证明点击率或转化率。" },
  { source_type: "page_dom", source_ref: "https://www.etsy.com/listing/2/competitor-clutch", observed_value: "公开竞品详情页文本显示价格、评价和定制说明。", used_for: "比较竞品详情页的信任信息和价格表达。", confidence: "medium", limitation: "页面可见信息不代表竞品完整 SKU 或后台数据。" },
  { source_type: "screenshot_visual", source_ref: "竞品商品详情截图 https://www.etsy.com/listing/2/competitor-clutch", observed_value: "画廊可见模特手持、包装和材质细节图。", used_for: "提炼详情页视觉信息结构。", confidence: "medium", limitation: "截图只覆盖当前可见画廊。" },
];

const validReport = {
  type: "final",
  output: {
    report_status: "completed",
    research_scope: pageContext.research_scope,
    page_role_notice: "当前页面识别为自营 Etsy 店铺，趋势结论必须说明当前店铺适配度。",
    fit_to_current_shop: {
      fit_level: "medium",
      reason: "店铺已有婚礼配饰语境，但仍需用自营 API 与 listing 实验验证真实点击和订单。",
      required_changes: ["优化首图", "补充 personalized 场景词", "验证 shipping cutoff"],
    },
    overview: "基于 Etsy US 公开搜索、Google Trends 和两个公开竞品页面的趋势机会观察。",
    analysis: "当前结论只描述公开样本和待验证方向，不把样本包装为全平台市场数据。",
    summary: "下一步用更多 Etsy 搜索页和店主自营数据验证点击、订单与履约结果。",
    data: [{
      opportunity_id: "T-1",
      keyword_or_category: "personalized wedding clutch",
      buyer_scenario: "新娘、伴娘和婚礼宾客寻找个性化晚宴包",
      price_band: { min: 35, max: 58, basis: "本轮 Etsy US 公开搜索可见样本" },
      demand_signal: "observed",
      seasonality: "Google Trends US 近 12 个月图表可读，季节方向需继续按月份验证。",
      competitor_signal: "两个公开竞品页面都强调婚礼场景、个性化和画廊细节。",
      next_validation_action: "扩展到第二页搜索样本，并安排真实指标实验，观察自营 Listing 的点击与订单变化。",
      evidence: "Etsy 搜索、Google Trends 截图和两个竞品详情页公开证据。",
      sample_count: 18,
      coverage: "Etsy US 搜索结果可见卡片与 2 个公开竞品详情页，不代表全平台",
      limitation: "未取得平台搜索量、竞品后台、竞品订单或转化率",
      growth_decision: {
        recommendation: "test",
        why: "公开样本显示 personalized wedding clutch 具备可见搜索和竞品视觉信号，但仍需当前店铺真实指标验证。",
        fit_to_current_shop: "medium",
        first_test: "选择 2 个现有婚礼包 listing 改标题、首图和 personalization 文案，运行 14 天观察。",
        minimum_evidence_to_continue: "收藏率、点击率或订单询盘相对基线改善，并且物流承诺可履约。",
        stop_condition: "14 天内无收藏/点击改善或出现履约/合规风险时停止扩 SKU。",
        estimated_effort: "medium",
        risk_level: "medium",
      },
      evidence_ledger: ledger,
    }],
  },
};

assert.deepEqual(validateReport(validReport, "", skillId, toolHistory, pageContext), [], "evidence-backed trend report should pass");

const missingTrendVisualLedger = structuredClone(validReport);
missingTrendVisualLedger.output.data[0].evidence_ledger = ledger.filter((entry) =>
  !(entry.source_type === "screenshot_visual" && /Google Trends|trends\.google/i.test(`${entry.source_ref} ${entry.observed_value}`))
);
assert.ok(
  validateReport(missingTrendVisualLedger, "", skillId, toolHistory, pageContext).some((error) => /Google Trends 截图视觉解读|趋势图视觉/.test(error)),
  "trend report without visual screenshot ledger should fail before auto repair",
);
const repairedTrendVisualLedger = autoRepairFinalReportForDelivery(missingTrendVisualLedger, { skillId, toolHistory, pageContext });
assert.equal(repairedTrendVisualLedger.changed, true, "auto repair should attach existing Google Trends screenshot evidence");
assert.deepEqual(
  validateReport(repairedTrendVisualLedger.parsed, "", skillId, toolHistory, pageContext),
  [],
  "auto repair should prevent non-substantive quality retry when Google Trends screenshot artifact exists",
);

const missingTrendToolLedger = structuredClone(validReport);
missingTrendToolLedger.output.data[0].evidence_ledger = ledger.filter((entry) =>
  entry.source_type !== "google_trends"
);
assert.ok(
  validateReport(missingTrendToolLedger, "", skillId, toolHistory, pageContext).some((error) => /缺少 google_trends/.test(error)),
  "trend report without google_trends tool ledger should fail before auto repair",
);
const repairedTrendToolLedger = autoRepairFinalReportForDelivery(missingTrendToolLedger, { skillId, toolHistory, pageContext });
assert.equal(repairedTrendToolLedger.changed, true, "auto repair should attach existing Google Trends tool evidence");
assert.equal(
  repairedTrendToolLedger.parsed.output.data[0].evidence_ledger.some((entry) => entry.source_type === "google_trends"),
  true,
  "auto repair should add a google_trends ledger entry when verified tool evidence exists",
);
assert.match(
  repairedTrendToolLedger.parsed.output.data[0].evidence_ledger.find((entry) => entry.source_type === "google_trends")?.observed_value || "",
  /证据质量：load_state=content_stable，stable_reads=2/,
  "auto repaired Google Trends ledger should preserve browser evidence quality",
);
assert.deepEqual(
  validateReport(repairedTrendToolLedger.parsed, "", skillId, toolHistory, pageContext),
  [],
  "auto repair should prevent Critic redo when only the google_trends ledger entry was omitted",
);

const implicitPlatformTrendReport = structuredClone(validReport);
implicitPlatformTrendReport.output.overview = "面向欧美婚礼礼品市场，基于公开平台样本给出婚礼季机会方向。";
implicitPlatformTrendReport.output.analysis = "当前只建议先做小流量实验，所有需求判断都限定为公开页面与截图证据范围。";
implicitPlatformTrendReport.output.data[0].seasonality = "婚礼季存在观察价值，下一步按月份持续验证。";
implicitPlatformTrendReport.output.data[0].evidence_ledger = ledger.filter((entry) =>
  entry.source_type !== "google_trends" && !(entry.source_type === "screenshot_visual" && /Google Trends|trends\.google/i.test(`${entry.source_ref} ${entry.observed_value}`))
);
const repairedImplicitPlatformTrend = autoRepairFinalReportForDelivery(implicitPlatformTrendReport, { skillId, toolHistory, pageContext });
assert.equal(
  repairedImplicitPlatformTrend.parsed.output.data[0].evidence_ledger.some((entry) => entry.source_type === "google_trends"),
  true,
  "platform trend reports should attach verified google_trends evidence even when the model uses Chinese seasonal wording",
);
assert.equal(
  repairedImplicitPlatformTrend.parsed.output.data[0].evidence_ledger.some((entry) => entry.source_type === "screenshot_visual" && /Google Trends|trends\.google/i.test(`${entry.source_ref} ${entry.observed_value}`)),
  true,
  "platform trend reports should attach verified Trends screenshot visual evidence when available",
);
assert.deepEqual(
  validateReport(repairedImplicitPlatformTrend.parsed, "", skillId, toolHistory, pageContext),
  [],
  "Chinese seasonal wording should not trigger a non-quality Critic redo when verified Trends evidence exists",
);

const missingMandatoryLedgers = structuredClone(validReport);
missingMandatoryLedgers.output.data[0].evidence_ledger = ledger.filter((entry) =>
  !["etsy_search", "google_search"].includes(entry.source_type) &&
  !/竞品|competitor|listing|shop/i.test(`${entry.source_ref} ${entry.observed_value} ${entry.used_for}`)
);
assert.ok(
  validateReport(missingMandatoryLedgers, "", skillId, competitorDetailHistory, pageContext).some((error) => /Etsy 公开搜索证据|google_search|竞品/.test(error)),
  "trend report with omitted mandatory ledgers should fail before auto repair",
);
const repairedMandatoryLedgers = autoRepairFinalReportForDelivery(missingMandatoryLedgers, { skillId, toolHistory: competitorDetailHistory, pageContext });
assert.equal(
  repairedMandatoryLedgers.parsed.output.data[0].evidence_ledger.some((entry) => entry.source_type === "etsy_search"),
  true,
  "auto repair should add Etsy search ledger from valid tool evidence",
);
assert.equal(
  repairedMandatoryLedgers.parsed.output.data[0].evidence_ledger.some((entry) => entry.source_type === "google_search"),
  true,
  "auto repair should add Google Search ledger from valid tool evidence for trend reports",
);
assert.equal(
  repairedMandatoryLedgers.parsed.output.data[0].evidence_ledger.filter((entry) => /竞品|competitor|listing|shop/i.test(`${entry.source_ref} ${entry.observed_value} ${entry.used_for}`)).length >= 2,
  true,
  "auto repair should add at least two competitor page/screenshot ledgers from opened detail pages",
);
assert.deepEqual(
  validateReport(repairedMandatoryLedgers.parsed, "", skillId, competitorDetailHistory, pageContext),
  [],
  "auto repair should prevent Critic redo when mandatory trend ledgers were omitted but tool evidence exists",
);

const trendToolHistoryWithoutScreenshot = toolHistory.map((entry) => {
  if (entry.tool !== "search_in_browser" || entry.arguments?.engine !== "google_trends") return entry;
  const cloned = structuredClone(entry);
  delete cloned.result.screenshotCaptured;
  delete cloned.result.screenshotRef;
  delete cloned.result.screenshotCaptureMode;
  return cloned;
});
const missingTrendToolLedgerNoScreenshot = structuredClone(validReport);
missingTrendToolLedgerNoScreenshot.output.data[0].evidence_ledger = ledger.filter((entry) =>
  entry.source_type !== "google_trends" && !(entry.source_type === "screenshot_visual" && /Google Trends|trends\.google/i.test(`${entry.source_ref} ${entry.observed_value}`))
);
const repairedTrendToolWithoutScreenshot = autoRepairFinalReportForDelivery(missingTrendToolLedgerNoScreenshot, { skillId, toolHistory: trendToolHistoryWithoutScreenshot, pageContext });
assert.equal(
  repairedTrendToolWithoutScreenshot.parsed.output.data[0].evidence_ledger.some((entry) => entry.source_type === "google_trends"),
  true,
  "auto repair should add google_trends ledger from valid Trends tool evidence even when screenshot artifact is missing",
);
assert.equal(
  repairedTrendToolWithoutScreenshot.parsed.output.data[0].evidence_ledger.some((entry) => entry.source_type === "screenshot_visual" && /Google Trends|trends\.google/i.test(`${entry.source_ref} ${entry.observed_value}`)),
  false,
  "auto repair must not invent Google Trends screenshot visual evidence when no screenshot artifact exists",
);
const noScreenshotErrors = validateReport(repairedTrendToolWithoutScreenshot.parsed, "", skillId, trendToolHistoryWithoutScreenshot, pageContext);
assert.equal(
  noScreenshotErrors.some((error) => /缺少 google_trends/.test(error)),
  false,
  "valid Trends tool evidence should prevent the misleading missing-google_trends Critic rejection",
);
assert.equal(
  noScreenshotErrors.some((error) => /Google Trends 截图视觉解读|趋势图视觉/.test(error)),
  true,
  "missing Trends screenshot should remain a separate visual-evidence failure",
);

const invalid = structuredClone(validReport);
invalid.output.overview = "Google Trends 显著峰值，需求旺盛，完整市场价格分布为 $21-$62。";
invalid.output.analysis = "竞品转化率更高，评论区常见物流痛点，香港发货 7-14 工作日。";
invalid.output.data[0].evidence_ledger = ledger.filter((entry) => !["google_trends", "screenshot_visual"].includes(entry.source_type));
invalid.output.data[0].limitation = "";
assert.ok(validateReport(invalid, "", skillId, toolHistory, pageContext).length >= 5, "unsupported trend claims must fail hard validation");

const privateApiClaim = structuredClone(validReport);
privateApiClaim.output.summary = "拉取 Etsy API 对比竞品转化率和订单。";
assert.ok(validateReport(privateApiClaim, "", skillId, toolHistory, pageContext).some((error) => /个人卖家 API|竞品后台|竞品订单/.test(error)), "private competitor API claims must be rejected");

const missingGrowthDecision = structuredClone(validReport);
delete missingGrowthDecision.output.data[0].growth_decision;
assert.ok(
  validateReport(missingGrowthDecision, "", skillId, toolHistory, pageContext).some((error) => /growth_decision\.recommendation/.test(error)),
  "trend opportunity items must include growth_decision so market research becomes an operator action",
);

const competitorAsOwnContext = {
  ...pageContext,
  research_scope: {
    entry_page_type: "competitor_shop",
    source_page_role: "competitor_reference",
    target_entity: { type: "shop", name: "TopWeddingStudio", url: "https://www.etsy.com/shop/TopWeddingStudio", is_self: false, confidence: "high" },
    seed_keywords: ["personalized wedding clutch"],
    scope_confidence: "high",
    page_role_notice: "当前页面识别为竞品 Etsy 店铺，只能作为公开对标样本。",
  },
};
const competitorAsOwnReport = structuredClone(validReport);
competitorAsOwnReport.output.research_scope = competitorAsOwnContext.research_scope;
competitorAsOwnReport.output.page_role_notice = "当前页面识别为竞品 Etsy 店铺。";
competitorAsOwnReport.output.summary = "你的店铺已经具备头部竞品的视觉优势。";
assert.ok(
  validateReport(competitorAsOwnReport, "", skillId, toolHistory, competitorAsOwnContext).some((error) => /竞品参考|自营店铺事实/.test(error)),
  "trend reports must not treat competitor pages as the user's own shop",
);

const weakHomeContext = {
  url: "https://www.etsy.com/",
  title: "Etsy",
  research_scope: {
    entry_page_type: "etsy_home",
    source_page_role: "platform_discovery",
    target_entity: { type: "unknown", name: "", url: "https://www.etsy.com/", is_self: false, confidence: "low" },
    seed_keywords: [],
    scope_confidence: "low",
    page_role_notice: "当前页面识别为 Etsy 首页，页面上下文较弱。",
  },
};
const weakHomeStrongReport = structuredClone(validReport);
weakHomeStrongReport.output.research_scope = weakHomeContext.research_scope;
weakHomeStrongReport.output.page_role_notice = "当前页面识别为 Etsy 首页。";
weakHomeStrongReport.output.overview = "Etsy 首页显示 personalized wedding clutch 高增长，需求旺盛。";
assert.ok(
  validateReport(weakHomeStrongReport, "", skillId, toolHistory, weakHomeContext).some((error) => /弱上下文|关键词|类目/.test(error)),
  "Etsy home trend runs without seed keywords must not emit strong trend conclusions",
);

const unsupportedShipping = structuredClone(validReport);
unsupportedShipping.output.data[0].summary = undefined;
unsupportedShipping.output.data[0].next_validation_action = "香港发货至美国 7-14 个工作日，立即承诺该时效。";
assert.ok(validateReport(unsupportedShipping, "", skillId, toolHistory, pageContext).some((error) => /实时物流|物流天数|发货地/.test(error)), "unsupported delivery promises must be rejected");

const unsupportedCertification = structuredClone(validReport);
unsupportedCertification.output.analysis = "普通婚礼手拿包必须具备 CE 和 FDA 认证。";
assert.ok(validateReport(unsupportedCertification, "", skillId, toolHistory, pageContext).some((error) => /CE|FDA|官方法规|认证/.test(error)), "unsupported default certification claims must be rejected");

console.log("platform trends smoke passed");
