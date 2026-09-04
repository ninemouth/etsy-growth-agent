import assert from "node:assert/strict";
import {
  BROWSER_AUTOMATION_CAPABILITIES,
  EDGE_CAPABILITY_PASSPORT_VERSION,
  buildEdgeCapabilityPassport,
  classifyEtsySurface,
} from "../modules/browserAutomationCapabilities.js";

assert.equal(EDGE_CAPABILITY_PASSPORT_VERSION, "etsy-edge-capability-passport.v2");
assert.deepEqual(BROWSER_AUTOMATION_CAPABILITIES.map((item) => item.id), [
  "task_bound_page_identity",
  "approved_draft_fill",
  "privacy_safe_task_evidence",
  "terminal_readback",
]);
for (const item of BROWSER_AUTOMATION_CAPABILITIES) {
  assert.ok(item.label);
  assert.ok(item.tools.length > 0);
  assert.ok(item.guarantees.length > 0);
  assert.ok(item.limitations.length > 0);
}

assert.equal(classifyEtsySurface({ url: "https://www.etsy.com/listing/123/example" }).type, "listing");
assert.equal(classifyEtsySurface({ url: "https://www.etsy.com/your/shops/123/tools/listings/456" }).type, "listing_editor");
assert.equal(classifyEtsySurface({ url: "https://www.etsy.com/shop/ExampleShop" }).type, "shop");
assert.equal(classifyEtsySurface({ url: "https://www.etsy.com/search?q=gift" }).type, "search");
assert.equal(classifyEtsySurface({ url: "https://www.etsy.com/your/orders" }).type, "sensitive");
assert.equal(classifyEtsySurface({ url: "https://example.com/" }).type, "external");

const localListing = buildEdgeCapabilityPassport({
  tab: { url: "https://www.etsy.com/listing/123/example", title: "Example listing" },
  extensionVersion: "2.0.0",
});
assert.equal(localListing.identity.role, "browser_edge_runtime");
assert.equal(localListing.evidence.dom.state, "wrong_surface");
assert.equal(localListing.evidence.viewport.state, "wrong_surface");
assert.equal(localListing.execution.approvedDraft.state, "wrong_surface");
assert.equal(localListing.execution.publishOrSpend.state, "forbidden");
assert.equal(localListing.nextAction.label, "连接 Control Center");
assert.equal(Object.hasOwn(localListing.execution, "governedWorkflow"), false);

const localEditor = buildEdgeCapabilityPassport({
  tab: { url: "https://www.etsy.com/your/shops/123/tools/listings/456" },
  extensionVersion: "2.0.0",
});
assert.equal(localEditor.evidence.dom.state, "task_required");
assert.equal(localEditor.execution.approvedDraft.state, "authorization_required");

const activeListing = buildEdgeCapabilityPassport({
  tab: { url: "https://www.etsy.com/your/shops/123/tools/listings/456" },
  session: { user: { id: "operator-1" } },
  activeTask: { task: { id: "task-1", operationId: "operation-1" } },
});
assert.equal(activeListing.runtime.state, "active");
assert.equal(activeListing.runtime.operationRef, "operation-1");
assert.equal(activeListing.evidence.dom.state, "ready");
assert.equal(activeListing.execution.approvedDraft.state, "approval_required");
assert.equal(activeListing.nextAction.state, "active");

const activeWrongSurface = buildEdgeCapabilityPassport({
  tab: { url: "https://www.etsy.com/listing/123/example" },
  session: { user: { id: "operator-1" } },
  activeTask: { task: { id: "task-1", operationId: "operation-1" } },
});
assert.equal(activeWrongSurface.evidence.viewport.state, "wrong_surface");
assert.equal(activeWrongSurface.nextAction.label, "打开任务对应编辑器");

const sensitive = buildEdgeCapabilityPassport({
  tab: { url: "https://www.etsy.com/your/account/security" },
  session: { user: { id: "operator-1" } },
  activeTask: { task: { id: "task-1", operationId: "operation-1" } },
});
assert.equal(sensitive.surface.evidenceAllowed, false);
assert.equal(sensitive.evidence.dom.state, "blocked");
assert.equal(sensitive.nextAction.state, "blocked");

console.log("browser-capability-contract-smoke: ok");
