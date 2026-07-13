import assert from "node:assert/strict";
import {
  __testInternals,
  autoRepairFinalReportForDelivery,
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
assert.deepEqual(
  validateReport(repairedTrendToolLedger.parsed, "", skillId, toolHistory, pageContext),
  [],
  "auto repair should prevent Critic redo when only the google_trends ledger entry was omitted",
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

const unsupportedShipping = structuredClone(validReport);
unsupportedShipping.output.data[0].summary = undefined;
unsupportedShipping.output.data[0].next_validation_action = "香港发货至美国 7-14 个工作日，立即承诺该时效。";
assert.ok(validateReport(unsupportedShipping, "", skillId, toolHistory, pageContext).some((error) => /实时物流|物流天数|发货地/.test(error)), "unsupported delivery promises must be rejected");

const unsupportedCertification = structuredClone(validReport);
unsupportedCertification.output.analysis = "普通婚礼手拿包必须具备 CE 和 FDA 认证。";
assert.ok(validateReport(unsupportedCertification, "", skillId, toolHistory, pageContext).some((error) => /CE|FDA|官方法规|认证/.test(error)), "unsupported default certification claims must be rejected");

console.log("platform trends smoke passed");
