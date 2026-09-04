const $ = (id) => document.getElementById(id);

function send(type, payload = {}) {
  return new Promise((resolve, reject) => {
    if (!globalThis.chrome?.runtime?.sendMessage) {
      reject(new Error("请从已加载的 Chrome 扩展中打开节点后台。"));
      return;
    }
    chrome.runtime.sendMessage({ type, ...payload }, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) { reject(new Error(runtimeError.message)); return; }
      if (!response?.ok) { reject(new Error(response?.error || "节点状态读取失败。")); return; }
      resolve(response.data);
    });
  });
}

function setStatus(element, text, state = "idle") {
  element.textContent = text;
  element.dataset.state = state;
}

function runBackground(operation) {
  Promise.resolve().then(operation).catch((error) => {
    setStatus($("nodeState"), "操作失败", "error");
    $("nextReason").textContent = error.message;
  });
}

function renderTask(record) {
  const task = record?.task || record || null;
  $("taskFacts").hidden = !task;
  if (!task) {
    setStatus($("taskBadge"), "无任务", "idle");
    $("taskSummary").textContent = "没有已领取任务。节点不会自行发起竞品分析、趋势研究或 Listing 改写。";
    $("taskState").textContent = "等待 Web 派发";
    $("readbackState").textContent = "等待任务";
    return;
  }
  const readback = task.publishReadback || record?.platformObservation || null;
  setStatus($("taskBadge"), record?.reconciliationRequired ? "必须对账" : "任务进行中", record?.reconciliationRequired ? "attention" : "active");
  $("taskSummary").textContent = record?.reconciliationRequired
    ? "已观察平台结果，但服务器终态不确定。禁止重复 Etsy 写入，只允许只读对账。"
    : "任务已绑定精确草稿版本、批准记录和执行租约；继续操作必须在同一条证据链内。";
  $("taskId").textContent = task.id || "—";
  $("operationId").textContent = task.operationId || "—";
  $("draftId").textContent = task.payload?.listingDraftId || "—";
  $("permissionRef").textContent = task.payload?.etsyAutomationPermissionRef || "—";
  $("taskStatusText").textContent = task.status || "—";
  $("terminalState").textContent = readback?.status || (record?.reconciliationRequired ? "待对账" : "尚未回读");
  $("taskState").textContent = record?.reconciliationRequired ? "待对账" : task.status || "进行中";
  $("readbackState").textContent = readback?.status || "尚未回读";
}

function renderLogs(logs = []) {
  const root = $("logRows");
  if (!logs.length) { root.innerHTML = '<p class="empty">暂无节点记录。</p>'; return; }
  root.replaceChildren(...logs.map((log) => {
    const row = document.createElement("div");
    row.className = "log-row";
    row.setAttribute("role", "row");
    const values = [
      new Date(log.createdAt).toLocaleString(),
      log.event || log.category || "edge_event",
      log.message || "—",
      log.workflowId || log.sessionId || "—",
    ];
    values.forEach((value) => {
      const cell = document.createElement("span");
      cell.textContent = value;
      row.append(cell);
    });
    return row;
  }));
}

async function refresh() {
  setStatus($("nodeState"), "读取中", "loading");
  try {
    const data = await send("GET_EDGE_NODE_STATUS");
    const passport = data.passport || {};
    $("headerVersion").textContent = data.version || "—";
    $("generatedAt").textContent = new Date(data.generatedAt).toLocaleString();
    $("nextAction").textContent = passport.nextAction?.label || "等待 Web 派发";
    $("nextReason").textContent = passport.nextAction?.reason || "没有获批任务时节点保持空闲。";
    $("surfaceState").textContent = passport.surface?.label || "未识别";
    $("authorityState").textContent = passport.authority?.label || "未连接";
    const state = passport.nextAction?.state === "blocked" ? "blocked"
      : passport.nextAction?.state === "active" ? "active"
        : passport.authority?.state === "bound" ? "ready" : "attention";
    setStatus($("nodeState"), state === "ready" ? "节点可用" : passport.nextAction?.label || "待处理", state);
    renderTask(data.activeTask);
    renderLogs(data.logs || []);
  } catch (error) {
    setStatus($("nodeState"), "节点不可用", "error");
    $("nextAction").textContent = "无法读取扩展运行时";
    $("nextReason").textContent = error.message;
    renderTask(null);
    renderLogs([]);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  $("refreshBtn").addEventListener("click", refresh);
  $("openSidepanelBtn").addEventListener("click", () => runBackground(() => send("OPEN_SIDEPANEL", { view: "main" })));
  [$("openWebBtn"), $("handoffWebBtn")].forEach((button) => button.addEventListener("click", () => runBackground(() => send("OPEN_CONTROL_CENTER"))));
  runBackground(refresh);
});
