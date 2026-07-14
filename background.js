// background.js - Service Worker for etsy-growth-agent (ES Modules)

import { runAgentLoop } from './modules/agentLoop.js';
import { tools, resetSessionData } from './modules/toolRegistry.js';
import { callLLM } from './modules/llmClient.js';
import {
  acquireWorkflowLease,
  appendWorkflowEvent,
  clearWorkflowCancellation,
  loadWorkflowSnapshot,
  releaseWorkflowLease,
  renewWorkflowLease,
  requestWorkflowCancellation,
  saveWorkflowSnapshot,
} from './modules/workflowRuntime.js';
import { cleanupOwnedTabs, protectWorkflowTab } from './modules/browserSessionManager.js';
import {
  applyPendingRuntimeUpdate,
  checkForUpdates,
  ensureUpdateAlarm,
  getUpdateStatus,
  isUpdateAlarm,
  markRuntimeUpdateAvailable,
  saveUpdateSettings,
} from './modules/updateManager.js';
import {
  buildResearchScope,
  buildResearchScopeClarification,
  shouldClarifyResearchScope,
} from './modules/researchScope.js';

// ── Keep Service Worker Alive in MV3 ──
// Calling any Chrome API resets the 30-second idle timer in Manifest V3.
// We query storage every 10 seconds to keep the background service worker alive during long tasks.
setInterval(() => {
  chrome.storage.local.get(["keepAlive"], () => {
    if (chrome.runtime.lastError) {} // ignore
  });
}, 10000);

let activeWorkflowRuns = 0;

async function applyPendingUpdateIfIdle(reason = "idle") {
  if (activeWorkflowRuns > 0) return false;
  const updateState = await getUpdateStatus();
  if (updateState.settings.autoApplyRuntimeUpdates === false) return false;
  if (!updateState.status.runtimeUpdateAvailable) return false;
  await markRuntimeUpdateAvailable({
    version: updateState.status.pendingRuntimeVersion || "",
    autoApplyReason: reason,
  });
  await applyPendingRuntimeUpdate();
  return true;
}

// ── Open side panel when toolbar icon is clicked ──
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// ── Helper Utilities ──
async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function loadSkill(skillPath) {
  const url = chrome.runtime.getURL(skillPath);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load skill: ${skillPath} (${response.status})`);
  }
  return await response.text();
}

const ETSY_SKILL_PATHS = new Set([
  "skills/etsy_product_opportunity_explorer.skill.md",
  "skills/etsy_platform_trends.skill.md",
  "skills/etsy_sourcing_finder.skill.md",
  "skills/etsy_global_shop_optimizer.skill.md",
  "skills/etsy_operations_tracker.skill.md",
  "skills/etsy_listing_generator.skill.md",
  "skills/etsy_review_analyzer.skill.md",
  "skills/etsy_keyword_analysis.skill.md",
  "skills/etsy_compliance_auditor.skill.md",
]);

const GROWTH_ACTION_SKILL_MAP = {
  diagnose_store_growth: ["skills/etsy_global_shop_optimizer.skill.md"],
  diagnose_sku_funnel: ["skills/etsy_operations_tracker.skill.md", "skills/etsy_global_shop_optimizer.skill.md"],
  rewrite_listing: ["skills/etsy_listing_generator.skill.md"],
  analyze_keywords: ["skills/etsy_keyword_analysis.skill.md"],
  diagnose_visual_conversion: ["skills/etsy_global_shop_optimizer.skill.md", "skills/etsy_listing_generator.skill.md"],
  scan_competitor_changes: ["skills/etsy_global_shop_optimizer.skill.md"],
  analyze_review_defects: ["skills/etsy_review_analyzer.skill.md"],
  calculate_profit_guardrail: ["skills/etsy_sourcing_finder.skill.md"],
  filter_supplier_sources: ["skills/etsy_sourcing_finder.skill.md"],
  detect_fulfillment_risk: ["skills/etsy_operations_tracker.skill.md"],
  find_expansion_opportunities: ["skills/etsy_product_opportunity_explorer.skill.md"],
  explore_platform_trends: ["skills/etsy_platform_trends.skill.md"],
  create_growth_experiment: ["skills/etsy_operations_tracker.skill.md"],
  review_experiment_result: ["skills/etsy_operations_tracker.skill.md"],
  audit_compliance: ["skills/etsy_compliance_auditor.skill.md"],
};

function normalizeSkillPath(skillPath) {
  if (!skillPath || typeof skillPath !== "string") return "";
  const normalized = skillPath.replace(/^\/+/, "");
  return ETSY_SKILL_PATHS.has(normalized) ? normalized : "";
}

function pushUnique(list, item) {
  if (item && !list.includes(item)) list.push(item);
}

async function getActiveShopId() {
  const data = await new Promise((resolve) => chrome.storage.local.get(["activeShopId"], resolve));
  return data.activeShopId || "";
}

async function getResearchScopeStorage() {
  return await new Promise((resolve) => chrome.storage.local.get(["activeShopId", "etsyShops"], resolve));
}

async function cacheEtsyApiSnapshot(kind, args = {}, result = {}) {
  const shopId = args.shopId || await getActiveShopId();
  const payload = {
    shopId,
    dateFrom: args.dateFrom || result.dateFrom || "",
    dateTo: args.dateTo || result.dateTo || "",
    result,
    syncedAt: new Date().toISOString(),
    source: "etsy_seller_api",
  };
  const key = kind === "sku_analytics" ? "etsySkuAnalyticsSnapshot" : "etsyStoreSnapshotCache";
  await new Promise((resolve) => chrome.storage.local.set({ [key]: payload }, resolve));
  return payload;
}

// ── Etsy Intent Router & Dispatcher ──
async function dispatchEtsySkills(userInstruction, pageContext = {}) {
  const inst = String(userInstruction).toLowerCase();
  const pageUrl = String(pageContext?.url || "").toLowerCase();
  const pageTitle = String(pageContext?.title || "").toLowerCase();
  
  // Keyword mapping to detect which Etsy skills to load
  const matched = [];

  for (const [actionId, skillPaths] of Object.entries(GROWTH_ACTION_SKILL_MAP)) {
    if (inst.includes(actionId.replace(/_/g, " ")) || inst.includes(actionId)) {
      skillPaths.forEach((path) => pushUnique(matched, path));
      return matched;
    }
  }

  const hasShopOptimizationIntent =
    /店铺|卖家主页|seller|store|shop|运营方案|优化方案|店铺优化|店铺分析|店铺诊断|全店|abc|a\/b\/c|a-b-c|分级|整改|改版|增长方案|运营诊断|转化率|加购率|曝光|流量/.test(inst);
  const hasExplicitShopDiagnosisIntent =
    /店铺体检|全店体检|店铺诊断|店铺优化|店铺分析|abc|a\/b\/c|a-b-c|分级|整改|运营诊断|增长方案/.test(inst);
  const hasExplicitSourcingIntent =
    /1688|寻源|货源|采购|供应商|源头|工厂|拿样|比价|套利|采购直达|供货|批发|起批/.test(inst);
  const hasPlatformTrendIntent =
    /平台趋势|趋势|google trends|谷歌趋势|搜索趋势|季节性|需求曲线|平台需求|类目趋势|热卖|头部商品共性|价格带|评价门槛|趋势窗口|market trend|platform trend/i.test(inst);
  const hasProductOpportunityIntent =
    /选品|开发|类目|爆品|机会|牙刷|合规|eac|准入/.test(inst);
  const hasComplianceIntent =
    /合规|法规|认证|证书|侵权|商标|版权|cpc|cpsia|gpsr|reach|rohs|fcc|moCRA|禁售|安全审查|发布前审查/.test(inst);
  const hasKeywordIntent = /关键词|搜索词|keyword|seo|标签|tags?|标题词|长尾词|search intent/.test(inst);
  const isEtsyShopPage =
    /etsy\.com\/shop\//.test(pageUrl) ||
    /etsy\s+shop|shop\s+on\s+etsy|seller|店铺/.test(pageTitle);

  if (hasPlatformTrendIntent && !hasExplicitSourcingIntent && !hasExplicitShopDiagnosisIntent) {
    pushUnique(matched, "skills/etsy_platform_trends.skill.md");
    return matched;
  }

  if (isEtsyShopPage && !hasExplicitSourcingIntent && !hasProductOpportunityIntent && !hasPlatformTrendIntent) {
    pushUnique(matched, "skills/etsy_global_shop_optimizer.skill.md");
  }
  if (hasComplianceIntent) {
    pushUnique(matched, "skills/etsy_compliance_auditor.skill.md");
  }
  if (hasKeywordIntent) {
    pushUnique(matched, "skills/etsy_keyword_analysis.skill.md");
  }
  
  if (hasShopOptimizationIntent) {
    pushUnique(matched, "skills/etsy_global_shop_optimizer.skill.md");
  }

  if (hasProductOpportunityIntent && !hasShopOptimizationIntent && !hasComplianceIntent) {
    pushUnique(matched, "skills/etsy_product_opportunity_explorer.skill.md");
  }

  if (hasExplicitSourcingIntent) {
    pushUnique(matched, "skills/etsy_sourcing_finder.skill.md");
  }

  if (!hasShopOptimizationIntent && /etsy.*(店铺|卖家|运营|转化|流量|加购|整改|abc)|listing\s*诊断|标题诊断|主图诊断/.test(inst)) {
    pushUnique(matched, "skills/etsy_global_shop_optimizer.skill.md");
  }

  if (inst.includes("追踪") || inst.includes("监控") || inst.includes("阶段") || inst.includes("指标") || inst.includes("曝光") || inst.includes("转化") || inst.includes("成效")) {
    pushUnique(matched, "skills/etsy_operations_tracker.skill.md");
  }
  if (inst.includes("英文") || inst.includes("listing") || inst.includes("生成") || inst.includes("seo") || inst.includes("标题") || inst.includes("描述") || inst.includes("文案")) {
    pushUnique(matched, "skills/etsy_listing_generator.skill.md");
  }
  if (inst.includes("评论") || inst.includes("差评") || inst.includes("缺陷") || inst.includes("买家") || inst.includes("反馈") || inst.includes("退换")) {
    pushUnique(matched, "skills/etsy_review_analyzer.skill.md");
  }
  
  // If nothing matched, use LLM to classify or load a default set
  if (matched.length === 0) {
    try {
        const classificationPrompt = [
        {
          role: "system",
          content: `你是一个 Etsy 跨境电商运营智能路由器。请根据用户的输入需求，从以下 9 个专有 AI 技能路径中选择所有最相关的技能路径：
1. "skills/etsy_product_opportunity_explorer.skill.md" (Etsy选品、类目需求分析、合规性风险审计)
2. "skills/etsy_sourcing_finder.skill.md" (1688货源开发、美元跨境利润套利测算、运费关税核算)
3. "skills/etsy_global_shop_optimizer.skill.md" (Etsy店铺经营诊断、自营 listings/订单/发货资料对账、ABC分级优化)
4. "skills/etsy_operations_tracker.skill.md" (监控数据、对比优化阶段、流量曝光转化效果)
5. "skills/etsy_listing_generator.skill.md" (英文 SEO Title/Description 商品详情文案生成)
6. "skills/etsy_review_analyzer.skill.md" (买家原声差评剖析、退换货与商品缺陷分析)
7. "skills/etsy_compliance_auditor.skill.md" (Etsy 商品发布前合规、IP、产品安全与目的地法规审查)
8. "skills/etsy_keyword_analysis.skill.md" (Etsy 站内搜索词、买家意图和标签证据分析)
9. "skills/etsy_platform_trends.skill.md" (Etsy 平台公开搜索、Google Search/Trends 和趋势机会分析)

请直接输出一个包含路径字符串的 JSON 数组（例如：["skills/etsy_sourcing_finder.skill.md"]），不要包含任何其他说明字符，格式必须是标准的 JSON 数组。`
        },
        {
          role: "user",
          content: `用户的输入指令是: "${userInstruction}"`
        }
      ];
      
      const response = await callLLM(classificationPrompt);
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const arr = JSON.parse(jsonMatch[0].trim());
        if (Array.isArray(arr) && arr.length > 0) {
          return arr;
        }
      }
    } catch (e) {
      console.warn("LLM classification routing failed, falling back to default:", e.message);
    }
    
    // Default fallback
    pushUnique(matched, "skills/etsy_product_opportunity_explorer.skill.md");
  }
  
  return matched;
}

async function deleteResult(id) {
  const existing = await new Promise((resolve) =>
    chrome.storage.local.get(["savedResults"], resolve)
  );
  const filtered = (existing.savedResults || []).filter((r) => r.id !== id);
  await new Promise((resolve) => chrome.storage.local.set({ savedResults: filtered }, resolve));
}

async function exportResults() {
  const existing = await new Promise((resolve) =>
    chrome.storage.local.get(["savedResults"], resolve)
  );
  return existing.savedResults || [];
}

async function listSkills() {
  const knownSkills = [
    {
      id: "etsy_product_opportunity_explorer",
      path: "skills/etsy_product_opportunity_explorer.skill.md",
      name: "Etsy 多维智能选品决策专家 (Auto)",
      description: "一键分析当前商品或搜索页，提取欧美本土需求、CE/CPC/FDA/IP合规准入、泡货运费风险及痛点，输出高胜率爆品蓝图",
      icon: "🛍️",
    },
    {
      id: "etsy_platform_trends",
      path: "skills/etsy_platform_trends.skill.md",
      name: "Etsy 平台趋势与公开需求研究专家",
      description: "基于 Etsy 搜索、Google Search、Google Trends 和公开竞品页面分析平台级需求窗口，不把自营 API 数据冒充平台大盘",
      icon: "📊",
    },
    {
      id: "etsy_sourcing_finder",
      path: "skills/etsy_sourcing_finder.skill.md",
      name: "Etsy ➔ 1688 跨境选品供应链与套利审计专家 (Auto)",
      description: "自动对齐国内 1688 货源，精确核算Etsy 跨境国际段运费（Etsy 自发货）、关税及平台扣款，输出精确美元利润账本",
      icon: "💵",
    },
    {
      id: "etsy_global_shop_optimizer",
      path: "skills/etsy_global_shop_optimizer.skill.md",
      name: "Etsy 店铺运营多维对标与诊断优化专家 (Vision)",
      description: "分析 Etsy 店铺视觉陈列、商品结构、Seller API 指标、Etsy 大盘与Etsy 欧美趋势，输出 ABC 分级优化方案",
      icon: "🏬",
      apiBoundaryDescription: "分析 Etsy 店铺视觉陈列、商品结构、自营 listings/订单/发货资料与公开市场证据，输出 ABC 分级优化方案",
    },
    {
      id: "etsy_operations_tracker",
      path: "skills/etsy_operations_tracker.skill.md",
      name: "Etsy 运营优化追踪与分析诊断专家 (Auto)",
      description: "分析已绑定商品的历史指标快照（价格/转化率/评论），判定优化阶段，追踪改善情况并输出二次迭代意见",
      icon: "📈",
    },
    {
      id: "etsy_listing_generator",
      path: "skills/etsy_listing_generator.skill.md",
      name: "Etsy 英文 SEO Listing 智能生成专家",
      description: "基于当前 Etsy 页面、竞品搜索词或用户提供的供应商资料，生成符合 Etsy 规则的英文 Title、Description 和 Rich-Content",
      icon: "📦",
    },
    {
      id: "etsy_review_analyzer",
      path: "skills/etsy_review_analyzer.skill.md",
      name: "Etsy 英文评论痛点与缺陷审计专家",
      description: "深度解析 Etsy 页面上欧美买家的真实原声差评，归纳核心质量/包装/物流问题，提供备货改良指导",
      icon: "⭐",
    },
    {
      id: "etsy_keyword_analysis",
      path: "skills/etsy_keyword_analysis.skill.md",
      name: "Etsy SEO 关键词与搜索意图分析专家",
      description: "基于 Etsy 搜索、Google 搜索和趋势证据拆解关键词、长尾词、标签和买家场景，禁止凭空估算搜索量",
      icon: "🔎",
    },
    {
      id: "etsy_compliance_auditor",
      path: "skills/etsy_compliance_auditor.skill.md",
      name: "Etsy 商品合规与发布风险审查专家",
      description: "基于商品页面、截图和官方来源审查 Etsy 政策、IP、产品安全、标签与目的地法规风险，阻断高风险发布动作",
      icon: "🛡️",
    }
  ];

  const available = [];
  for (const skill of knownSkills) {
    try {
      const url = chrome.runtime.getURL(skill.path);
      const resp = await fetch(url);
      if (resp.ok) available.push({ ...skill, description: skill.apiBoundaryDescription || skill.description });
    } catch (_) {}
  }

  return { ok: true, skills: available };
}

// ── Port Connection Handling (Streaming Progress) ──
const activePorts = new Map();
const WORKFLOW_CHECKPOINTS_KEY = "agentWorkflowCheckpoints";
const COMPLIANCE_DECISIONS_KEY = "etsyComplianceDecisions";
const COMPLIANCE_DECISION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function normalizeComplianceResourceKey(url = "") {
  try {
    const parsed = new URL(String(url || ""));
    parsed.hash = "";
    parsed.search = "";
    return `${parsed.origin}${parsed.pathname.replace(/\/$/, "")}`;
  } catch (_) {
    return String(url || "").split(/[?#]/)[0].replace(/\/$/, "");
  }
}

function complianceContextText(pageContext = {}, userInstruction = "") {
  return [
    userInstruction,
    pageContext?.url,
    pageContext?.title,
    pageContext?.h1,
    pageContext?.visibleText,
    pageContext?.text,
  ].filter(Boolean).join(" ");
}

function isComplianceSensitiveContext(pageContext = {}, userInstruction = "") {
  return /儿童|婴童|玩具|baby|child|kid|toy|cosmetic|化妆品|护肤|香氛|食品接触|餐厨|food contact|电器|灯具|电池|battery|electrical|电子|充电|品牌|商标|版权|角色|球队|影视|designer|trademark|copyright|ip|CE|CPC|FDA|FCC|RoHS|REACH|危险品|禁售/i.test(complianceContextText(pageContext, userInstruction));
}

function requiresComplianceGate({ message = {}, matchedSkills = [], pageContext = {} } = {}) {
  const actionId = String(message.growthActionId || "");
  const skills = matchedSkills.join("+");
  if (skills.includes("etsy_compliance_auditor") || actionId === "audit_compliance") return false;
  const actionRequiresGate = [
    "rewrite_listing",
    "filter_supplier_sources",
    "calculate_profit_guardrail",
    "find_expansion_opportunities",
  ].includes(actionId);
  const skillRequiresGate = /etsy_listing_generator|etsy_sourcing_finder/.test(skills);
  return (actionRequiresGate || skillRequiresGate) && isComplianceSensitiveContext(pageContext, message.userInstruction);
}

async function getComplianceDecision(url = "") {
  const key = normalizeComplianceResourceKey(url);
  if (!key) return null;
  const data = await new Promise((resolve) => chrome.storage.local.get([COMPLIANCE_DECISIONS_KEY], resolve));
  const decision = (data[COMPLIANCE_DECISIONS_KEY] || {})[key] || null;
  if (!decision) return null;
  const checkedAt = Date.parse(decision.checkedAt || "");
  if (!Number.isFinite(checkedAt) || Date.now() - checkedAt > COMPLIANCE_DECISION_TTL_MS) return null;
  return decision;
}

async function saveComplianceDecision({ pageUrl = "", result = {}, workflowId = "" } = {}) {
  const key = normalizeComplianceResourceKey(pageUrl);
  if (!key || !result || typeof result !== "object") return;
  const items = Array.isArray(result.data) ? result.data : [];
  const levels = items.map((item) => String(item?.risk_level || "").toLowerCase()).filter(Boolean);
  const decisions = items.map((item) => String(item?.publish_decision || "").toLowerCase()).filter(Boolean);
  if (!levels.length && !decisions.length) return;
  const riskRank = { low: 1, medium: 2, high: 3, blocked: 4 };
  const decisionRank = { proceed: 1, proceed_after_evidence: 2, blocked: 3 };
  const riskLevel = levels.sort((a, b) => (riskRank[b] || 0) - (riskRank[a] || 0))[0] || "medium";
  const publishDecision = decisions.sort((a, b) => (decisionRank[b] || 0) - (decisionRank[a] || 0))[0] || "proceed_after_evidence";
  const data = await new Promise((resolve) => chrome.storage.local.get([COMPLIANCE_DECISIONS_KEY], resolve));
  const decisionsByKey = data[COMPLIANCE_DECISIONS_KEY] || {};
  decisionsByKey[key] = {
    pageUrl: key,
    riskLevel,
    publishDecision,
    checkedAt: new Date().toISOString(),
    workflowId,
    categories: [...new Set(items.map((item) => item?.category).filter(Boolean))].slice(0, 12),
  };
  const entries = Object.entries(decisionsByKey)
    .sort((a, b) => new Date(b[1]?.checkedAt || 0) - new Date(a[1]?.checkedAt || 0))
    .slice(0, 200);
  await new Promise((resolve) => chrome.storage.local.set({ [COMPLIANCE_DECISIONS_KEY]: Object.fromEntries(entries) }, resolve));
}

function buildWorkflowCheckpointKey({ tabId, matchedSkills = [], message = {} } = {}) {
  if (message.workflowSessionId) return String(message.workflowSessionId);
  if (message.growthCaseId) return `growth_case:${message.growthCaseId}`;
  const skillPart = matchedSkills.join("+") || normalizeSkillPath(message.skillPath) || "auto";
  const actionPart = message.growthActionId || "manual";
  return `tab:${tabId || "unknown"}:${actionPart}:${skillPart}`;
}

async function getWorkflowCheckpoints() {
  const data = await new Promise((resolve) => chrome.storage.local.get([WORKFLOW_CHECKPOINTS_KEY], resolve));
  return data[WORKFLOW_CHECKPOINTS_KEY] || {};
}

async function getWorkflowCheckpoint(key) {
  if (!key) return null;
  const runtime = await loadWorkflowSnapshot(key);
  if (runtime?.snapshot && Object.keys(runtime.snapshot).length > 0) {
    return {
      ...runtime.snapshot,
      status: runtime.status,
      lastStage: runtime.snapshot.lastStage || runtime.snapshot.lastNode || runtime.status,
      updatedAt: runtime.updatedAt,
    };
  }
  const checkpoints = await getWorkflowCheckpoints();
  return checkpoints[key] || null;
}

async function setWorkflowCheckpoint(key, patch = {}) {
  if (!key) return;
  const existingRuntime = await loadWorkflowSnapshot(key);
  const snapshot = {
    ...(existingRuntime?.snapshot || {}),
    ...patch,
    key,
  };
  const status = patch.status || existingRuntime?.status || "running";
  await saveWorkflowSnapshot(key, { status, snapshot });
  await appendWorkflowEvent(key, status, {
    step: patch.step,
    lastStage: patch.lastStage || patch.lastNode,
    toolName: patch.toolName,
  });

  // Compatibility index only. The durable messages/toolHistory snapshot is no
  // longer copied into chrome.storage.local on every checkpoint.
  const checkpoints = await getWorkflowCheckpoints();
  const previous = checkpoints[key] || {};
  checkpoints[key] = {
    ...previous,
    key,
    status,
    step: patch.step ?? previous.step,
    lastStage: patch.lastStage || patch.lastNode || previous.lastStage || status,
    skillId: patch.skillId || previous.skillId,
    workflowSessionId: patch.workflowSessionId || previous.workflowSessionId,
    growthCaseId: patch.growthCaseId || previous.growthCaseId,
    updatedAt: new Date().toISOString(),
  };
  const entries = Object.entries(checkpoints)
    .sort((a, b) => new Date(b[1].updatedAt || 0) - new Date(a[1].updatedAt || 0))
    .slice(0, 30);
  await new Promise((resolve) => chrome.storage.local.set({ [WORKFLOW_CHECKPOINTS_KEY]: Object.fromEntries(entries) }, resolve));
}

function isResumableCheckpoint(checkpoint) {
  return checkpoint && !["completed", "cancelled"].includes(checkpoint.status);
}

function isExplicitResumeRequest(message = {}) {
  if (message.forceNewSession) return false;
  if (message.continueSession) return true;
  return /^(继续|继续推进|恢复|resume|continue)$/i.test(String(message.userInstruction || "").trim());
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "etsy-agent-loop") {
    const portId = Date.now().toString();
    activePorts.set(portId, port);
    let isCancelled = false;
    let activeCheckpointKey = "";
    let runInFlight = false;
    let leaseRenewTimer = null;

    port.onDisconnect.addListener(() => {
      isCancelled = true;
      activePorts.delete(portId);
      if (activeCheckpointKey) {
        requestWorkflowCancellation(activeCheckpointKey, "port_disconnected").catch((err) => console.warn("Could not request workflow cancellation:", err.message));
        setWorkflowCheckpoint(activeCheckpointKey, {
          status: "interrupted",
          lastStage: "port_disconnected",
          interruptedAt: new Date().toISOString(),
        }).catch((err) => console.warn("Could not persist interrupted checkpoint:", err.message));
        releaseWorkflowLease(activeCheckpointKey, portId, "interrupted").catch((err) => console.warn("Could not release workflow lease:", err.message));
        cleanupOwnedTabs(activeCheckpointKey).catch((err) => console.warn("Could not cleanup owned tabs:", err.message));
      }
      console.log(`Port ${portId} disconnected.`);
    });

    port.onMessage.addListener(async (message) => {
      if (message.type === "CANCEL_WORKFLOW") {
        if (!activeCheckpointKey) {
          try {
            port.postMessage({
              type: "ERROR",
              error: "当前没有可暂停的运行中 workflow。",
              resumable: false,
            });
          } catch (_) {}
          return;
        }
        try {
          await requestWorkflowCancellation(activeCheckpointKey, message.reason || "user_paused");
          await setWorkflowCheckpoint(activeCheckpointKey, {
            status: "interrupted",
            lastStage: "user_paused",
            pausedAt: new Date().toISOString(),
            interruptionReason: "user_paused",
          });
          port.postMessage({
            type: "PROGRESS",
            data: {
              type: "workflow_timeout",
              step: 0,
              message: "已收到暂停请求，正在保存当前断点。当前工具或 AI 请求完成边界后会停止，可发送“继续”恢复。",
            },
          });
        } catch (err) {
          try {
            port.postMessage({
              type: "ERROR",
              error: `暂停失败：${err.message}`,
              resumable: true,
              resumeHint: "如已保存断点，可发送“继续”恢复。",
            });
          } catch (_) {}
        }
        return;
      }

      if (message.type === "RUN_SKILL") {
        if (runInFlight) {
          try {
            port.postMessage({
              type: "ERROR",
              error: "当前已有 workflow 正在执行。请等待当前任务完成，或发送“继续”恢复已保存断点，避免并发任务重复开页和重复调用 AI。",
              resumable: true,
            });
          } catch (_) {}
          return;
        }
        runInFlight = true;
        activeWorkflowRuns++;
        try {
          const tab = await getCurrentTab();
          if (!tab) throw new Error("无法获取当前活动的标签页，请确保浏览器焦点在目标网页上。");

          // Reset the session data cache at the start of a new run
          resetSessionData();

          // Step 1: Read current page context
          let pageContext = {};
          try {
            pageContext = await tools.read_current_page();
          } catch (err) {
            console.warn("Could not read page context:", err.message);
            if (err.message.includes("Receiving end does not exist") || err.message.toLowerCase().includes("connection") || err.message.toLowerCase().includes("context invalidated")) {
              throw new Error("检测到插件后台已重载或连接中断，请【刷新当前网页（按 F5）】后再次运行监控！");
            }
            if (err.message.includes("受 Chrome 安全策略限制") || err.message.includes("无法注入")) {
              throw err;
            }
          }

          if (message.targetImageUrl) {
            pageContext.targetImageUrl = message.targetImageUrl;
          }
          if (Array.isArray(pageContext.images) && pageContext.images.length > 0) {
            pageContext.targetImageCandidates = pageContext.images
              .map((img) => img.src)
              .filter(Boolean)
              .slice(0, 8);
            pageContext.targetImageCandidateDetails = pageContext.images
              .filter((img) => img.src)
              .slice(0, 8)
              .map((img) => ({
                src: img.src,
                alt: img.alt || "",
                roleHint: img.roleHint || "",
                searchScore: img.searchScore,
                displayScore: img.score,
                rect: img.rect,
              }));
            if (!pageContext.targetImageUrl) {
              pageContext.targetImageUrl = pageContext.targetImageCandidates[0];
            }
          }

          if (isCancelled) return;

          // Step 2: Capture screenshot for Vision models
          try {
            const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 60 });
            if (dataUrl) {
              pageContext.screenshot = dataUrl;
            }
          } catch (err) {
            console.warn("Could not capture screenshot:", err.message);
          }

          if (isCancelled) return;

          // Step 3: Load base auditor skill & dynamically dispatch Etsy skills
          let baseMarkdown = "";
          try {
            baseMarkdown = await loadSkill("skills/base_report_auditor.skill.md");
          } catch (err) {
            console.warn("Could not load base auditor skill:", err.message);
          }

          if (isCancelled) return;

          // ── Automatic Routing ──
          console.log(`🤖 Auto-routing user instruction: "${message.userInstruction}"`);
          const selectedSkillPath = normalizeSkillPath(message.skillPath);
          const growthActionSkills = Array.isArray(GROWTH_ACTION_SKILL_MAP[message.growthActionId])
            ? GROWTH_ACTION_SKILL_MAP[message.growthActionId]
            : null;
          const scopeStorage = await getResearchScopeStorage();
          pageContext.research_scope = buildResearchScope({
            pageContext,
            userInstruction: message.userInstruction || "",
            activeShopId: scopeStorage.activeShopId || "",
            shops: scopeStorage.etsyShops || [],
            selectedSkillPath,
            growthActionId: message.growthActionId || "",
          });
          const matchedSkills = growthActionSkills
            ? growthActionSkills
            : selectedSkillPath
            ? [selectedSkillPath]
            : await dispatchEtsySkills(message.userInstruction, pageContext);
          console.log("Matched Etsy skills:", matchedSkills);
          const isPlatformTrendRun = matchedSkills.some((skillPath) => /etsy_platform_trends/.test(skillPath));
          if (isPlatformTrendRun && shouldClarifyResearchScope(pageContext.research_scope)) {
            const clarification = buildResearchScopeClarification(pageContext.research_scope);
            port.postMessage({
              type: "CLARIFICATION_REQUIRED",
              result: clarification,
              skillId: matchedSkills.join("+"),
              skillName: "etsy_platform_trends",
            });
            activeCheckpointKey = "";
            return;
          }
          if (requiresComplianceGate({ message, matchedSkills, pageContext })) {
            const complianceDecision = await getComplianceDecision(pageContext.url || tab.url || "");
            if (!complianceDecision) {
              const error = new Error("当前商品涉及儿童、IP、化妆品、食品接触、电器、电池或其他敏感合规场景，必须先完成 Etsy 商品合规审查，再生成 Listing、采购建议或扩品方案。");
              error.code = "COMPLIANCE_AUDIT_REQUIRED";
              throw error;
            }
            if (["high", "blocked"].includes(complianceDecision.riskLevel) || complianceDecision.publishDecision === "blocked") {
              const error = new Error(`当前商品的合规决策为 ${complianceDecision.riskLevel}/${complianceDecision.publishDecision}，已阻断 Listing、采购和扩品动作。请先补齐证据并重新完成合规审查。`);
              error.code = "COMPLIANCE_ACTION_BLOCKED";
              throw error;
            }
            if (complianceDecision.publishDecision !== "proceed") {
              const error = new Error(`当前商品合规审查结果为 ${complianceDecision.riskLevel}/${complianceDecision.publishDecision}，尚未满足直接发布条件。请先完成 required_evidence 后再继续。`);
              error.code = "COMPLIANCE_EVIDENCE_REQUIRED";
              throw error;
            }
          }
          const checkpointKey = buildWorkflowCheckpointKey({ tabId: tab.id, matchedSkills, message });
          activeCheckpointKey = checkpointKey;
          protectWorkflowTab(checkpointKey, tab.id);
          const lease = await acquireWorkflowLease(checkpointKey, portId);
          if (!lease.ok) {
            throw new Error("该 workflow 当前已由另一个执行实例占用，请等待其结束或断点过期后再恢复。");
          }
          await clearWorkflowCancellation(checkpointKey);
          leaseRenewTimer = setInterval(() => {
            renewWorkflowLease(checkpointKey, portId).catch((err) => console.warn("Could not renew workflow lease:", err.message));
          }, 15_000);
          const existingCheckpoint = await getWorkflowCheckpoint(checkpointKey);
          const shouldContinueSession = isExplicitResumeRequest(message);
          const shouldResumeFromCheckpoint = shouldContinueSession && isResumableCheckpoint(existingCheckpoint);

          if (shouldResumeFromCheckpoint) {
            port.postMessage({
              type: "PROGRESS",
              data: {
                type: "reflection",
                step: existingCheckpoint.step || 0,
                message: `🔁 已找到可恢复工作流：${existingCheckpoint.lastStage || existingCheckpoint.lastNode || existingCheckpoint.status || "checkpoint"}。将沿用 ${existingCheckpoint.toolHistory?.length || 0} 条工具证据继续执行。`
              }
            });
          }

          // Notify user via progress stream
          const matchedNames = matchedSkills.map(p => {
            const parts = p.split("/");
            return parts[parts.length - 1].replace(".skill.md", "");
          });
          port.postMessage({
            type: "PROGRESS",
            data: {
              type: "thinking",
              step: 0,
              message: `🤖 [AI 智脑分流] 自动分析意图，调集底层运营能力: ${matchedNames.join(" + ")}`
            }
          });

          // Combine the system prompts of all matched skills
          let combinedSkillsMarkdown = baseMarkdown ? `${baseMarkdown}\n\n` : "";
          for (const skillPath of matchedSkills) {
            try {
              const content = await loadSkill(skillPath);
              combinedSkillsMarkdown += `\n\n=========================================\n\n${content}`;
            } catch (err) {
              console.warn(`Could not load matched skill: ${skillPath}`, err.message);
            }
          }

          const sendProgress = (progressData) => {
            if (isCancelled) return;
            port.postMessage({ type: "PROGRESS", data: progressData });
          };

          const result = await runAgentLoop({
            tabId: tab.id,
            skillId: matchedSkills.join("+"),
            skillMarkdown: combinedSkillsMarkdown,
            userInstruction: message.userInstruction,
            pageContext,
            sendProgress,
            continueSession: shouldContinueSession || shouldResumeFromCheckpoint,
            highRandomness: message.highRandomness,
            negativeFilter: message.negativeFilter,
            resumeState: shouldResumeFromCheckpoint ? existingCheckpoint : null,
            workflowId: checkpointKey,
            workflowGeneration: lease.generation,
            onCheckpoint: async (checkpoint) => {
              await setWorkflowCheckpoint(checkpointKey, {
                ...checkpoint,
                matchedSkills,
                skillPath: matchedSkills.join("+"),
                growthActionId: message.growthActionId || "",
                growthRunId: message.growthRunId || "",
                growthCaseId: message.growthCaseId || "",
                workflowSessionId: message.workflowSessionId || "",
                pageUrl: tab.url || "",
                pageTitle: tab.title || "",
                research_scope: pageContext.research_scope || null,
                researchScope: pageContext.research_scope || null,
              });
            },
          });

          if (!result?.ok && result?.type === "interrupted") {
            const qualityGateBlocked = result.qualityGateBlocked === true;
            await setWorkflowCheckpoint(checkpointKey, {
              status: qualityGateBlocked ? "quality_gate_blocked" : "interrupted",
              lastStage: qualityGateBlocked ? "quality_gate_blocked" : "agent_interrupted",
              interruptionReason: result.result || "workflow_interrupted",
              qualityGateBlocked,
              validationErrors: Array.isArray(result.validationErrors) ? result.validationErrors : [],
              interruptedAt: new Date().toISOString(),
            });
            port.postMessage({
              type: "INTERRUPTED",
              result,
              skillId: matchedSkills.join("+"),
              skillName: matchedNames.join(" + "),
              resumable: true,
              resumeHint: "已保存断点。发送“继续”从当前节点恢复。",
            });
            activeCheckpointKey = "";
            clearInterval(leaseRenewTimer);
            leaseRenewTimer = null;
            await releaseWorkflowLease(checkpointKey, portId, "interrupted");
            await cleanupOwnedTabs(checkpointKey);
            return;
          }

          if (!isCancelled) {
            if (matchedSkills.some((skillPath) => skillPath.includes("etsy_compliance_auditor"))) {
              await saveComplianceDecision({
                pageUrl: tab.url || pageContext.url || "",
                result: result.result,
                workflowId: checkpointKey,
              });
            }
            // Automatically save successful runs to savedResults
            let savedEntry = null;
            try {
              const existing = await new Promise((r) => chrome.storage.local.get(["savedResults"], r));
              const savedResults = existing.savedResults || [];
              
              const newEntry = {
                id: Date.now(),
                createdAt: new Date().toISOString(),
                skillId: matchedSkills.join("+"),
                skillName: matchedNames.map(name => name.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())).join(" + "),
                pageUrl: tab.url || "",
                pageTitle: tab.title || "",
                growthActionId: message.growthActionId || "",
                growthRunId: message.growthRunId || "",
                growthCaseId: message.growthCaseId || "",
                result: result.result // The parsed final output object containing overview, analysis, and data items
              };
              
              savedResults.unshift(newEntry);
              await new Promise((r) => chrome.storage.local.set({ savedResults: savedResults.slice(0, 100) }, r));
              savedEntry = newEntry;
              console.log("Successfully saved run results to savedResults database for dashboard.");
            } catch (saveErr) {
              console.error("Auto-saving run results to database failed:", saveErr.message);
            }

            port.postMessage({
              type: "SUCCESS",
              result: {
                ...result,
                skillId: matchedSkills.join("+"),
                skillName: matchedNames.join(" + "),
                savedEntry,
              }
            });
            await setWorkflowCheckpoint(checkpointKey, {
              status: "completed",
              completedAt: new Date().toISOString(),
              lastStage: "success_delivered",
            });
            activeCheckpointKey = "";
            clearInterval(leaseRenewTimer);
            leaseRenewTimer = null;
            await releaseWorkflowLease(checkpointKey, portId, "completed");
            await cleanupOwnedTabs(checkpointKey);
          }
        } catch (err) {
          if (activeCheckpointKey) {
            await setWorkflowCheckpoint(activeCheckpointKey, {
              status: "failed",
              error: err.message,
              lastStage: "error",
              failedAt: new Date().toISOString(),
            });
            if (leaseRenewTimer) clearInterval(leaseRenewTimer);
            leaseRenewTimer = null;
            releaseWorkflowLease(activeCheckpointKey, portId, "failed").catch((leaseErr) => console.warn("Could not release failed workflow lease:", leaseErr.message));
            cleanupOwnedTabs(activeCheckpointKey).catch((cleanupErr) => console.warn("Could not cleanup owned tabs:", cleanupErr.message));
            activeCheckpointKey = "";
          }
          if (!isCancelled) {
            port.postMessage({
              type: "ERROR",
              error: err.message,
              errorCode: err.code || "WORKFLOW_ERROR",
              resumable: true,
              resumeHint: "本次 workflow 已尽量保存断点。可输入“继续”恢复上次中断节点。",
            });
          }
        } finally {
          runInFlight = false;
          activeWorkflowRuns = Math.max(0, activeWorkflowRuns - 1);
          applyPendingUpdateIfIdle("workflow_completed").catch((err) => console.warn("Failed to apply pending update after workflow:", err.message));
        }
      }
    });
  }
});

// ── Standard Message Handlers (One-off Actions) ──
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "PING") {
    chrome.runtime.getPlatformInfo(() => {});
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "LIST_SKILLS") {
    listSkills().then(sendResponse).catch((err) => {
      sendResponse({ ok: false, error: err.message });
    });
    return true;
  }

  if (message.type === "GET_SAVED_RESULTS") {
    tools
      .get_saved_results({ limit: message.limit || 20 })
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === "DELETE_RESULT") {
    deleteResult(message.id)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === "EXPORT_RESULTS") {
    exportResults()
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === "GET_UPDATE_STATUS") {
    getUpdateStatus()
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === "CHECK_FOR_UPDATES") {
    checkForUpdates({ force: true })
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === "SAVE_UPDATE_SETTINGS") {
    saveUpdateSettings(message.settings || {})
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === "APPLY_PENDING_UPDATE") {
    applyPendingRuntimeUpdate()
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === "OPEN_DASHBOARD") {
    const dashboardUrl = chrome.runtime.getURL("dashboard.html");
    chrome.tabs.query({ url: dashboardUrl }, (existingTabs) => {
      if (existingTabs.length > 0) {
        chrome.tabs.update(existingTabs[0].id, { active: true });
        sendResponse({ ok: true, message: "Activated existing dashboard tab" });
      } else {
        chrome.tabs.create({ url: dashboardUrl, active: true }, () => {
          sendResponse({ ok: true, message: "Opened dashboard in new tab" });
        });
      }
    });
    return true;
  }

  if (message.type === "GET_ETSY_STORE_SNAPSHOT") {
    const args = message.args || {};
    tools
      .etsy_api_get_store_snapshot(args)
      .then(async (data) => {
        let cache = null;
        if (data?.result) {
          cache = await cacheEtsyApiSnapshot("store_snapshot", args, data.result);
        }
        sendResponse({ ok: data.ok, data, cache });
      })
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === "GET_ETSY_API_CAPABILITIES") {
    tools
      .etsy_api_get_capabilities()
      .then((data) => sendResponse({ ok: data.ok, data }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === "GET_ETSY_API_CONNECTION_STATUS") {
    tools
      .etsy_api_get_connection_status()
      .then((data) => sendResponse({ ok: data.ok, data }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === "GET_ETSY_SKU_ANALYTICS") {
    const args = {
      ...(message.args || {}),
      dimension: ["sku"],
      metrics: ["hits_view", "session_view", "ordered_units", "conv_tocart"]
    };
    tools
      .etsy_api_get_analytics(args)
      .then(async (data) => {
        let cache = null;
        if (data?.result) {
          cache = await cacheEtsyApiSnapshot("sku_analytics", args, data.result);
        }
        sendResponse({ ok: data.ok, data, cache });
      })
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === "PROCESS_ETSY_MONITOR_BASELINE") {
    tools
      .monitor_process_page_data({
        ...(message.args || {}),
        platform: "etsy"
      })
      .then((data) => sendResponse({ ok: data.ok, data }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === "TRIGGER_IMMEDIATE_MONITOR_RUN") {
    const tabId = sender.tab?.id;
    if (tabId) {
      chrome.tabs.sendMessage(tabId, { type: "READ_CURRENT_PAGE" }, async (res) => {
        if (res && res.ok && res.data) {
          const pageData = res.data;
          let items = [];
          if (pageData.productCards && pageData.productCards.length > 0) {
            items = pageData.productCards;
          }
          
          let creatorInfo = pageData.creatorInfo || null;
          if (!creatorInfo && pageData.url && pageData.url.includes("tiktok.com")) {
            const usernameMatch = pageData.url.match(/tiktok\.com\/@([a-zA-Z0-9._-]+)/);
            if (usernameMatch) {
              creatorInfo = {
                username: usernameMatch[1],
                fansCount: pageData.reviewCount || "0",
                likesCount: pageData.rating || "0",
                url: pageData.url
              };
            }
          }
          
          await tools.monitor_process_page_data({
            items,
            creatorInfo,
            platform: "tiktok"
          });
          
          const storage = await new Promise(r => chrome.storage.local.get(["monitorTasks"], r));
          const tasks = storage.monitorTasks || [];
          const taskExists = tasks.some(t => t.target_url === pageData.url);
          if (!taskExists) {
            const taskId = `task_${Date.now()}`;
            tasks.push({
              id: taskId,
              task_type: "shop_check",
              platform: "tiktok",
              target_type: creatorInfo ? "creator" : "shop",
              target_url: pageData.url,
              target_entity_key: creatorInfo ? `tiktok:creator:${creatorInfo.username}` : `tiktok:shop:${pageData.title}`,
              growthCaseId: `store_health_${(await getActiveShopId()) || "no_shop"}_shop`,
              frequency: "6h",
              last_run_at: new Date().toISOString(),
              status: "active"
            });
            await new Promise(r => chrome.storage.local.set({ monitorTasks: tasks }, r));
          }
          
          const dashboardUrl = chrome.runtime.getURL("dashboard.html");
          chrome.tabs.create({ url: dashboardUrl, active: true }, () => {
            sendResponse({ ok: true, message: "Added to monitor and opened dashboard" });
          });
        } else {
          sendResponse({ ok: false, error: "Failed to read page" });
        }
      });
      return true;
    }
  }
});

// ── Alarms Listener for Scheduled Background Monitoring Checks ──
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (isUpdateAlarm(alarm.name)) {
    try {
      await checkForUpdates();
      await applyPendingUpdateIfIdle("scheduled_check");
    } catch (err) {
      console.warn("Scheduled update check failed:", err.message);
    }
    return;
  }

  if (alarm.name.startsWith("monitor_task_")) {
    const taskJson = alarm.name.slice("monitor_task_".length);
    try {
      const task = JSON.parse(decodeURIComponent(taskJson));
      if (task && task.target_url) {
        console.log("Triggering scheduled background monitoring check for:", task.target_url);
        chrome.tabs.create({ url: task.target_url, active: false }, (newTab) => {
          let attempts = 0;
          const maxAttempts = 20; // 10 seconds timeout
          const checkInterval = setInterval(() => {
            attempts++;
            chrome.tabs.get(newTab.id, async (tabInfo) => {
              if (chrome.runtime.lastError || !tabInfo) {
                clearInterval(checkInterval);
                return;
              }
              if (tabInfo.status === "complete" || attempts >= maxAttempts) {
                clearInterval(checkInterval);
                try {
                  chrome.tabs.sendMessage(newTab.id, { type: "READ_CURRENT_PAGE" }, async (res) => {
                    if (res && res.ok && res.data) {
                      const pageData = res.data;
                      let items = [];
                      let creatorInfo = null;
                      let shopInfo = null;

                      const isEtsy = task.platform === "etsy";

                      if (isEtsy) {
                        if (task.target_type === "item") {
                          // Single Etsy product page check
                          items = [{
                            id: pageData.sku || pageData.id || pageData.url || task.target_url,
                            title: pageData.title || pageData.name || "Etsy Product",
                            price: pageData.price || 0,
                            sales: pageData.salesCount || pageData.sales || 0,
                            rating: pageData.rating || 0,
                            reviews: pageData.reviewCount || pageData.reviews || 0,
                            imgUrl: pageData.imageUrl || pageData.img || ""
                          }];
                        } else {
                          // Etsy shop check
                          if (pageData.productCards && pageData.productCards.length > 0) {
                            items = pageData.productCards.map(p => ({
                              id: p.id || p.product_link || Math.random().toString(),
                              title: p.title || p.name || "Etsy Product",
                              price: p.price || 0,
                              sales: p.sales || 0,
                              rating: p.rating || 0,
                              reviews: p.reviews || 0,
                              imgUrl: p.candidate_image_url || p.imgUrl || ""
                            }));
                          }
                          shopInfo = {
                            id: pageData.shopId || pageData.title || "Etsy Seller",
                            name: pageData.title || "Etsy Seller",
                            url: pageData.url || task.target_url
                          };
                        }
                      } else {
                        // Legacy TikTok handling
                        if (pageData.productCards && pageData.productCards.length > 0) {
                          items = pageData.productCards;
                        }
                        if (pageData.url && pageData.url.includes("tiktok.com")) {
                          const usernameMatch = pageData.url.match(/tiktok\.com\/@([a-zA-Z0-9._-]+)/);
                          if (usernameMatch) {
                            creatorInfo = {
                              username: usernameMatch[1],
                              fansCount: pageData.reviewCount || "0",
                              likesCount: pageData.rating || "0",
                              url: pageData.url
                            };
                          }
                        }
                      }

                      // Run data comparisons and trigger change events
                      await tools.monitor_process_page_data({
                        items,
                        creatorInfo,
                        shopInfo,
                        growthCaseId: task.growthCaseId || "",
                        platform: task.platform || "tiktok"
                      });

                      // Update last execution time for task
                      try {
                        const stored = await new Promise(r => chrome.storage.local.get(["monitorTasks"], r));
                        const storedTasks = stored.monitorTasks || [];
                        const matchTask = storedTasks.find(t => t.id === task.id);
                        if (matchTask) {
                          matchTask.last_run_at = new Date().toLocaleString();
                          await new Promise(r => chrome.storage.local.set({ monitorTasks: storedTasks }, r));
                        }
                      } catch (err) {
                        console.warn("Failed to update last_run_at for alarm task:", err.message);
                      }

                      console.log("Scheduled monitor check processed successfully for:", task.target_url);
                    }
                    chrome.tabs.remove(newTab.id);
                  });
                } catch (e) {
                  console.error("Scheduled check page extraction failed:", e);
                  chrome.tabs.remove(newTab.id);
                }
              }
            });
          }, 500);
        });
      }
    } catch (err) {
      console.error("Error running alarm task:", err);
    }
  }
});

// ── Initialize Default Settings on Installation ──
chrome.runtime.onInstalled.addListener(() => {
  ensureUpdateAlarm().catch((err) => console.warn("Failed to initialize update alarm:", err.message));
  chrome.storage.local.get(["llmProvider"], (data) => {
    if (!data.llmProvider) {
      chrome.storage.local.set({
        llmProvider: "qwen",
        llmModel: "qwen-max",
        temperature: "0.2",
        etsyTargetMargin: "20",
        etsyWarehouseType: "Etsy 自发货"
      });
    }
  });
});

chrome.runtime.onUpdateAvailable.addListener((details) => {
  markRuntimeUpdateAvailable(details)
    .then(() => applyPendingUpdateIfIdle("runtime_update_available"))
    .catch((err) => console.warn("Failed to handle runtime update availability:", err.message));
});
