import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const backgroundSource = fs.readFileSync(path.join(root, "background.js"), "utf8");
const updateManagerSource = fs.readFileSync(path.join(root, "modules", "updateManager.js"), "utf8");
const sidepanelSource = fs.readFileSync(path.join(root, "sidepanel.js"), "utf8");
const sidepanelHtml = fs.readFileSync(path.join(root, "sidepanel.html"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

assert.equal(pkg.version, manifest.version, "package.json and manifest.json versions must stay aligned for open-source releases");
assert.match(updateManagerSource, /chrome\.runtime\.requestUpdateCheck/, "update manager should ask Chrome for runtime extension updates");
assert.match(updateManagerSource, /chrome\.runtime\.reload\(\)/, "update manager should be able to apply downloaded runtime updates");
assert.match(updateManagerSource, /releaseManifestUrl/, "update manager should support open-source release manifest awareness");
assert.match(backgroundSource, /chrome\.runtime\.onUpdateAvailable/, "background should record Chrome update-available events");
assert.match(backgroundSource, /activeWorkflowRuns[\s\S]*applyPendingUpdateIfIdle/, "runtime updates should wait for active workflows before auto-apply");
assert.match(sidepanelHtml, /releaseManifestUrl[\s\S]*checkUpdatesBtn[\s\S]*applyUpdateBtn/, "sidepanel should expose update awareness controls");
assert.match(sidepanelSource, /GET_UPDATE_STATUS[\s\S]*CHECK_FOR_UPDATES[\s\S]*APPLY_PENDING_UPDATE/, "sidepanel should read, check, and apply update state through background messages");

console.log("update manager smoke passed");
