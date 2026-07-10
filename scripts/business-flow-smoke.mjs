import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import {
  autoRepairFinalReportForDelivery,
  extractJSONBlock,
  sanitizeFinalReportForDelivery,
  validateReport,
} from "../modules/agentLoop.js";
import { hasValidEtsySearchEvidence } from "../modules/toolRegistry.js";

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const root = process.cwd();
const html = fs.readFileSync(path.join(root, "dashboard.html"), "utf8");
const js = fs.readFileSync(path.join(root, "dashboard.js"), "utf8");
const sidepanelSource = fs.readFileSync(path.join(root, "sidepanel.js"), "utf8");
const css = fs.readFileSync(path.join(root, "dashboard.css"), "utf8");
const backgroundSource = fs.readFileSync(path.join(root, "background.js"), "utf8");
const contentSource = fs.readFileSync(path.join(root, "content.js"), "utf8");
const agentLoopSource = fs.readFileSync(path.join(root, "modules", "agentLoop.js"), "utf8");
const toolRegistrySource = fs.readFileSync(path.join(root, "modules", "toolRegistry.js"), "utf8");
const shopOptimizerSkillSource = fs.readFileSync(path.join(root, "skills", "etsy_global_shop_optimizer.skill.md"), "utf8");

assert.match(agentLoopSource, /type:\s*"tool_heartbeat"/, "long-running tool calls should emit heartbeat progress");
assert.match(agentLoopSource, /etsyAgentCheckpoint:/, "agent loop should persist resumable workflow checkpoints");
assert.match(agentLoopSource, /CHECKPOINT_IMAGE_PLACEHOLDER/, "persisted checkpoints should omit base64 screenshot payloads");
assert.match(agentLoopSource, /type:\s*"checkpoint_restored"/, "agent loop should notify the UI when a checkpoint is restored");
assert.match(agentLoopSource, /lastNode:\s*"llm_response_received"/, "agent loop should checkpoint after receiving an LLM response");
assert.match(agentLoopSource, /status:\s*"tool_pending"[\s\S]*lastNode:\s*"tool_call_ready"/, "agent loop should checkpoint before executing a parsed tool call");
assert.match(agentLoopSource, /status:\s*"tool_guard_retry"/, "agent loop should checkpoint guard-driven retry nodes");
assert.match(agentLoopSource, /lastNode:\s*"max_steps_exceeded"/, "agent loop should checkpoint max-step failures before throwing");
assert.match(agentLoopSource, /resumeState\s*=\s*null/, "agent loop should accept workflow-level resume state from background storage");
assert.match(agentLoopSource, /onCheckpoint\s*=\s*null/, "agent loop should expose every saved node to workflow-level checkpoint storage");
assert.match(agentLoopSource, /不要重复已经完成的搜索、开页、筛选或已获得的工具证据/, "resume prompt should prevent repeating completed evidence work");
assert.match(backgroundSource, /WORKFLOW_CHECKPOINTS_KEY\s*=\s*"agentWorkflowCheckpoints"/, "background should persist workflow checkpoints in chrome.storage.local");
assert.match(backgroundSource, /buildWorkflowCheckpointKey[\s\S]*workflowSessionId[\s\S]*growthCaseId/, "workflow checkpoint lookup should support session and growth-case ids");
assert.match(backgroundSource, /lastStage:\s*"port_disconnected"/, "port disconnects should mark the workflow checkpoint as interrupted");
assert.match(backgroundSource, /status:\s*"interrupted"/, "background should preserve disconnected runs as resumable interrupted checkpoints");
assert.match(backgroundSource, /resumeState:\s*shouldResumeFromCheckpoint\s*\?/, "background should pass resumable workflow state into the agent loop");
assert.match(backgroundSource, /onCheckpoint:\s*async/, "background should persist checkpoint updates emitted by the agent loop");
assert.match(js, /interrupted:\s*"已保存断点"/, "dashboard should show interrupted runs as saved checkpoints");
assert.match(js, /后台连接中断，已保存断点，可再次运行继续。/, "dashboard disconnects should not be shown as ordinary failed runs");
assert.match(toolRegistrySource, /closedTabId/, "browser search should report automatically closed temporary tabs");
assert.match(toolRegistrySource, /shouldAutoCloseSearchTab[\s\S]*google_trends/, "Google and Trends search tabs should be auto-closed after evidence capture");
assert.match(toolRegistrySource, /hasValidEtsySearchEvidence/, "Etsy search evidence should have a runtime validity gate");
assert.match(toolRegistrySource, /\"google_trends\", \"bing\", \"etsy\"/, "Etsy search tabs should be auto-closed after evidence capture unless keepTab is set");
assert.match(contentSource, /extractEtsySearchCards/, "content script should extract Etsy-specific listing cards");
assert.match(contentSource, /pageHealth/, "content script should report page health for blocked or empty Etsy pages");
assert.match(js, /<html lang="zh-CN" dir="ltr">/, "PDF print template should declare Chinese language and stable text direction");
assert.match(js, /charset=UTF-8/, "PDF print template should force UTF-8 content type");
assert.match(js, /PingFang SC[\s\S]*Microsoft YaHei[\s\S]*Noto Sans CJK SC/, "PDF print template should include a Chinese font fallback stack");
assert.doesNotMatch(js, /const bodyHtml = marked\.parse\(rep\.content \|\| ""\);/, "report center PDF export should use sanitized shared markdown rendering");
assert.match(shopOptimizerSkillSource, /engine="etsy"[\s\S]*不允许作为最终交付/, "shop optimizer should require direct Etsy ranking/search evidence");
assert.match(shopOptimizerSkillSource, /engine="google_us"[\s\S]*engine="google_trends"[\s\S]*不允许作为最终交付/, "shop optimizer should require direct Google Search or Trends evidence");
assert.match(shopOptimizerSkillSource, /Etsy international shipping delivery time[\s\S]*禁止凭模型常识写“香港发货 7-12 工作日”/, "shop optimizer should require realtime logistics research before delivery-time claims");
assert.match(shopOptimizerSkillSource, /新店与垂直婚礼配饰店铺诊断专项规则/, "shop optimizer should include new-shop wedding accessory diagnosis rules");
assert.match(shopOptimizerSkillSource, /不能把“获取 5-10 个评价”写成孤立第一动作/, "shop optimizer should constrain review-building advice to compliant trust signals");
assert.match(backgroundSource, /etsy\\.com\\\/shop\\\//, "Etsy shop pages should route to the shop optimizer by default");
assert.match(agentLoopSource, /Etsy 站内搜索\/热卖榜\/高排名竞品店铺对标证据。该项不能降级为 assumption/, "critic should reject shop optimizer reports without real Etsy ranking evidence");
assert.match(agentLoopSource, /涉及配送\/物流\/时效判断，但缺少实时物流主题 google_search 证据/, "critic should reject logistics claims without realtime logistics search evidence");
assert.match(agentLoopSource, /选品机会书\/选品机会分析/, "critic should reject shop optimizer reports that are framed as opportunity books");
assert.match(agentLoopSource, /stage_fit/, "critic should require shop optimizer plans to explain stage fit");
assert.match(agentLoopSource, /buyer_scenario/, "critic should require shop optimizer plans to name the buyer scenario");
assert.match(sidepanelSource, /继续\|继续推进\|恢复\|resume\|continue/, "sidepanel should treat a plain continue message as a session resume request");

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

const shopOptimizerReportWithEtsyEvidence = {
  type: "final",
  output: {
    overview: "## Etsy 店铺优化诊断\n目标市场为Etsy 主要欧美礼品市场，当前为 B 级低评价成长店，需要补齐信任资产。",
    analysis: "已读取当前店铺页面文本和截图，并对标同类高排名竞品店铺。Google Search US 已验证 wedding clutch 站外表达。",
    summary: "优先执行 B-1 婚礼场景首图与标题改版，7 天后复盘点击和加购。",
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
        { source_type: "etsy_search", source_ref: "Etsy search: wedding clutch", observed_value: "高排名竞品店铺使用婚礼场景图、评价背书和 free shipping 标签", used_for: "对标竞品店铺方法", confidence: "medium", limitation: "搜索结果第一页样本" },
        { source_type: "google_search", source_ref: "Google Search US: wedding clutch", observed_value: "站外表达以 wedding clutch、bridesmaid gift clutch 为主", used_for: "验证标题词方向", confidence: "medium", limitation: "需要 Google Trends 二次确认季节性" },
      ],
      expected_impact: "提升点击率和加购信任。",
      first_actions: ["重做首图", "重写标题前 60 字", "补包装和尺寸图"],
      manual_confirmations: ["确认新首图已发布"],
      review_window: "7 天",
      risk_guard: "不得伪造评价或趋势数据。",
    }],
  },
};
const meaningfulPageContext = {
  url: "https://www.etsy.com/shop/MidnightReveriee",
  title: "MidnightReveriee - Etsy",
  visibleText: "MidnightReveriee wedding clutch bridesmaid gifts",
  screenshot: "data:image/jpeg;base64,mock",
  pageHealth: { hasMeaningfulDom: true, isLikelyBlocked: false },
};
const googleSearchHistory = { tool: "search_in_browser", arguments: { engine: "google_us", query: "wedding clutch" }, result: { ok: true, pageData: { visibleText: "wedding clutch search results" } } };
assert.notDeepEqual(
  validateReport(shopOptimizerReportWithEtsyEvidence, "", "skills/etsy_global_shop_optimizer.skill.md", [
    { tool: "search_in_browser", arguments: { engine: "etsy", query: "wedding clutch" }, result: invalidEtsySearchResult },
    googleSearchHistory,
  ], meaningfulPageContext),
  [],
  "shop optimizer critic should reject invalid or blocked Etsy search evidence"
);
assert.deepEqual(
  validateReport(shopOptimizerReportWithEtsyEvidence, "", "skills/etsy_global_shop_optimizer.skill.md", [
    { tool: "search_in_browser", arguments: { engine: "etsy", query: "wedding clutch" }, result: validEtsySearchResult },
    googleSearchHistory,
  ], meaningfulPageContext),
  [],
  "shop optimizer critic should accept valid Etsy listing/search evidence"
);
const shopOptimizerReportWithApiClaims = globalThis.structuredClone(shopOptimizerReportWithEtsyEvidence);
shopOptimizerReportWithApiClaims.output.data[0].recommendation = "待 Etsy API 复核 Sessions、订单、转化与 Etsy 自发货履约节奏后再扩大广告。";
const validShopEvidenceHistory = [
  { tool: "search_in_browser", arguments: { engine: "etsy", query: "wedding clutch" }, result: validEtsySearchResult },
  googleSearchHistory,
];
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

const run = storage.growthActionRuns[0];
assert.equal(run.status, "completed", "growth action run should complete");
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
