import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const backgroundSource = fs.readFileSync(new URL("../background.js", import.meta.url), "utf8");
const agentLoopSource = fs.readFileSync(new URL("../modules/agentLoop.js", import.meta.url), "utf8");
const contentSource = fs.readFileSync(new URL("../content.js", import.meta.url), "utf8");
const toolRegistrySource = fs.readFileSync(new URL("../modules/toolRegistry.js", import.meta.url), "utf8");
const packageSource = fs.readFileSync(new URL("./package-extension.mjs", import.meta.url), "utf8");
const { tools } = await import("../modules/toolRegistry.js");

assert.equal(fs.existsSync(path.join(root, "skills", "etsy_sourcing_finder.skill.md")), false, "legacy sourcing skill must be physically absent");
assert.doesNotMatch(backgroundSource, /ETSY_SKILL_PATHS[\s\S]*etsy_sourcing_finder/, "legacy sourcing must not be registered as an Etsy skill");
assert.doesNotMatch(backgroundSource, /id:\s*"etsy_sourcing_finder"/, "legacy sourcing must not be listed in the skill catalog");
assert.match(backgroundSource, /Legacy supplier sourcing is not executable[\s\S]*SOURCING_HANDOFF_REQUIRED/, "direct legacy skill loads must fail closed");
assert.match(backgroundSource, /isCrossBorderSourcingRequest[\s\S]*SOURCING_HANDOFF_REQUIRED[\s\S]*buildCrossBorderSourcingHandoff/, "sourcing intent must be handed to the cross-border orchestrator before the agent loop");
assert.match(packageSource, /etsy_sourcing_finder\.skill\.md/, "packaging must keep an explicit defense-in-depth exclusion for the deleted legacy path");
assert.doesNotMatch(agentLoopSource, /function getSourcingWorkflowGuardError|SOURCING_SKILL_RE/, "legacy sourcing execution guards must not remain as a shadow runtime");
for (const retiredTool of ["extract_product_info", "input_text_and_search", "prepare_clean_product_image", "image_search_1688", "image_search_taobao", "image_search_in_browser"]) {
  assert.doesNotMatch(toolRegistrySource, new RegExp(`\\n\\s{2}${retiredTool}:\\s*async`), `${retiredTool} must be physically absent from the registry`);
}
for (const retiredMessageType of ["INPUT_TEXT_AND_SEARCH", "GET_IMAGE_SEARCH_UI_STATE", "IMAGE_SEARCH_IN_BROWSER", "EXTRACT_PRODUCT_INFO"]) {
  assert.doesNotMatch(contentSource, new RegExp(`message\\.type === ["']${retiredMessageType}["']`), `${retiredMessageType} must be physically absent from content handlers`);
}
await assert.rejects(() => tools.search_in_browser({ query:"desk organizer", engine:"1688" }), (error) => error?.code === "BROWSER_SEARCH_ENGINE_NOT_ALLOWED");
await assert.rejects(() => tools.open_new_tab({ url:"https://detail.1688.com/offer/123.html" }), (error) => error?.code === "SOURCING_HANDOFF_REQUIRED");
await assert.rejects(() => tools.navigate_to({ url:"https://item.taobao.com/item.htm?id=123" }), (error) => error?.code === "SOURCING_HANDOFF_REQUIRED");

console.log("sourcing workflow tombstone smoke passed");
