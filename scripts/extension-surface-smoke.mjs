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

const supported = mockChrome({
  sidePanel: {
    setOptions: async (options) => supported.calls.setOptions.push(options),
    open: async (options) => supported.calls.open.push(options),
  },
});
const opened = await openExtensionSurface(supported.api, { tabId: 12, view: "settings" });
assert.equal(opened.surface, "side_panel");
assert.deepEqual(supported.calls.open, [{ tabId: 12 }]);
assert.equal(supported.calls.create.length, 0);
assert.equal(supported.calls.setOptions[0].path, "sidepanel.html#settings");

const unavailable = mockChrome();
const fallback = await openExtensionSurface(unavailable.api, { tabId: 18, view: "settings" });
assert.equal(fallback.surface, "extension_tab");
assert.equal(fallback.url, "chrome-extension://stable-id/sidepanel.html#settings");
assert.equal(fallback.fallbackReason, "side_panel_unavailable");
assert.equal(unavailable.calls.create.length, 1);

const rejected = mockChrome({
  tabs: [{ id: 44, url: "chrome-extension://stable-id/sidepanel.html" }],
  sidePanel: { open: async () => { throw new Error("open is not supported"); } },
});
const reused = await openExtensionSurface(rejected.api, { tabId: 22, view: "settings" });
assert.equal(reused.surface, "extension_tab");
assert.equal(reused.reused, true);
assert.equal(reused.fallbackReason, "open is not supported");
assert.deepEqual(rejected.calls.update, [{ tabId: 44, options: { active: true, url: "chrome-extension://stable-id/sidepanel.html#settings" } }]);

const manifest = JSON.parse(fs.readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
const content = fs.readFileSync(new URL("../content.js", import.meta.url), "utf8");
const background = fs.readFileSync(new URL("../background.js", import.meta.url), "utf8");
const sidepanel = fs.readFileSync(new URL("../sidepanel.js", import.meta.url), "utf8");
assert.ok(manifest.permissions.includes("sidePanel"));
assert.equal(manifest.side_panel.default_path, "sidepanel.html");
assert.match(content, /Extension context invalidated\|context invalidated/);
assert.match(content, /settings-refresh-page/);
assert.doesNotMatch(background, /chrome\.sidePanel\.open/);
assert.match(sidepanel, /location\.hash === "#settings"/);

console.log("extension surface smoke passed");

