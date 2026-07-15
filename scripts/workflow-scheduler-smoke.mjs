import assert from "node:assert/strict";
import {
  acquireWorkflowSlot,
  clearWorkflowSchedulerState,
  getWorkflowSchedulerState,
  releaseWorkflowSlot,
  renewWorkflowSlot,
  updateWorkflowSlot,
} from "../modules/workflowScheduler.js";

await clearWorkflowSchedulerState();

const ownerA = `scheduler-owner-a-${Date.now()}`;
const ownerB = `scheduler-owner-b-${Date.now()}`;

const first = await acquireWorkflowSlot({
  ownerId: ownerA,
  workflowId: "workflow-a",
  skillId: "skills/etsy_platform_trends.skill.md",
  growthActionId: "explore_platform_trends",
  source: "smoke",
  ttlMs: 60_000,
});
assert.equal(first.ok, true, "first scheduler owner should acquire the global slot");

const blocked = await acquireWorkflowSlot({
  ownerId: ownerB,
  workflowId: "workflow-b",
  skillId: "skills/etsy_global_shop_optimizer.skill.md",
  source: "smoke",
  ttlMs: 60_000,
});
assert.equal(blocked.ok, false, "second owner should be blocked while the global slot is active");
assert.equal(blocked.active.ownerId, ownerA);

const updated = await updateWorkflowSlot(ownerA, {
  workflowId: "workflow-a-real",
  sourceTabId: 123,
  status: "running",
});
assert.equal(updated.ok, true);
assert.equal((await getWorkflowSchedulerState()).active.workflowId, "workflow-a-real");

const renewed = await renewWorkflowSlot(ownerA, 60_000);
assert.equal(renewed.ok, true, "active owner should renew scheduler lease");

const releaseByWrongOwner = await releaseWorkflowSlot(ownerB, "completed");
assert.equal(releaseByWrongOwner.ok, false, "non-owner cannot release the active scheduler slot");

const released = await releaseWorkflowSlot(ownerA, "completed");
assert.equal(released.ok, true, "active owner should release the scheduler slot");
assert.equal((await getWorkflowSchedulerState()).active, null);

await clearWorkflowSchedulerState();
console.log("workflow scheduler smoke passed");
