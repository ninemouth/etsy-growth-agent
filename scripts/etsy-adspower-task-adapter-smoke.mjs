import assert from "node:assert/strict";
import fs from "node:fs";
import {
  assertEtsyAdsPowerTask,
  assertEtsyDraftPreflight,
  assertEtsyExecutionBinding,
  buildEtsyReadbackDocument,
  createEtsyAdsPowerTaskAdapter,
  ETSY_ADSPOWER_ACTIVE_TASK_KEY,
} from "../modules/etsyAdsPowerTaskAdapter.js";

const fixedNow = Date.parse("2026-08-25T08:00:00.000Z");
const expectedUpdatedAt = "2026-08-25T07:55:00.000Z";
const backgroundSource = fs.readFileSync(new URL("../edge-background.js", import.meta.url), "utf8");
const sidepanelSource = fs.readFileSync(new URL("../sidepanel.js", import.meta.url), "utf8");
const sidepanelHtml = fs.readFileSync(new URL("../sidepanel.html", import.meta.url), "utf8");
for (const messageType of [
  "ETSY_TASK_NEXT", "ETSY_TASK_RESUMABLE", "ETSY_TASK_CLAIM", "ETSY_TASK_RESUME", "ETSY_TASK_ACTIVE",
  "ETSY_TASK_PREFLIGHT", "ETSY_TASK_HEARTBEAT", "ETSY_TASK_PAUSE_FOR_VERIFICATION",
  "ETSY_TASK_RECORD_UPLOADED", "ETSY_TASK_RECORD_FAILED", "ETSY_TASK_RECONCILE",
  "ETSY_EDGE_PREPARE_NEXT", "ETSY_TASK_APPLY_APPROVED_DRAFT", "ETSY_TASK_CAPTURE_EVIDENCE",
]) {
  assert.match(backgroundSource, new RegExp(messageType));
}
assert.match(sidepanelHtml, /id="visibleConfirmation"/);
assert.match(sidepanelSource, /ETSY_EDGE_PREPARE_NEXT/);
assert.match(sidepanelSource, /humanConfirmedDraftSaved/);

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function createStorage() {
  const values = new Map();
  return {
    async get(keys) {
      return Object.fromEntries(keys.map((key) => [key, clone(values.get(key))]));
    },
    async set(payload) {
      Object.entries(payload).forEach(([key, value]) => values.set(key, clone(value)));
    },
    async remove(keys) {
      keys.forEach((key) => values.delete(key));
    },
    value(key) { return clone(values.get(key)); },
  };
}

function createFixture({ staleDraft = false, uncertainReadback = false } = {}) {
  const task = {
    id: "etsy-task-1",
    operationId: "operation-1",
    type: "etsy_publish",
    capability: "etsy_adspower",
    status: "queued",
    payload: {
      operationId: "operation-1",
      listingDraftId: "listing-draft-1",
      approvalId: "approval-1",
      listingDraftContractVersion: "etsy-listing-draft.v1",
      expectedUpdatedAt,
      writeAdapter: "adspower_etsy",
      writeAction: "upload_draft",
      publicPublishAllowed: false,
      etsyAutomationPermissionRef: "legal://etsy/permission/demo-2026-08-25",
      targetDeviceId: "device-1",
      browserProfileRef: "etsy-profile-01",
      etsyShopRef: "targetshop",
    },
  };
  const operation = {
    operationId: "operation-1",
    cancellation: null,
    listingDrafts: [{
      id: "listing-draft-1",
      operationId: "operation-1",
      contractVersion: "etsy-listing-draft.v1",
      updatedAt: staleDraft ? "2026-08-25T07:56:00.000Z" : expectedUpdatedAt,
      title: "Approved draft title",
      description: "Approved draft description",
      tags: ["approved draft"],
      publishAllowed: false,
      publicPublishAllowed: false,
      writeAdapter: "adspower_etsy",
      writeStatus: "queued",
      approval: { id: "approval-1", status: "approved" },
      readback: null,
    }],
  };
  const calls = [];
  let failReadback = uncertainReadback;
  const request = async (path, options = {}) => {
    calls.push({ path, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null });
    if (path === "/api/tasks/next?capability=etsy_adspower") return { task: clone(task) };
    if (path === "/api/tasks/resumable?capability=etsy_adspower") return { task: task.status === "claimed" ? clone(task) : null };
    if (path === "/api/tasks/etsy-task-1/claim") {
      task.status = "claimed";
      task.claimedBy = "operator-1";
      task.lease = { expiresAt: new Date(fixedNow + 600_000).toISOString(), expired: false, deviceId: "device-1", clientId: "etsy-growth-agent" };
      return { task: clone(task) };
    }
    if (path === "/api/tasks/etsy-task-1/resume") {
      task.status = "claimed";
      task.lease = { expiresAt: new Date(fixedNow + 600_000).toISOString(), expired: false, deviceId: "device-1", clientId: "etsy-growth-agent" };
      return { task: clone(task) };
    }
    if (path === "/api/tasks/etsy-task-1/heartbeat") {
      task.lease = { ...task.lease, expiresAt: new Date(fixedNow + 600_000).toISOString(), expired: false };
      return { taskId: task.id, lease: clone(task.lease) };
    }
    if (path === "/api/tasks/etsy-task-1/checkpoint") {
      task.checkpoint = clone(JSON.parse(options.body));
      task.lease = { ...task.lease, expiresAt: new Date(fixedNow + 600_000).toISOString(), expired: false };
      if (task.checkpoint.state === "paused_for_verification") task.status = "paused_for_verification";
      return { task: clone(task) };
    }
    if (path === "/api/tasks/etsy-task-1/artifacts") {
      const body = JSON.parse(options.body);
      assert.equal(body.mimeType, "application/json");
      assert.equal(body.redactionStatus, "verified");
      assert.match(body.sha256, /^[a-f0-9]{64}$/);
      const decoded = JSON.parse(Buffer.from(body.contentBase64, "base64").toString("utf8"));
      assert.equal(decoded.kind, "etsy_publish_readback");
      assert.equal(decoded.publicPublishPerformed, false);
      assert.equal(decoded.targetDeviceId, "device-1");
      assert.equal(decoded.browserProfileRef, "etsy-profile-01");
      assert.equal(decoded.etsyShopRef, "targetshop");
      return { artifact: { id: "artifact-1", storageRef: "marqel://evidence-artifacts/artifact-1", kind: "etsy_publish_readback" } };
    }
    if (path === "/api/tasks/etsy-task-1/readback") {
      const body = JSON.parse(options.body);
      if (failReadback) {
        failReadback = false;
        throw Object.assign(new Error("simulated response loss after visible page write"), { status: 504 });
      }
      task.status = body.status === "uploaded" ? "completed" : "blocked";
      task.publishReadback = { ...body, listingUrl: body.draftUrl };
      const draft = operation.listingDrafts[0];
      draft.writeStatus = body.status;
      draft.readback = { ...task.publishReadback };
      return {
        task: clone(task),
        listingDraft: clone(draft),
        operation: clone(operation),
        readback: clone(task.publishReadback),
        readbackRecorded: true,
        externalActionPerformed: false,
      };
    }
    if (path === "/api/tasks/etsy-task-1") return { task: clone(task) };
    if (path === "/api/operations/operation-1") return { operation: clone(operation) };
    throw new Error(`Unexpected request: ${options.method || "GET"} ${path}`);
  };
  return {
    task,
    operation,
    calls,
    request,
    recordServerReadback(body) {
      task.status = "completed";
      task.publishReadback = { ...body, listingUrl: body.draftUrl };
      operation.listingDrafts[0].writeStatus = "uploaded";
      operation.listingDrafts[0].readback = { ...task.publishReadback };
    },
  };
}

const invalidPublishTask = createFixture().task;
invalidPublishTask.payload.publicPublishAllowed = true;
assert.throws(() => assertEtsyAdsPowerTask(invalidPublishTask), (error) => error.code === "ETSY_PUBLIC_PUBLISH_FORBIDDEN");

const missingPlatformPermission = createFixture().task;
missingPlatformPermission.payload.etsyAutomationPermissionRef = "";
assert.throws(() => assertEtsyAdsPowerTask(missingPlatformPermission), (error) => error.code === "ETSY_TASK_CONTRACT_INVALID");

const stale = createFixture({ staleDraft: true });
stale.task.status = "claimed";
stale.task.lease = { expiresAt: new Date(fixedNow + 600_000).toISOString(), expired: false };
assert.throws(() => assertEtsyDraftPreflight(stale.task, stale.operation, { now: fixedNow }), (error) => error.code === "ETSY_DRAFT_STALE");

const runtimeBinding = { deviceId:"device-1", browserProfileRef:"etsy-profile-01", etsyShopRef:"targetshop" };
assert.deepEqual(assertEtsyExecutionBinding(createFixture().task, runtimeBinding), runtimeBinding);
assert.throws(() => assertEtsyExecutionBinding(createFixture().task, { ...runtimeBinding, deviceId:"device-2" }), (error) => error.code === "ETSY_TARGET_DEVICE_MISMATCH");

const fixture = createFixture();
const storage = createStorage();
const adapter = createEtsyAdsPowerTaskAdapter({ request: fixture.request, storage, getRuntimeBinding:async () => runtimeBinding, now: () => fixedNow });
assert.equal((await adapter.next()).task.id, "etsy-task-1");
assert.equal((await adapter.claim("etsy-task-1")).task.status, "claimed");
const verified = await adapter.preflight();
assert.equal(verified.listingDraft.id, "listing-draft-1");
await adapter.beginPageMutation({ pageUrl:"https://www.etsy.com/your/shops/TargetShop/listing/draft-123", selectorSetVersion:"selectors.v2", etsyShopRef:"targetshop" });
await adapter.completePageMutation({ operationId:"operation-1", listingDraftId:"listing-draft-1", selectorSetVersion:"selectors.v2", etsyShopRef:"targetshop", fieldsApplied:3 });
await assert.rejects(
  adapter.recordUploaded({ listingId: "draft-123", listingUrl: "https://www.etsy.com/your/shops/TargetShop/listing/draft-123" }),
  (error) => error.code === "ETSY_HUMAN_CONFIRMATION_REQUIRED",
);
await assert.rejects(
  adapter.recordUploaded({ listingId:"draft-123", listingUrl:"https://www.etsy.com/your/shops/TargetShop/listing/draft-123", humanConfirmedDraftSaved:true }),
  (error) => error.code === "ETSY_PAGE_MUTATION_PROOF_REQUIRED",
);
const completed = await adapter.recordUploaded({
  listingId: "draft-123",
  listingUrl: "https://www.etsy.com/your/shops/TargetShop/listing/draft-123",
  observedAt: "2026-08-25T08:01:00.000Z",
  humanConfirmedDraftSaved: true,
  visibleDraftVerified: true,
});
assert.equal(completed.externalActionPerformed, false);
assert.equal(completed.reconciliation.reconciled, true);
assert.equal(storage.value(ETSY_ADSPOWER_ACTIVE_TASK_KEY), undefined);
assert.equal(fixture.calls.filter((call) => call.path.endsWith("/readback")).length, 1);

const preparedFixture = createFixture();
const preparedStorage = createStorage();
const preparedAdapter = createEtsyAdsPowerTaskAdapter({ request: preparedFixture.request, storage: preparedStorage, getRuntimeBinding:async () => runtimeBinding, now: () => fixedNow });
const prepared = await preparedAdapter.prepareNext();
assert.equal(prepared.state, "ready_for_visible_draft");
assert.equal(prepared.source, "claimed");
assert.equal(prepared.task.status, "claimed");
assert.equal(prepared.listingDraft.id, "listing-draft-1");
assert.equal(preparedFixture.calls.filter((call) => call.path.endsWith("/claim")).length, 1);
assert.equal(preparedFixture.calls.filter((call) => call.path.endsWith("/checkpoint")).length, 1);

await preparedAdapter.pauseForVerification({ reason: "MFA required" });
const resumedPrepared = await preparedAdapter.prepareNext();
assert.equal(resumedPrepared.state, "ready_for_visible_draft");
assert.equal(resumedPrepared.source, "resumed");
assert.equal(preparedFixture.calls.filter((call) => call.path.endsWith("/resume")).length, 1);
const mutation = await preparedAdapter.beginPageMutation({ pageUrl:"https://www.etsy.com/your/shops/TargetShop/listing/draft-123", selectorSetVersion:"selectors.v2", etsyShopRef:"targetshop" });
assert.equal(mutation.retryAllowed, false);
await assert.rejects(
  preparedAdapter.beginPageMutation({ pageUrl:mutation.pageUrl, selectorSetVersion:"selectors.v2", etsyShopRef:"targetshop" }),
  (error) => error.code === "ETSY_PAGE_MUTATION_ALREADY_ATTEMPTED",
);
const completedMutation = await preparedAdapter.completePageMutation({ operationId:"operation-1", listingDraftId:"listing-draft-1", selectorSetVersion:"selectors.v2", etsyShopRef:"targetshop", fieldsApplied:3 });
assert.equal(completedMutation.state, "applied_verified");
assert.equal((await preparedAdapter.prepareNext()).state, "mutation_confirmation_required");

const uncertainty = createFixture({ uncertainReadback: true });
const uncertaintyStorage = createStorage();
const uncertainAdapter = createEtsyAdsPowerTaskAdapter({ request: uncertainty.request, storage: uncertaintyStorage, getRuntimeBinding:async () => runtimeBinding, now: () => fixedNow });
await uncertainAdapter.claim("etsy-task-1");
await uncertainAdapter.preflight();
await uncertainAdapter.beginPageMutation({ pageUrl:"https://www.etsy.com/your/shops/TargetShop/listing/draft-456", selectorSetVersion:"selectors.v2", etsyShopRef:"targetshop" });
await uncertainAdapter.completePageMutation({ operationId:"operation-1", listingDraftId:"listing-draft-1", selectorSetVersion:"selectors.v2", etsyShopRef:"targetshop", fieldsApplied:3 });
await assert.rejects(
  uncertainAdapter.recordUploaded({
    listingId: "draft-456",
    listingUrl: "https://www.etsy.com/your/shops/TargetShop/listing/draft-456",
    observedAt: "2026-08-25T08:02:00.000Z",
    humanConfirmedDraftSaved: true,
    visibleDraftVerified: true,
  }),
  (error) => error.code === "ETSY_READBACK_RECONCILIATION_REQUIRED",
);
const uncertainRecord = uncertaintyStorage.value(ETSY_ADSPOWER_ACTIVE_TASK_KEY);
assert.equal(uncertainRecord.reconciliationRequired, true);
assert.equal(uncertainRecord.retrySubmissionAllowed, false);
assert.equal(uncertainty.calls.filter((call) => call.path.endsWith("/readback")).length, 1);
uncertainty.recordServerReadback({
  contractVersion: "etsy-adspower-readback.v1",
  taskId: "etsy-task-1",
  operationId: "operation-1",
  listingDraftId: "listing-draft-1",
  status: "uploaded",
  artifactRef: uncertainRecord.artifactRef,
  listingId: "draft-456",
  draftUrl: "https://www.etsy.com/your/shops/TargetShop/listing/draft-456",
});
assert.equal((await uncertainAdapter.reconcile()).reconciled, true);
assert.equal(uncertainty.calls.filter((call) => call.path.endsWith("/readback")).length, 1);

const failureDocument = buildEtsyReadbackDocument(fixture.task, { status: "failed", failureReason: "MFA required", observedAt: "2026-08-25T08:03:00.000Z" });
assert.equal(failureDocument.publicPublishPerformed, false);
assert.equal(failureDocument.credentialsIncluded, false);
assert.equal(failureDocument.etsyAutomationPermissionRef, "legal://etsy/permission/demo-2026-08-25");
assert.throws(() => buildEtsyReadbackDocument(fixture.task, {
  status: "uploaded",
  listingId: "public-123",
  listingUrl: "https://www.etsy.com/listing/123/example",
}), (error) => error.code === "ETSY_PLATFORM_READBACK_INVALID");

console.log("etsy-adspower-task-adapter-smoke: ok");
