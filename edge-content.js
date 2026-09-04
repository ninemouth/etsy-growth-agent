// Marqel Etsy Edge v2 page bridge.
// Deliberately contains no research, prompt, provider, report or monitoring UI.

(() => {
  const ROOT_ID = "marqel-etsy-edge-v2-root";

  function runtimeAvailable() {
    try { return Boolean(chrome?.runtime?.id); } catch (_) { return false; }
  }

  function send(message) {
    return new Promise((resolve, reject) => {
      if (!runtimeAvailable()) {
        const error = new Error("扩展已更新，请刷新当前 Etsy 页面后继续。");
        error.code = "EDGE_CONTEXT_INVALIDATED";
        reject(error);
        return;
      }
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const runtimeError = chrome.runtime.lastError;
          if (runtimeError) {
            const error = new Error(runtimeError.message || "扩展连接失败。");
            error.code = /context invalidated|receiving end does not exist/i.test(error.message)
              ? "EDGE_CONTEXT_INVALIDATED"
              : "EDGE_RUNTIME_ERROR";
            reject(error);
            return;
          }
          if (!response?.ok) {
            const error = new Error(response?.error || "操作未完成。");
            error.code = response?.errorCode || "EDGE_REQUEST_FAILED";
            reject(error);
            return;
          }
          resolve(response.data);
        });
      } catch (cause) {
        const error = new Error("扩展已更新，请刷新当前 Etsy 页面后继续。");
        error.code = "EDGE_CONTEXT_INVALIDATED";
        error.cause = cause;
        reject(error);
      }
    });
  }

  function respond(sendResponse, operation) {
    Promise.resolve(operation)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message, errorCode: error.code || "EDGE_PAGE_OPERATION_BLOCKED" }));
    return true;
  }

  chrome.runtime.onMessage.addListener((message = {}, _sender, sendResponse) => {
    if (message.type === "INSPECT_APPROVED_ETSY_DRAFT") {
      if (!globalThis.EtsyDraftDomWriter) {
        sendResponse({ ok: false, error: "草稿检查模块未加载，请刷新 Etsy 页面。", errorCode: "EDGE_PAGE_REFRESH_REQUIRED" });
        return false;
      }
      return respond(sendResponse, globalThis.EtsyDraftDomWriter.inspectEditor(message.listingDraft, {
        executionBinding: message.executionBinding,
      }));
    }
    if (message.type === "APPLY_APPROVED_ETSY_DRAFT") {
      if (!globalThis.EtsyDraftDomWriter) {
        sendResponse({ ok: false, error: "草稿写入模块未加载，请刷新 Etsy 页面。", errorCode: "EDGE_PAGE_REFRESH_REQUIRED" });
        return false;
      }
      return respond(sendResponse, globalThis.EtsyDraftDomWriter.applyApprovedDraft(message.listingDraft, {
        executionBinding: message.executionBinding,
      }));
    }
    if (message.type === "PREPARE_PRIVACY_SAFE_SCREENSHOT") {
      if (!globalThis.EtsyScreenshotPrivacyMask) {
        sendResponse({ ok: false, error: "隐私遮罩模块未加载，请刷新 Etsy 页面。", errorCode: "EDGE_PAGE_REFRESH_REQUIRED" });
        return false;
      }
      return respond(sendResponse, globalThis.EtsyScreenshotPrivacyMask.prepare());
    }
    if (message.type === "RESTORE_PRIVACY_SAFE_SCREENSHOT") {
      if (!globalThis.EtsyScreenshotPrivacyMask) {
        sendResponse({ ok: false, error: "隐私遮罩模块未加载，请刷新 Etsy 页面。", errorCode: "EDGE_PAGE_REFRESH_REQUIRED" });
        return false;
      }
      return respond(sendResponse, globalThis.EtsyScreenshotPrivacyMask.restore(message.token));
    }
    return false;
  });

  if (globalThis.top !== globalThis.self || document.getElementById(ROOT_ID)) return;

  const host = document.createElement("div");
  host.id = ROOT_ID;
  host.setAttribute("data-marqel-edge", "v2");
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      *, *::before, *::after { box-sizing: border-box; }
      .edge-dock {
        position: fixed;
        right: 20px;
        bottom: 20px;
        z-index: 2147483640;
        display: flex;
        align-items: center;
        min-height: 52px;
        padding: 4px;
        color: #2b2723;
        background: rgba(255, 253, 249, 0.97);
        border: 1px solid rgba(54, 47, 41, 0.22);
        border-radius: 8px;
        box-shadow: 0 12px 32px rgba(54, 47, 41, 0.18);
        font: 600 13px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
        backdrop-filter: blur(14px);
      }
      .edge-state {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 118px;
        padding: 0 12px;
        white-space: nowrap;
      }
      .edge-dot {
        width: 8px;
        height: 8px;
        flex: 0 0 8px;
        border-radius: 50%;
        background: #a86122;
      }
      .edge-state[data-state="ready"] .edge-dot { background: #2f7a4d; }
      .edge-state[data-state="blocked"] .edge-dot { background: #b33b2e; }
      .edge-actions { display: flex; gap: 2px; }
      button {
        min-width: 54px;
        min-height: 44px;
        padding: 0 12px;
        border: 0;
        border-radius: 5px;
        color: #3e3832;
        background: transparent;
        font: inherit;
        cursor: pointer;
      }
      button:hover { background: #eee8df; }
      button:focus-visible { outline: 3px solid rgba(188, 79, 32, 0.34); outline-offset: 1px; }
      button.primary { color: #fffdf9; background: #b7471c; }
      button.primary:hover { background: #963715; }
      .edge-message {
        position: absolute;
        right: 0;
        bottom: 60px;
        width: min(320px, calc(100vw - 40px));
        padding: 12px 14px;
        color: #fffdf9;
        background: #2b2723;
        border-radius: 6px;
        box-shadow: 0 10px 24px rgba(54, 47, 41, 0.2);
        font-weight: 500;
        white-space: normal;
      }
      .edge-message[hidden] { display: none; }
      @media (max-width: 560px) {
        .edge-dock { right: 10px; bottom: 10px; max-width: calc(100vw - 20px); }
        .edge-state { min-width: 0; }
        .edge-state span:last-child { display: none; }
        button { min-width: 48px; padding: 0 9px; }
      }
    </style>
    <div class="edge-dock" role="toolbar" aria-label="Marqel Etsy Edge">
      <div class="edge-state" data-state="loading"><span class="edge-dot" aria-hidden="true"></span><span>Edge 检查中</span></div>
      <div class="edge-actions">
        <button class="primary" type="button" data-action="task">任务</button>
        <button type="button" data-action="web">Web</button>
        <button type="button" data-action="settings">设置</button>
      </div>
      <div class="edge-message" role="status" aria-live="polite" hidden></div>
    </div>
  `;
  document.documentElement.appendChild(host);

  const state = shadow.querySelector(".edge-state");
  const stateText = state.querySelector("span:last-child");
  const messageBox = shadow.querySelector(".edge-message");
  let hideMessageTimer = null;

  function showMessage(text) {
    messageBox.textContent = String(text || "");
    messageBox.hidden = false;
    clearTimeout(hideMessageTimer);
    hideMessageTimer = setTimeout(() => { messageBox.hidden = true; }, 6000);
  }

  async function refreshState() {
    try {
      const passport = await send({ type: "GET_EDGE_CAPABILITY_PASSPORT" });
      const nextState = passport?.nextAction?.state;
      state.dataset.state = nextState === "blocked" ? "blocked" : nextState === "active" || passport?.authority?.state === "bound" ? "ready" : "idle";
      stateText.textContent = nextState === "active" ? "任务执行中" : passport?.authority?.state === "bound" ? "Edge 已连接" : "Edge 待连接";
    } catch (error) {
      state.dataset.state = "blocked";
      stateText.textContent = "请刷新页面";
      showMessage(error.message);
    }
  }

  shadow.querySelectorAll("button[data-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const type = button.dataset.action === "web" ? "OPEN_CONTROL_CENTER" : "OPEN_SIDEPANEL";
      const view = button.dataset.action === "settings" ? "settings" : "main";
      send({ type, view }).catch((error) => showMessage(error.message));
    });
  });

  refreshState();
})();
