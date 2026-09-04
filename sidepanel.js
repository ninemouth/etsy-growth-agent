const $ = (id) => document.getElementById(id);
let activeTaskRecord = null;

function send(type, payload = {}) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage({ type, ...payload }, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(/context invalidated/i.test(runtimeError.message || "")
            ? "扩展已更新，请关闭并重新打开侧边栏。"
            : runtimeError.message));
          return;
        }
        if (!response?.ok) {
          const error = new Error(response?.error || "请求未完成。");
          error.code = response?.errorCode || "EDGE_REQUEST_FAILED";
          reject(error);
          return;
        }
        resolve(response.data);
      });
    } catch (_) {
      reject(new Error("扩展已更新，请关闭并重新打开侧边栏。"));
    }
  });
}

function setStatus(element, text, state = "idle") {
  element.textContent = text;
  element.dataset.state = state;
}

function showMessage(text, kind = "info") {
  const box = $("taskMessage");
  box.textContent = String(text || "");
  box.dataset.kind = kind;
  box.hidden = false;
}

function runBackground(operation, onError = (error) => showMessage(error.message, "error")) {
  Promise.resolve().then(operation).catch(onError);
}

function showView(name) {
  document.querySelectorAll(".view").forEach((view) => view.classList.toggle("active", view.id === `view-${name}`));
  if (name === "settings") Promise.all([refreshAuth(), refreshBinding()]);
  else Promise.all([refreshPassport(), refreshTask(), refreshActivity()]);
}

function taskRecordTask(record = activeTaskRecord) {
  return record?.task || record || null;
}

function stageForTask(record) {
  const task = taskRecordTask(record);
  const stage = String(task?.checkpoint?.stage || record?.checkpoint?.stage || "");
  if (record?.reconciliationRequired || /readback|platform_draft_observed/.test(stage)) return "readback";
  if (/applied|human_save/.test(stage)) return "draft";
  if (/preflight/.test(stage)) return "preflight";
  return task ? "approval" : "";
}

function renderRail(stage) {
  const order = ["approval", "preflight", "draft", "readback"];
  const current = order.indexOf(stage);
  document.querySelectorAll("#taskRail li").forEach((item, index) => {
    item.classList.toggle("done", current > index);
    item.classList.toggle("active", current === index);
  });
}

async function refreshPassport() {
  try {
    const passport = await send("GET_EDGE_CAPABILITY_PASSPORT");
    $("passportSurface").textContent = passport.surface?.label || "未识别";
    $("passportAuthority").textContent = passport.authority?.label || "未连接";
    $("passportRuntime").textContent = passport.runtime?.label || "未知";
    $("passportNext").textContent = passport.nextAction?.label || "等待 Web";
    $("passportReason").textContent = passport.nextAction?.reason || passport.surface?.reason || "等待明确任务。";
    const state = passport.nextAction?.state === "blocked" ? "blocked"
      : passport.nextAction?.state === "active" ? "active"
        : passport.authority?.state === "bound" ? "ready" : "attention";
    setStatus($("passportState"), state === "ready" ? "可领取" : passport.nextAction?.label || "待处理", state);
  } catch (error) {
    setStatus($("passportState"), "连接失败", "error");
    $("passportReason").textContent = error.message;
  }
}

function renderTask(record, queuedTask = null) {
  activeTaskRecord = record || null;
  const task = taskRecordTask(record) || queuedTask;
  const facts = $("taskFacts");
  const hasActive = Boolean(record && taskRecordTask(record));
  const hasQueued = !hasActive && Boolean(queuedTask);
  facts.hidden = !task;
  if (task) {
    $("taskId").textContent = task.id || "—";
    $("operationId").textContent = task.operationId || "—";
    $("draftId").textContent = task.payload?.listingDraftId || "—";
    $("taskStatus").textContent = task.status || "—";
    $("taskProfileRef").textContent = task.payload?.browserProfileRef || "—";
    $("taskShopRef").textContent = task.payload?.etsyShopRef || "—";
  }

  if (record?.reconciliationRequired) {
    setStatus($("taskState"), "必须对账", "attention");
    $("taskSummary").textContent = "平台结果已观察，但 Web 终态尚不确定。只能进行只读对账，禁止重复写入。";
    $("taskSummary").dataset.state = "active";
  } else if (record?.pageMutation) {
    setStatus($("taskState"), "等待终态确认", "attention");
    $("taskSummary").textContent = "该任务的一次性页面写入已经开始，禁止再次填充。请检查当前 Etsy 页面，并回写草稿成功或失败终态。";
    $("taskSummary").dataset.state = "active";
  } else if (hasActive) {
    setStatus($("taskState"), "进行中", "active");
    $("taskSummary").textContent = `已领取 ${task.id}。继续当前 Etsy 草稿流程，所有动作都绑定 operation ${task.operationId}。`;
    $("taskSummary").dataset.state = "active";
  } else if (hasQueued) {
    setStatus($("taskState"), "等待领取", "attention");
    $("taskSummary").textContent = `Web 已派发 ${task.id}；领取后将重新核对授权、草稿版本和执行租约。`;
    $("taskSummary").dataset.state = "active";
  } else {
    setStatus($("taskState"), "无任务", "idle");
    $("taskSummary").textContent = "当前没有可执行任务。竞品研究与 Listing 方案应先在 Codex/Web 完成，再由 Web 派发精确草稿任务。";
    $("taskSummary").dataset.state = "idle";
  }

  const reconciliation = Boolean(record?.reconciliationRequired);
  const mutationAttempted = Boolean(record?.pageMutation);
  $("prepareBtn").disabled = hasActive || !hasQueued || reconciliation;
  $("applyBtn").disabled = !hasActive || reconciliation || mutationAttempted;
  $("captureBtn").disabled = !hasActive || reconciliation;
  $("pauseBtn").disabled = !hasActive || reconciliation;
  $("reconcileBtn").disabled = !hasActive || !reconciliation;
  $("recordUploadedBtn").disabled = !hasActive || reconciliation || !$("visibleConfirmation").checked;
  $("recordFailedBtn").disabled = !hasActive || reconciliation;
  renderRail(stageForTask(record) || (hasQueued ? "approval" : ""));
}

async function refreshTask() {
  try {
    const active = await send("ETSY_TASK_ACTIVE");
    if (active) {
      renderTask(active, null);
      return;
    }
    const next = await send("ETSY_TASK_NEXT");
    renderTask(null, next?.task || null);
  } catch (error) {
    renderTask(null, null);
    setStatus($("taskState"), "读取失败", "error");
    showMessage(error.message, "error");
  }
}

async function runTask(button, operation, successText) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "处理中…";
  try {
    const result = await operation();
    showMessage(successText, "success");
    await Promise.all([refreshTask(), refreshPassport(), refreshActivity()]);
    return result;
  } catch (error) {
    showMessage(error.code === "EDGE_PAGE_REFRESH_REQUIRED" ? "扩展已更新，请刷新 Etsy 页面后重试。" : error.message, "error");
    await refreshTask();
    return null;
  } finally {
    button.textContent = original;
  }
}

async function refreshActivity() {
  const list = $("activityList");
  try {
    const logs = await send("GET_TASK_LOGS", { filters: { limit: 8 } });
    if (!logs?.length) {
      list.innerHTML = '<li class="empty">暂无执行记录。</li>';
      return;
    }
    list.replaceChildren(...logs.map((log) => {
      const item = document.createElement("li");
      const title = document.createElement("strong");
      const meta = document.createElement("span");
      title.textContent = log.message || log.event || "Edge 事件";
      meta.textContent = `${new Date(log.createdAt).toLocaleString()} · ${log.severity || "info"}`;
      item.append(title, meta);
      return item;
    }));
  } catch (error) {
    list.replaceChildren();
    const item = document.createElement("li");
    item.className = "empty";
    item.textContent = error.message;
    list.append(item);
  }
}

async function refreshAuth() {
  try {
    const data = await send("AUTH_STATUS");
    const session = data?.session;
    const pending = data?.pending;
    if (session?.user) {
      const label = session.user.email || session.user.name || session.user.id || "已授权设备";
      setStatus($("authState"), "已连接", "ready");
      $("authSummary").textContent = `${label} · 授权仅用于读取 Web 批准任务和回写终态。`;
      $("authorizeBtn").hidden = true;
      $("pollAuthBtn").hidden = true;
      $("logoutBtn").hidden = false;
      $("deviceCode").hidden = true;
    } else if (pending) {
      setStatus($("authState"), "等待批准", "attention");
      $("authSummary").textContent = "已在 Web 打开设备批准页。批准后返回这里重新检查。";
      $("deviceCode").textContent = pending.userCode || "等待批准";
      $("deviceCode").hidden = false;
      $("authorizeBtn").hidden = true;
      $("pollAuthBtn").hidden = false;
      $("logoutBtn").hidden = true;
    } else {
      setStatus($("authState"), "未连接", "attention");
      $("authSummary").textContent = "连接 Marqel 设备身份后，插件才能领取精确批准的 Etsy 任务。";
      $("deviceCode").hidden = true;
      $("authorizeBtn").hidden = false;
      $("pollAuthBtn").hidden = true;
      $("logoutBtn").hidden = true;
    }
  } catch (error) {
    setStatus($("authState"), "检查失败", "error");
    $("authSummary").textContent = error.message;
  }
  $("extensionVersion").textContent = chrome.runtime.getManifest().version;
  $("runtimeId").textContent = chrome.runtime.id;
}

async function refreshBinding() {
  try {
    const data = await send("GET_EDGE_BINDING");
    const binding = data?.binding;
    $("bindingProfileRef").value = binding?.browserProfileRef || "";
    $("bindingShopRef").value = binding?.etsyShopRef || "";
    setStatus($("bindingState"), binding ? "已绑定" : "未绑定", binding ? "ready" : "attention");
  } catch (error) {
    setStatus($("bindingState"), "读取失败", "error");
    $("bindingMessage").textContent = error.message;
    $("bindingMessage").dataset.kind = "error";
    $("bindingMessage").hidden = false;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  showView(location.hash === "#settings" ? "settings" : "main");
  $("settingsBtn").addEventListener("click", () => { location.hash = "settings"; showView("settings"); });
  $("backBtn").addEventListener("click", () => { location.hash = ""; showView("main"); });
  $("refreshPassportBtn").addEventListener("click", refreshPassport);
  $("refreshTaskBtn").addEventListener("click", refreshTask);
  $("nodeBtn").addEventListener("click", () => runBackground(() => send("OPEN_DASHBOARD")));
  $("openNodeBtn").addEventListener("click", () => runBackground(() => send("OPEN_DASHBOARD")));
  [$("webBtn"), $("openWebBtn")].forEach((button) => button.addEventListener("click", () => runBackground(() => send("OPEN_CONTROL_CENTER"))));

  $("prepareBtn").addEventListener("click", (event) => runTask(event.currentTarget, () => send("ETSY_EDGE_PREPARE_NEXT"), "任务已领取并通过版本、授权与租约预检。"));
  $("applyBtn").addEventListener("click", (event) => runTask(event.currentTarget, () => send("ETSY_TASK_APPLY_APPROVED_DRAFT"), "获批字段已填入；请人工检查并保存为草稿。"));
  $("captureBtn").addEventListener("click", (event) => runTask(event.currentTarget, () => send("ETSY_TASK_CAPTURE_EVIDENCE"), "隐私安全的当前页面证据已绑定到任务。"));
  $("pauseBtn").addEventListener("click", (event) => runTask(event.currentTarget, () => send("ETSY_TASK_PAUSE_FOR_VERIFICATION", { checkpoint: { reason: "Operator paused for visible Etsy verification." } }), "任务已暂停，等待人工验证。"));
  $("reconcileBtn").addEventListener("click", (event) => runTask(event.currentTarget, () => send("ETSY_TASK_RECONCILE"), "已完成只读对账。"));
  $("recordUploadedBtn").addEventListener("click", (event) => runTask(event.currentTarget, () => send("ETSY_TASK_RECORD_UPLOADED", { readback: {
    listingId: $("listingId").value,
    listingUrl: $("listingUrl").value,
    humanConfirmedDraftSaved: $("visibleConfirmation").checked,
  } }), "草稿终态已回写并完成对账。"));
  $("recordFailedBtn").addEventListener("click", (event) => runTask(event.currentTarget, () => send("ETSY_TASK_RECORD_FAILED", { readback: {
    failureReason: $("failureReason").value,
  } }), "失败终态已记录。"));
  $("visibleConfirmation").addEventListener("change", () => renderTask(activeTaskRecord, null));

  const authAction = (type) => runBackground(async () => {
    await send(type);
    await refreshAuth();
  }, (error) => {
    setStatus($("authState"), "操作失败", "error");
    $("authSummary").textContent = error.message;
  });
  $("authorizeBtn").addEventListener("click", () => authAction("AUTH_DEVICE_START"));
  $("pollAuthBtn").addEventListener("click", () => authAction("AUTH_DEVICE_POLL"));
  $("logoutBtn").addEventListener("click", () => authAction("AUTH_LOGOUT"));
  $("saveBindingBtn").addEventListener("click", (event) => runBackground(async () => {
    const button = event.currentTarget;
    const original = button.textContent;
    button.disabled = true;
    button.textContent = "保存中…";
    try {
      await send("SAVE_EDGE_BINDING", { binding: {
        browserProfileRef: $("bindingProfileRef").value,
        etsyShopRef: $("bindingShopRef").value,
      } });
      $("bindingMessage").textContent = "绑定已保存，并已向 Web 报告当前 Edge 运行身份。";
      $("bindingMessage").dataset.kind = "success";
      $("bindingMessage").hidden = false;
      await Promise.all([refreshBinding(), refreshPassport()]);
    } catch (error) {
      $("bindingMessage").textContent = error.message;
      $("bindingMessage").dataset.kind = "error";
      $("bindingMessage").hidden = false;
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }));
  window.addEventListener("hashchange", () => showView(location.hash === "#settings" ? "settings" : "main"));
});
