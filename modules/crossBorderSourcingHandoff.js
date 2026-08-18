const SOURCING_ACTION_IDS = new Set([
  "calculate_profit_guardrail",
  "filter_supplier_sources",
  "validate_opportunity_sourcing",
]);

// Keep this intent check specific enough that normal Etsy listing copy such as
// "supplier-provided material" does not unexpectedly leave the Etsy agent.
const SOURCING_INTENT_RE = /1688|淘宝|taobao|货源|寻源|采购|供应商筛选|筛选供应商|找供应商|寻找供应商|source suppliers?|supplier (?:sourcing|selection)|sourcing suppliers?|源头|工厂|拿样|比价|套利|采购直达|供货|批发|起批/i;
const LEGACY_SKILL_RE = /(?:domestic|etsy)_sourcing_finder|sourcing_finder/i;

export const CROSS_BORDER_SOURCING_CONTROL_CENTER_URL = "https://www.marqel.shop/operations.html";

export function isCrossBorderSourcingRequest({ actionId = "", skillPath = "", userInstruction = "" } = {}) {
  return SOURCING_ACTION_IDS.has(String(actionId || "")) ||
    LEGACY_SKILL_RE.test(String(skillPath || "")) ||
    SOURCING_INTENT_RE.test(String(userInstruction || ""));
}

export function buildCrossBorderSourcingHandoff({ actionId = "" } = {}) {
  const requestedAction = String(actionId || "").trim();
  return {
    type: "sourcing_handoff_required",
    status: "handoff_required",
    code: "SOURCING_MOVED_TO_MARQEL_ORCHESTRATOR",
    message: "1688/淘宝供应商筛选已从 Etsy Growth Agent 迁移到统一跨平台选品工作流，本次未启动旧 Etsy Agent Loop。",
    requestedAction,
    // Never echo the user's raw instruction into a cross-surface handoff. It
    // may contain credentials, tokens, or private product information.
    requestedInstruction: "",
    destination: {
      orchestratorSkill: "cross-border-sourcing-orchestrator",
      core: "supply-discover-core",
      runner: "supplier-sourcing-chrome-runner",
      controlCenterUrl: CROSS_BORDER_SOURCING_CONTROL_CENTER_URL,
      browser: "ordinary_chrome",
    },
    nextActions: [
      "在 Codex 对话中调用 $cross-border-sourcing-orchestrator，并提供目标平台、商品主图/链接和目标市场。",
      "由 Orchestrator 创建 operation_id 和 supplier_sourcing 任务，再由普通 Chrome Runner 登录 1688/淘宝并人工处理验证码。",
      "只在真实详情页证据满足门槛后进入 Control Center 商品审核；不要把搜索卡片当作已核验供应商。",
    ],
    safety: {
      publishAllowed: false,
      bypassCaptcha: false,
      platformCredentialsSharedWithEtsyAgent: false,
    },
  };
}
