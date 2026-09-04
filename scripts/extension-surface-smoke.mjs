import assert from "node:assert/strict";
import fs from "node:fs";
import { openExtensionSurface } from "../modules/extensionSurface.js";

function mockChrome({ sidePanel = null, tabs = [] } = {}) {
  const calls = { create: [], open: [], query: [], setOptions: [], update: [] };
  return {
    calls,
    api: {
      runtime: { getURL: (path) => `chrome-extension://stable-id/${path}` },
      sidePanel,
      tabs: {
        query: async (query) => { calls.query.push(query); return tabs; },
        create: async (options) => { calls.create.push(options); return { id: 91, ...options }; },
        update: async (tabId, options) => { calls.update.push({ tabId, options }); return { id: tabId, ...options }; },
      },
    },
  };
}

const supported = mockChrome({ sidePanel: { setOptions: async () => {}, open: async () => {} } });
assert.equal((await openExtensionSurface(supported.api, { tabId: 12, view: "settings" })).surface, "side_panel");

const unavailable = mockChrome();
const fallback = await openExtensionSurface(unavailable.api, { tabId: 18, view: "settings" });
assert.equal(fallback.surface, "extension_tab");
assert.equal(fallback.url, "chrome-extension://stable-id/sidepanel.html#settings");

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const manifest = JSON.parse(read("manifest.json"));
const content = read("edge-content.js");
const background = read("edge-background.js");
const sidepanelHtml = read("sidepanel.html");
const dashboardHtml = read("dashboard.html");

assert.equal(manifest.background.service_worker, "edge-background.js");
assert.deepEqual(manifest.content_scripts[0].js, ["modules/screenshotPrivacyMask.js", "modules/etsyDraftDomWriter.js", "edge-content.js"]);
assert.match(content, /EDGE_CONTEXT_INVALIDATED/);
assert.match(content, /data-action="task"[\s\S]*data-action="web"[\s\S]*data-action="settings"/);
assert.doesNotMatch(content, /scan_competitor|RUN_SKILL|LLM|apiKey|聊天|兼容/);
assert.doesNotMatch(background, /RUN_SKILL|etsy-agent-loop|scan_competitor|monitor_task_/);
assert.match(sidepanelHtml, /唯一设置入口/);
assert.doesNotMatch(sidepanelHtml, /旧版研究工作台|LLM Provider|API Key|竞品扫描|平台趋势|结果库/);
assert.doesNotMatch(dashboardHtml, /系统设置|迁移工具|工作流画布|扫描竞品|汇率与套利参数/);

console.log("extension-surface-smoke: ok");
