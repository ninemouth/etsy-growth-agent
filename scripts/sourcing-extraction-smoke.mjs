import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCrossBorderSourcingHandoff,
  isCrossBorderSourcingRequest,
} from "../modules/crossBorderSourcingHandoff.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const read = (relativePath) => fs.readFileSync(path.join(root, "..", relativePath), "utf8");
const background = read("background.js");
const sidepanel = read("sidepanel.js");
const sidepanelHtml = read("sidepanel.html");
const content = read("content.js");
const manifest = JSON.parse(read("manifest.json"));
const registeredSkillPaths = background.match(/const ETSY_SKILL_PATHS = new Set\(\[([\s\S]*?)\]\);/)?.[1] || "";
const listedSkills = background.match(/async function listSkills\(\) \{([\s\S]*?)const available = \[\];/)?.[1] || "";

assert.doesNotMatch(registeredSkillPaths, /etsy_sourcing_finder/, "active background registry must not expose the legacy sourcing skill");
assert.doesNotMatch(listedSkills, /etsy_sourcing_finder/, "skill listing must not expose the legacy sourcing skill");
assert.match(background, /Legacy supplier sourcing is not executable[\s\S]*SOURCING_HANDOFF_REQUIRED/, "direct legacy skill loads must fail closed");
assert.doesNotMatch(background, /validate_opportunity_sourcing:\s*\[/, "legacy sourcing action must not be mapped to a runnable Etsy skill");
assert.match(background, /SOURCING_HANDOFF_REQUIRED/, "background must expose an explicit sourcing handoff response");
assert.match(background, /buildCrossBorderSourcingHandoff/, "background must use the shared handoff contract");

assert.doesNotMatch(sidepanel, /skillId:\s*"etsy_sourcing_finder"/, "sidepanel must not select the legacy sourcing skill");
assert.doesNotMatch(sidepanel, /skills\/etsy_sourcing_finder\.skill\.md/, "sidepanel must not route an active action to the legacy sourcing skill");
assert.match(sidepanel, /sidepanel-open-sourcing-control-center-btn/, "opportunity follow-up must link to the new Control Center boundary");
assert.doesNotMatch(sidepanelHtml, /data-action="filter_supplier_sources"/, "sidepanel must not expose direct supplier sourcing action");

assert.doesNotMatch(content, /skills\/etsy_sourcing_finder\.skill\.md/, "floating Etsy UI must not route to the legacy sourcing skill");
assert.doesNotMatch(content, /data-action=.?filter_supplier_sources/, "floating Etsy UI must not expose direct supplier sourcing action");
assert.ok(!manifest.content_scripts.some((entry) => (entry.matches || []).some((match) => /1688/.test(match))), "Etsy extension must not inject content.js into 1688");
assert.match(read("scripts/package-extension.mjs"), /etsy_sourcing_finder\.skill\.md/, "extension package must exclude the legacy sourcing skill");

assert.equal(isCrossBorderSourcingRequest({ actionId: "filter_supplier_sources" }), true);
assert.equal(isCrossBorderSourcingRequest({ userInstruction: "请去淘宝筛选两个供应商" }), true);
assert.equal(isCrossBorderSourcingRequest({ userInstruction: "请基于供应商提供的材质资料改写 Etsy listing" }), false);
assert.equal(isCrossBorderSourcingRequest({ userInstruction: "请诊断 Etsy 商品转化" }), false);

const handoff = buildCrossBorderSourcingHandoff({ actionId: "filter_supplier_sources", userInstruction: "筛选 1688 供应商" });
assert.equal(handoff.code, "SOURCING_MOVED_TO_MARQEL_ORCHESTRATOR");
assert.equal(handoff.destination.runner, "supplier-sourcing-chrome-runner");
assert.equal(handoff.destination.browser, "ordinary_chrome");
assert.equal(handoff.safety.bypassCaptcha, false);
assert.equal(handoff.safety.publishAllowed, false);
assert.equal(handoff.requestedInstruction, "", "handoff must not echo user input or secrets");
assert.match(handoff.destination.controlCenterUrl, /^https:\/\/www\.marqel\.shop\/operations\.html$/);
assert.ok(handoff.nextActions.some((item) => item.includes("$cross-border-sourcing-orchestrator")));

console.log("sourcing extraction smoke passed");
