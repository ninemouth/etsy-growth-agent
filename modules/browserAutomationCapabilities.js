// Browser automation capability contract for Etsy product workflows.
// This is intentionally conservative: it describes what the runtime can attempt,
// what it guarantees, and where a report must degrade or block.

export const BROWSER_AUTOMATION_CAPABILITIES = [
  {
    id: "task_bound_page_identity",
    label: "任务绑定的页面识别",
    tools: ["GET_EDGE_CAPABILITY_PASSPORT"],
    robustness: "strong",
    guarantees: [
      "只判断当前标签页是否为允许的 Etsy 现场",
      "敏感页面默认阻断",
      "页面识别本身不生成竞品、趋势或经营结论",
    ],
    limitations: [
      "公开页面只代表当前可见现场",
      "没有 Web 任务和授权引用时不得采集为业务证据",
    ],
  },
  {
    id: "approved_draft_fill",
    label: "获批 Listing 草稿填充",
    tools: ["ETSY_TASK_APPLY_APPROVED_DRAFT"],
    robustness: "human_gated",
    guarantees: [
      "只接受 Web 精确批准且带有效租约的 etsy-listing-draft.v1",
      "逐字段写入并验证页面值",
      "绝不点击保存或公开发布",
    ],
    limitations: [
      "Etsy DOM 变化、验证码与登录墙会阻断执行",
      "图片、类目和动态组件可能需要人工完成",
    ],
  },
  {
    id: "privacy_safe_task_evidence",
    label: "任务内隐私安全证据",
    tools: ["PREPARE_PRIVACY_SAFE_SCREENSHOT", "RESTORE_PRIVACY_SAFE_SCREENSHOT"],
    robustness: "human_gated",
    guarantees: [
      "账号、订单、付款、消息和验证码区域禁止或遮罩",
      "证据必须关联已批准任务和页面对象",
      "截图不触发分析或外发给第三方模型",
    ],
    limitations: [
      "只证明当前可见页面状态",
      "不能证明 Etsy 后台未显示的指标或全平台事实",
    ],
  },
  {
    id: "terminal_readback",
    label: "终态回读与对账",
    tools: ["ETSY_TASK_RECORD_UPLOADED", "ETSY_TASK_RECORD_FAILED", "ETSY_TASK_RECONCILE"],
    robustness: "strong",
    guarantees: [
      "记录 Etsy draft ID、URL、失败原因与时间",
      "回读 Artifact 与任务、operation、Listing 草稿一一关联",
      "不确定状态只允许对账，不允许重复页面动作",
    ],
    limitations: [
      "人工必须在可见 Etsy 页面确认草稿已保存",
      "读回失败不能自动重做写入",
    ],
  },
];

export const EDGE_CAPABILITY_PASSPORT_VERSION = "etsy-edge-capability-passport.v2";

const ETSY_HOST_RE = /(^|\.)etsy\.com$/i;
const LISTING_EDITOR_PATH_RE = /\/(?:your\/shops\/[^/]+\/(?:listing|listings)|your\/shops\/[^/]+\/tools\/listings|your\/listings|listing-manager|shop-manager\/listings|listing-editor)(?:\/|$)/i;
const SENSITIVE_ETSY_PATH_RE = /\/(?:account|signin|login|checkout|cart|payment|billing|security|messages?|conversations?|orders?|receipts?)(?:\/|$)/i;

export function classifyEtsySurface(tab = {}) {
  let parsed;
  try {
    parsed = new URL(String(tab.url || ""));
  } catch (_) {
    return { type: "unavailable", label: "未识别页面", evidenceAllowed: false, reason: "当前标签页没有可验证 URL。" };
  }
  if (!ETSY_HOST_RE.test(parsed.hostname)) {
    return { type: "external", label: "非 Etsy 页面", evidenceAllowed: false, reason: "打开 Etsy 店铺、Listing 或搜索页后才能建立现场证据。" };
  }
  if (LISTING_EDITOR_PATH_RE.test(parsed.pathname)) {
    return { type: "listing_editor", label: "Etsy Listing 编辑器", evidenceAllowed: true, reason: "只允许执行与当前任务匹配的获批字段填充与终态回读。" };
  }
  if (SENSITIVE_ETSY_PATH_RE.test(parsed.pathname)) {
    return { type: "sensitive", label: "敏感 Etsy 页面", evidenceAllowed: false, reason: "账号、订单、付款、消息和安全页面禁止采集为任务证据。" };
  }
  if (/\/your(?:\/|$)/i.test(parsed.pathname)) {
    return { type: "sensitive", label: "Etsy 卖家私域页面", evidenceAllowed: false, reason: "除 Listing 编辑器外，卖家后台页面不属于当前执行任务。" };
  }
  if (/\/listing\//i.test(parsed.pathname)) {
    return { type: "listing", label: "Etsy Listing", evidenceAllowed: true, reason: "可读取公开 Listing DOM；草稿写入仍要求精确审批任务。" };
  }
  if (/\/shop\//i.test(parsed.pathname)) {
    return { type: "shop", label: "Etsy 店铺", evidenceAllowed: true, reason: "可识别当前公开店铺；没有精确任务时不采集或分析。" };
  }
  if (/\/search(?:\/|$)/i.test(parsed.pathname) || parsed.searchParams.has("q")) {
    return { type: "search", label: "Etsy 搜索/类目", evidenceAllowed: true, reason: "可识别当前公开搜索页；没有精确任务时不采集或分析。" };
  }
  return { type: "etsy_public", label: "Etsy 公开页面", evidenceAllowed: true, reason: "可建立当前可见页面证据；具体动作取决于页面结构。" };
}

function capabilityState(state, label, reason) {
  return { state, label, reason };
}

export function buildEdgeCapabilityPassport({
  tab = {},
  session = null,
  activeTask = null,
  extensionVersion = "",
} = {}) {
  const surface = classifyEtsySurface(tab);
  const controlCenterBound = Boolean(session?.user);
  const active = activeTask?.task || activeTask || null;
  const taskBoundEvidenceState = !surface.evidenceAllowed
    ? surface.type === "sensitive" ? "blocked" : "unavailable"
    : surface.type !== "listing_editor"
      ? "wrong_surface"
      : active ? "ready" : "task_required";
  const approvedDraftState = surface.type !== "listing_editor"
    ? "wrong_surface"
    : controlCenterBound
      ? "approval_required"
      : "authorization_required";

  let nextAction = capabilityState("idle", "等待 Web 派发", "竞品研究、趋势判断和 Listing 规划由 Codex 与 Web 完成；插件只领取已批准的 Etsy 现场任务。");
  if (surface.type === "external" || surface.type === "unavailable") {
    nextAction = capabilityState("attention", "打开 Etsy 现场", surface.reason);
  } else if (surface.type === "sensitive") {
    nextAction = capabilityState("blocked", "离开敏感页面", surface.reason);
  } else if (active && surface.type !== "listing_editor") {
    nextAction = capabilityState("attention", "打开任务对应编辑器", "当前获批任务只能在可见的 Etsy Listing 编辑器继续。" );
  } else if (!controlCenterBound) {
    nextAction = capabilityState("attention", "连接 Control Center", "完成设备授权后才允许启动 Etsy Edge 任务；公开页面仍只做本地识别。" );
  } else if (active) {
    nextAction = capabilityState("active", "继续已领取任务", `当前 ${active.id || "Etsy 任务"} 等待页面执行或终态回读。`);
  }

  return {
    schemaVersion: EDGE_CAPABILITY_PASSPORT_VERSION,
    generatedAt: new Date().toISOString(),
    identity: {
      product: "Marqel Etsy Edge",
      role: "browser_edge_runtime",
      extensionVersion: String(extensionVersion || ""),
    },
    surface: {
      type: surface.type,
      label: surface.label,
      title: String(tab.title || "").slice(0, 120),
      evidenceAllowed: surface.evidenceAllowed,
      reason: surface.reason,
    },
    authority: {
      state: controlCenterBound ? "bound" : "local_only",
      label: controlCenterBound ? "Control Center 已授权" : "仅本地识别",
    },
    runtime: {
      state: active ? "active" : "idle",
      label: active ? "任务运行中" : "执行槽空闲",
      operationRef: active?.operationId || "",
    },
    evidence: {
      dom: capabilityState(taskBoundEvidenceState, "任务内页面证据", active ? surface.reason : "没有已批准任务时不建立业务证据。"),
      viewport: capabilityState(taskBoundEvidenceState, "隐私安全截图", active ? "只用于当前任务回读；不会发送给第三方模型。" : "没有已批准任务时不截图。"),
    },
    execution: {
      approvedDraft: capabilityState(approvedDraftState, "获批草稿填充", "只允许 etsy-listing-draft.v1；逐字段回读，不点击保存或发布。"),
      publishOrSpend: capabilityState("forbidden", "发布或花费", "公开发布、广告预算、采购、上传和下单始终不属于插件自主权限。"),
    },
    nextAction,
  };
}

export function summarizeBrowserAutomationCapabilities() {
  return BROWSER_AUTOMATION_CAPABILITIES.map((item) => ({
    id: item.id,
    label: item.label,
    tools: item.tools,
    robustness: item.robustness,
    guarantees: item.guarantees,
    limitations: item.limitations,
  }));
}

export function formatBrowserAutomationCapabilityPrompt() {
  return BROWSER_AUTOMATION_CAPABILITIES.map((item) => (
    `- ${item.label} (${item.robustness}): tools=${item.tools.join(", ")}; ` +
    `guarantees=${item.guarantees.join(" / ")}; limitations=${item.limitations.join(" / ")}`
  )).join("\n");
}
