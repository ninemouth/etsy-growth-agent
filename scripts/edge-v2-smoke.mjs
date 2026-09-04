import assert from "node:assert/strict";
import fs from "node:fs";

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const manifest = JSON.parse(read("manifest.json"));
const pkg = JSON.parse(read("package.json"));
const packageScript = read("scripts/package-extension.mjs");
const sidepanel = read("sidepanel.html");
const dashboard = read("dashboard.html");
const background = read("edge-background.js");
const controlCenterAuth = read("modules/controlCenterAuth.js");

assert.equal(manifest.version, "2.0.0");
assert.equal(pkg.version, manifest.version);
assert.equal(pkg.main, "edge-background.js");
assert.equal(manifest.permissions.includes("scripting"), false);
assert.equal(manifest.permissions.includes("debugger"), false);
assert.equal(manifest.host_permissions.includes("<all_urls>"), false);
for (const forbiddenHost of ["openai.com", "anthropic.com", "dashscope", "openrouter", "groq.com", "google.com", "amazon.", "ebay.", "pinterest."]) {
  assert.equal(manifest.host_permissions.some((host) => host.includes(forbiddenHost)), false, `forbidden host permission: ${forbiddenHost}`);
}

for (const retiredSurface of ["skills", "background.js", "content.js", "ui-system.css", "dashboardAds.js", "print.html"]) {
  assert.doesNotMatch(packageScript, new RegExp(`(?:^|[\"'])${retiredSurface.replace(".", "\\.")}(?:[\"']|$)`), `package must not ship ${retiredSurface}`);
}
assert.match(packageScript, /edge-background\.js/);
assert.match(packageScript, /edge-content\.js/);
assert.match(background, /etsyAutomationPermissionRef|ETSY_TASK_APPLY_APPROVED_DRAFT/);
assert.match(background, /marqel-browser-extension-report\.v2/);
assert.match(background, /ETSY_PAGE_MUTATION_ALREADY_ATTEMPTED|beginPageMutation/);
assert.match(background, /ETSY_TASK_CAPTURE_EVIDENCE[\s\S]*captureTaskEvidence/);
assert.match(background, /RETIRED_LOCAL_KEYS/);
assert.doesNotMatch(background, /lastAccessed|tabs\.query\(\{ url:/, "Edge must never fall back to a background Etsy tab");
assert.doesNotMatch(background, /callLLM|runAgentLoop|dispatchEtsySkills/);
assert.doesNotMatch(controlCenterAuth, /config\.llm|config\.image|team-secret/);
assert.match(sidepanel, /研究与决策在 Codex，审批与经营记忆在 Web/);
assert.match(dashboard, /这里不是第二个经营后台，也不是 AI 研究工具/);

const ids = [...sidepanel.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
assert.equal(new Set(ids).size, ids.length, "sidepanel ids must be unique");
for (const required of ["passportState", "taskState", "prepareBtn", "captureBtn", "applyBtn", "reconcileBtn", "recordUploadedBtn", "settingsBtn", "authorizeBtn", "bindingProfileRef", "bindingShopRef", "saveBindingBtn"]) {
  assert.ok(ids.includes(required), `missing sidepanel control ${required}`);
}

console.log("edge-v2-smoke: ok");
