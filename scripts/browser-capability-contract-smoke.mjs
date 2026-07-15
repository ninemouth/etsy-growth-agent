import assert from "node:assert/strict";
import fs from "node:fs";
import { BROWSER_AUTOMATION_CAPABILITIES } from "../modules/browserAutomationCapabilities.js";

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

const toolRegistry = read("modules/toolRegistry.js");
const agentLoop = read("modules/agentLoop.js");
const content = read("content.js");
const shop = read("skills/etsy_global_shop_optimizer.skill.md");
const trends = read("skills/etsy_platform_trends.skill.md");
const sourcing = read("skills/etsy_sourcing_finder.skill.md");
const reviews = read("skills/etsy_review_analyzer.skill.md");

const requiredCapabilityIds = [
  "address_navigation",
  "keyboard_input_search",
  "filter_sort_pagination",
  "dom_collection_cleaning",
  "multimodal_screenshot",
  "review_collection",
  "tab_lifecycle",
  "seller_api_and_archive",
];

const ids = BROWSER_AUTOMATION_CAPABILITIES.map((item) => item.id);
for (const id of requiredCapabilityIds) {
  assert.ok(ids.includes(id), `browser capability manifest must include ${id}`);
}

for (const item of BROWSER_AUTOMATION_CAPABILITIES) {
  assert.ok(item.label, `${item.id} should have a user-facing label`);
  assert.ok(Array.isArray(item.tools) && item.tools.length > 0, `${item.id} should map to runtime tools`);
  assert.ok(Array.isArray(item.guarantees) && item.guarantees.length > 0, `${item.id} should document guarantees`);
  assert.ok(Array.isArray(item.limitations) && item.limitations.length > 0, `${item.id} should document limitations`);
}

assert.match(toolRegistry, /get_browser_capabilities/, "tool registry must expose browser capability contract");
assert.match(toolRegistry, /summarizeBrowserAutomationCapabilities/, "tool registry should return the shared capability manifest");
assert.match(agentLoop, /formatBrowserAutomationCapabilityPrompt/, "agent loop must inject browser capability contract into prompts");
assert.match(agentLoop, /页面动态加载时必须相信工具返回的 loadState、evidenceOk、pageEvidence/, "agent prompt should force evidence-aware browser operation");
assert.match(agentLoop, /Etsy 个人卖家 API 不能读取竞品后台、竞品订单、竞品转化率或平台大盘/, "agent prompt should preserve Etsy personal API boundary");
assert.match(toolRegistry, /minStableReads[\s\S]*waitForTabReadiness[\s\S]*stableReads/, "runtime should wait for stable page evidence before collection");
assert.match(toolRegistry, /executeGenericDomSnapshot[\s\S]*allFrames: true/, "DOM collection should include multi-frame fallback");
assert.match(toolRegistry, /captureFullPageScreenshot[\s\S]*captureVisibleTab/, "screenshot collection should have full-page and viewport fallback");
assert.match(content, /INPUT_TEXT_AND_SEARCH[\s\S]*KeyboardEvent[\s\S]*pressedEnter/, "content script must support keyboard-like input and Enter fallback");
assert.match(content, /CLICK_BY_COORDINATE[\s\S]*file upload\/camera|Proactively blocked click_by_coordinate on file upload\/camera elements/, "coordinate clicking must block unsafe file upload targets");
assert.match(content, /READ_CURRENT_PAGE[\s\S]*readCurrentPage/, "content script must expose DOM collection");
assert.match(shop, /DOM 文本审计双轨制|双轨分析模式/, "shop diagnosis must preserve DOM plus visual dual-track audit");
assert.match(trends, /Google Trends[\s\S]*趋势图解读/, "trend skill must require Trends screenshot visual interpretation");
assert.match(sourcing, /image_search_1688|image_search_taobao/, "sourcing skill should keep image-search-first paths");
assert.match(reviews, /review|评论|差评/i, "review analyzer should remain review-evidence oriented");

console.log("browser-capability-contract-smoke: ok");
