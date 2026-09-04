// Marqel Etsy Edge v2 service worker.
// The extension is intentionally a narrow browser execution node. Planning,
// research, model calls, business settings and reporting live in Codex/Web.

import {
  controlCenterRequest,
  getActiveSession,
  getPendingDeviceAuthorization,
  pollDeviceAuthorization,
  signOut,
  startDeviceAuthorization,
} from "./modules/controlCenterAuth.js";
import { buildEdgeCapabilityPassport, classifyEtsySurface } from "./modules/browserAutomationCapabilities.js";
import { createEtsyAdsPowerTaskAdapter } from "./modules/etsyAdsPowerTaskAdapter.js";
import { openExtensionSurface } from "./modules/extensionSurface.js";
import { appendTaskLog, listTaskLogs, pruneTaskLogs, TASK_LOG_RETENTION } from "./modules/taskLogStore.js";

const CONTROL_CENTER_URL = "https://www.marqel.shop/listing.html";
const DEVICE_AUTH_ALARM = "marqel_edge_device_auth_poll";
const TASK_HEARTBEAT_ALARM = "marqel_edge_task_heartbeat";
const TASK_LOG_RETENTION_ALARM = "marqel_edge_task_log_retention";
const RETIRED_LOCAL_KEYS = [
  "apiKey", "llmProvider", "llmModel", "llmFallbackModels", "llmBaseUrl",
  "llmVisionModel", "temperature", "imageGenerationModel", "imageProvider",
  "imageBaseUrl", "imageApiKey", "savedResults", "monitorReports",
  "monitorTasks", "monitorChangeEvents", "growthActionRuns", "growthCases",
  "workflowCheckpoints", "workflowScheduler", "currencyRates",
];

const taskAdapter = createEtsyAdsPowerTaskAdapter({
  request: controlCenterRequest,
  storage: chrome.storage.local,
});

function storageRemove(keys) {
  return new Promise((resolve) => chrome.storage.local.remove(keys, resolve));
}

function publicSession(session = null) {
  if (!session) return null;
  return {
    user: session.user || null,
    expiresAt: Number(session.expiresAt || 0),
    refreshExpiresAt: Number(session.refreshExpiresAt || 0),
    authVersion: Number(session.authVersion || 2),
    clientId: String(session.clientId || "etsy-growth-agent"),
    deviceId: String(session.deviceId || ""),
    controlCenterOrigin: String(session.controlCenterOrigin || "https://www.marqel.shop"),
  };
}

function logEdge(event, message, context = {}, severity = "info") {
  return appendTaskLog({
    workflowId: String(context.operationId || context.taskId || "edge-node"),
    sessionId: String(context.taskId || ""),
    severity,
    category: "edge_runtime",
    event,
    message,
    context,
  });
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        const error = new Error(runtimeError.message || "Etsy page connection failed.");
        error.code = /context invalidated|receiving end does not exist/i.test(error.message)
          ? "EDGE_PAGE_REFRESH_REQUIRED"
          : "EDGE_PAGE_CONNECTION_FAILED";
        reject(error);
        return;
      }
      if (!response?.ok) {
        const error = new Error(response?.error || "The Etsy page rejected the governed operation.");
        error.code = response?.errorCode || "EDGE_PAGE_OPERATION_BLOCKED";
        reject(error);
        return;
      }
      resolve(response.result);
    });
  });
}

function isEtsyTab(tab = null) {
  try {
    return /(^|\.)etsy\.com$/i.test(new URL(String(tab?.url || "")).hostname);
  } catch (_) {
    return false;
  }
}

async function currentEtsyTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  return active || null;
}

async function capabilityPassport() {
  const [tab, session, activeTask] = await Promise.all([
    currentEtsyTab(),
    getActiveSession({ revalidate: false }).catch(() => null),
    taskAdapter.active({ refresh: false }).catch(() => null),
  ]);
  return buildEdgeCapabilityPassport({
    tab: tab || {},
    session: publicSession(session),
    activeTask,
    extensionVersion: chrome.runtime.getManifest().version,
  });
}

function countFieldStatuses(fieldResults = {}) {
  const counts = { appliedVerified: 0, manualRequired: 0, notRequested: 0 };
  Object.values(fieldResults || {}).forEach((entry) => {
    if (entry?.status === "applied_verified") counts.appliedVerified += 1;
    else if (entry?.status === "manual_required") counts.manualRequired += 1;
    else counts.notRequested += 1;
  });
  return counts;
}

async function applyApprovedDraft() {
  let tab = null;
  try {
    const verified = await taskAdapter.preflight();
    tab = await currentEtsyTab();
    if (!tab?.id || !isEtsyTab(tab)) {
      const error = new Error("请打开获批任务对应的 Etsy Listing 编辑页后再填充。");
      error.code = "ETSY_EDITOR_REQUIRED";
      throw error;
    }
    const result = await sendTabMessage(tab.id, {
      type: "APPLY_APPROVED_ETSY_DRAFT",
      listingDraft: verified.listingDraft,
    });
    if (result?.contractVersion !== "etsy-approved-draft-dom-write.v1"
      || result.listingDraftId !== verified.listingDraft.id
      || result.operationId !== verified.task.operationId
      || result.saveTriggered !== false
      || result.publicPublishPerformed !== false) {
      const error = new Error("页面返回结果与获批草稿不一致，已停止后续动作。");
      error.code = "ETSY_DRAFT_RESULT_INVALID";
      throw error;
    }
    await taskAdapter.checkpoint({
      stage: "approved_fields_applied_pending_human_save",
      pageUrl: result.sourceUrl,
      nextHumanAction: "逐字段检查后由人工保存为草稿；不要公开发布。",
    });
    await logEdge("approved_draft_applied", "获批 Listing 字段已填充，等待人工保存。", {
      taskId: verified.task.id,
      operationId: verified.task.operationId,
      fieldStatusCounts: countFieldStatuses(result.fieldResults),
      imageStatus: result.imageStatus || "unknown",
    });
    return result;
  } catch (error) {
    await logEdge("approved_draft_blocked", error.message, {
      taskId: "",
      operationId: "",
      errorCode: error.code || "ETSY_DRAFT_BLOCKED",
      pageClass: isEtsyTab(tab) ? "etsy" : "non_etsy",
    }, "warn");
    throw error;
  }
}

async function sha256Base64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function captureTaskEvidence() {
  const verified = await taskAdapter.preflight();
  const tab = await currentEtsyTab();
  if (!tab?.id || !isEtsyTab(tab)) {
    const error = new Error("请打开当前任务对应的 Etsy 页面后再保存现场证据。");
    error.code = "ETSY_PAGE_REQUIRED";
    throw error;
  }
  if (classifyEtsySurface(tab).type !== "listing_editor") {
    const error = new Error("当前任务只允许在匹配的 Etsy Listing 编辑器保存现场证据。" );
    error.code = "ETSY_EDITOR_REQUIRED";
    throw error;
  }
  let prepared = null;
  try {
    prepared = await sendTabMessage(tab.id, { type: "PREPARE_PRIVACY_SAFE_SCREENSHOT" });
    if (prepared?.contractVersion !== "etsy-screenshot-privacy-mask.v1" || prepared.blocked || !prepared.token) {
      const error = new Error(prepared?.blocked ? "当前 Etsy 页面属于敏感路径，禁止截图。" : "隐私遮罩未能就绪。");
      error.code = prepared?.blocked ? "SCREENSHOT_SENSITIVE_ROUTE_FORBIDDEN" : "SCREENSHOT_MASK_INVALID";
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 34));
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 70 });
    const [, base64 = ""] = String(dataUrl || "").split(",", 2);
    if (!base64) throw new Error("浏览器没有返回可用的现场截图。");
    const capturedAt = new Date().toISOString();
    const artifactResult = await controlCenterRequest(`/api/tasks/${encodeURIComponent(verified.task.id)}/artifacts`, {
      method: "POST",
      body: JSON.stringify({
        sourceUrl: prepared.sourceUrl,
        capturedAt,
        mimeType: "image/jpeg",
        encoding: "base64",
        contentBase64: base64,
        sha256: await sha256Base64(base64),
        redactionStatus: "verified",
      }),
    });
    await taskAdapter.checkpoint({
      state: "evidence_collected",
      stage: "privacy_safe_viewport_captured",
      pageUrl: prepared.sourceUrl,
      nextHumanAction: "继续核对获批字段；该截图只证明本次任务的可见 Etsy 现场。",
    });
    await logEdge("task_evidence_captured", "已保存任务绑定的隐私安全页面证据。", {
      taskId: verified.task.id,
      operationId: verified.task.operationId,
      artifactRef: artifactResult.artifact?.storageRef || "",
      maskedCount: Number(prepared.maskedCount || 0),
    });
    return {
      contractVersion: "marqel-edge-task-evidence.v2",
      taskId: verified.task.id,
      operationId: verified.task.operationId,
      artifactRef: artifactResult.artifact?.storageRef || "",
      capturedAt,
      maskedCount: Number(prepared.maskedCount || 0),
    };
  } finally {
    if (prepared?.token) {
      await sendTabMessage(tab.id, { type: "RESTORE_PRIVACY_SAFE_SCREENSHOT", token: prepared.token }).catch(() => {});
    }
  }
}

const TASK_HANDLERS = Object.freeze({
  ETSY_TASK_NEXT: () => taskAdapter.next(),
  ETSY_TASK_RESUMABLE: () => taskAdapter.resumable(),
  ETSY_TASK_CLAIM: (message) => taskAdapter.claim(message.taskId),
  ETSY_TASK_RESUME: (message) => taskAdapter.resume(message.task || null),
  ETSY_TASK_ACTIVE: () => taskAdapter.active(),
  ETSY_TASK_PREFLIGHT: () => taskAdapter.preflight(),
  ETSY_EDGE_PREPARE_NEXT: () => taskAdapter.prepareNext(),
  ETSY_TASK_APPLY_APPROVED_DRAFT: () => applyApprovedDraft(),
  ETSY_TASK_CAPTURE_EVIDENCE: () => captureTaskEvidence(),
  ETSY_TASK_HEARTBEAT: () => taskAdapter.heartbeat(),
  ETSY_TASK_CHECKPOINT: (message) => taskAdapter.checkpoint(message.checkpoint || {}),
  ETSY_TASK_PAUSE_FOR_VERIFICATION: (message) => taskAdapter.pauseForVerification(message.checkpoint || {}),
  ETSY_TASK_RECORD_UPLOADED: (message) => taskAdapter.recordUploaded(message.readback || {}),
  ETSY_TASK_RECORD_FAILED: (message) => taskAdapter.recordFailed(message.readback || {}),
  ETSY_TASK_RECONCILE: () => taskAdapter.reconcile(),
});

chrome.runtime.onMessage.addListener((message = {}, sender, sendResponse) => {
  if (message.type === "PING") {
    sendResponse({ ok: true, version: chrome.runtime.getManifest().version, role: "browser_edge_runtime" });
    return false;
  }

  if (Object.hasOwn(TASK_HANDLERS, message.type)) {
    Promise.resolve(TASK_HANDLERS[message.type](message))
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error.message, errorCode: error.code || "ETSY_TASK_ERROR" }));
    return true;
  }

  if (message.type === "AUTH_STATUS") {
    Promise.all([
      getActiveSession({ revalidate: message.revalidate === true }).catch(() => null),
      getPendingDeviceAuthorization().catch(() => null),
    ]).then(([session, pending]) => sendResponse({ ok: true, data: { session: publicSession(session), pending } }));
    return true;
  }

  if (message.type === "AUTH_DEVICE_START") {
    startDeviceAuthorization({ reopen: message.reopen === true })
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error.message, errorCode: error.code || "AUTH_START_FAILED" }));
    return true;
  }

  if (message.type === "AUTH_DEVICE_POLL") {
    pollDeviceAuthorization()
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error.message, errorCode: error.code || "AUTH_POLL_FAILED" }));
    return true;
  }

  if (message.type === "AUTH_LOGOUT") {
    signOut().then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "GET_EDGE_CAPABILITY_PASSPORT") {
    capabilityPassport().then((data) => sendResponse({ ok: true, data })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "GET_EDGE_NODE_STATUS") {
    Promise.all([
      capabilityPassport(),
      getActiveSession({ revalidate: false }).catch(() => null),
      taskAdapter.active().catch(() => null),
      listTaskLogs({ limit: 30 }),
    ]).then(([passport, session, activeTask, logs]) => sendResponse({
      ok: true,
      data: {
        schemaVersion: "marqel-etsy-edge-node-status.v2",
        generatedAt: new Date().toISOString(),
        version: chrome.runtime.getManifest().version,
        runtimeExtensionId: chrome.runtime.id,
        passport,
        session: publicSession(session),
        activeTask,
        logs,
      },
    })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "GET_TASK_LOGS") {
    listTaskLogs({ ...(message.filters || {}), limit: Math.min(Number(message.filters?.limit || 100), 300) })
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "OPEN_SIDEPANEL") {
    const tabId = sender?.tab?.id ?? message.tabId;
    openExtensionSurface(chrome, { tabId, view: message.view === "settings" ? "settings" : "main" })
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "OPEN_DASHBOARD") {
    const url = chrome.runtime.getURL("dashboard.html");
    chrome.tabs.create({ url, active: true }, (tab) => sendResponse({ ok: true, data: { tabId: tab?.id || null, url } }));
    return true;
  }

  if (message.type === "OPEN_CONTROL_CENTER") {
    chrome.tabs.create({ url: CONTROL_CENTER_URL, active: true }, (tab) => sendResponse({ ok: true, data: { tabId: tab?.id || null, url: CONTROL_CENTER_URL } }));
    return true;
  }

  return false;
});

chrome.action.onClicked.addListener((tab) => {
  openExtensionSurface(chrome, { tabId: tab?.id, view: "main" }).catch(() => {
    chrome.tabs.create({ url: chrome.runtime.getURL("sidepanel.html"), active: true });
  });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === DEVICE_AUTH_ALARM) {
    try { await pollDeviceAuthorization(); } catch (_) { /* surfaced on next explicit status check */ }
    return;
  }
  if (alarm.name === TASK_HEARTBEAT_ALARM) {
    try { await taskAdapter.heartbeat(); }
    catch (error) { await logEdge("task_heartbeat_failed", error.message, { errorCode: error.code || "HEARTBEAT_FAILED" }, "warn"); }
    return;
  }
  if (alarm.name === TASK_LOG_RETENTION_ALARM) await pruneTaskLogs(TASK_LOG_RETENTION);
});

chrome.runtime.onInstalled.addListener(async () => {
  await storageRemove(RETIRED_LOCAL_KEYS);
  chrome.alarms.create(DEVICE_AUTH_ALARM, { periodInMinutes: 1 });
  chrome.alarms.create(TASK_HEARTBEAT_ALARM, { periodInMinutes: 5 });
  chrome.alarms.create(TASK_LOG_RETENTION_ALARM, { periodInMinutes: 12 * 60 });
  await logEdge("edge_v2_installed", "Marqel Etsy Edge v2 已启用；旧研究与本地模型数据已移除。", {
    version: chrome.runtime.getManifest().version,
  });
});

chrome.alarms.create(DEVICE_AUTH_ALARM, { periodInMinutes: 1 });
chrome.alarms.create(TASK_HEARTBEAT_ALARM, { periodInMinutes: 5 });
chrome.alarms.create(TASK_LOG_RETENTION_ALARM, { periodInMinutes: 12 * 60 });
