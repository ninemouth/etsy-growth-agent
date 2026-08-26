export const ETSY_ADSPOWER_CAPABILITY = "etsy_adspower";
export const ETSY_ADSPOWER_ACTIVE_TASK_KEY = "marqelEtsyAdsPowerActiveTask";
export const ETSY_ADSPOWER_READBACK_CONTRACT = "etsy-adspower-readback.v1";
export const ETSY_ADSPOWER_ARTIFACT_CONTRACT = "etsy-publish-readback-artifact.v1";

const RESUMABLE_STATUSES = new Set(["claimed", "evidence_pending", "verification_required", "paused_for_verification"]);
const TERMINAL_STATUSES = new Set(["completed", "blocked", "cancelled", "failed"]);

function adapterError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requiredText(value, field, max = 2_000) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > max) throw adapterError("ETSY_TASK_CONTRACT_INVALID", `${field} is required and must not exceed ${max} characters.`);
  return normalized;
}

function etsyUrl(value, field) {
  const normalized = requiredText(value, field);
  let url;
  try { url = new URL(normalized); } catch { throw adapterError("ETSY_PLATFORM_READBACK_INVALID", `${field} must be a valid Etsy HTTPS URL.`); }
  if (url.protocol !== "https:" || !/(^|\.)etsy\.com$/i.test(url.hostname) || url.username || url.password) {
    throw adapterError("ETSY_PLATFORM_READBACK_INVALID", `${field} must be an Etsy HTTPS URL without credentials.`);
  }
  return url.toString();
}

function leaseUsable(task, now = Date.now()) {
  if (!task?.lease || task.lease.expired === true) return false;
  const expiresAt = Date.parse(String(task.lease.expiresAt || ""));
  return Number.isFinite(expiresAt) && expiresAt > now;
}

export function assertEtsyAdsPowerTask(task, { requireLease = false, now = Date.now() } = {}) {
  if (!task || typeof task !== "object") throw adapterError("ETSY_TASK_MISSING", "Control Center did not return an Etsy AdsPower task.");
  requiredText(task.id, "task.id", 180);
  requiredText(task.operationId, "task.operationId", 180);
  if (task.type !== "etsy_publish" || task.capability !== ETSY_ADSPOWER_CAPABILITY) {
    throw adapterError("ETSY_TASK_CAPABILITY_MISMATCH", "Only etsy_publish tasks with capability=etsy_adspower are accepted.");
  }
  if (task.payload?.writeAdapter !== "adspower_etsy" || task.payload?.writeAction !== "upload_draft") {
    throw adapterError("ETSY_TASK_ACTION_FORBIDDEN", "Only the approved AdsPower upload_draft action is accepted.");
  }
  if (task.payload?.publicPublishAllowed !== false) {
    throw adapterError("ETSY_PUBLIC_PUBLISH_FORBIDDEN", "The task must explicitly keep publicPublishAllowed=false.");
  }
  requiredText(task.payload?.listingDraftId, "task.payload.listingDraftId", 180);
  requiredText(task.payload?.approvalId, "task.payload.approvalId", 180);
  if (task.payload?.listingDraftContractVersion !== "etsy-listing-draft.v1") {
    throw adapterError("ETSY_DRAFT_VERSION_MISMATCH", "The task must reference etsy-listing-draft.v1.");
  }
  requiredText(task.payload?.expectedUpdatedAt, "task.payload.expectedUpdatedAt", 80);
  if (requireLease && !leaseUsable(task, now)) throw adapterError("ETSY_TASK_LEASE_INVALID", "The Etsy task lease is missing or expired; stop all page writes and resume explicitly.");
  return task;
}

export function assertEtsyDraftPreflight(task, operation, { now = Date.now() } = {}) {
  assertEtsyAdsPowerTask(task, { requireLease: true, now });
  if (!operation || operation.operationId !== task.operationId) throw adapterError("ETSY_OPERATION_MISMATCH", "The Control Center operation does not match the claimed task.");
  if (operation.cancellation) throw adapterError("ETSY_OPERATION_CANCELLED", "The operation was cancelled; no Etsy page write is allowed.");
  const drafts = Array.isArray(operation.listingDrafts) ? operation.listingDrafts : [];
  const draft = drafts.find((candidate) => candidate?.id === task.payload.listingDraftId);
  if (!draft) throw adapterError("ETSY_DRAFT_MISSING", "The exact Listing draft referenced by the task is not readable.");
  if (draft.contractVersion !== task.payload.listingDraftContractVersion) throw adapterError("ETSY_DRAFT_VERSION_MISMATCH", "The Listing draft contract version changed after task creation.");
  if (draft.updatedAt !== task.payload.expectedUpdatedAt) throw adapterError("ETSY_DRAFT_STALE", "The Listing draft changed after task creation; create a new approved task for the new version.");
  if (draft.approval?.status !== "approved" || draft.approval?.id !== task.payload.approvalId) {
    throw adapterError("ETSY_DRAFT_APPROVAL_INVALID", "The exact Listing draft approval is missing or no longer matches the task.");
  }
  if (draft.publishAllowed !== false || draft.publicPublishAllowed !== false || draft.writeAdapter !== "adspower_etsy") {
    throw adapterError("ETSY_PUBLIC_PUBLISH_FORBIDDEN", "The Listing draft no longer satisfies the controlled AdsPower draft-only boundary.");
  }
  if (!new Set(["queued", "claimed", "not_started"]).has(draft.writeStatus)) {
    throw adapterError("ETSY_DRAFT_ALREADY_HANDLED", `The Listing draft write status is ${draft.writeStatus || "unknown"}; do not submit it again.`);
  }
  return { task, operation, listingDraft: draft };
}

export function buildEtsyTaskCheckpoint(task, {
  state = "active",
  stage = "preflight_verified",
  pageUrl = "",
  pausedReason = "",
  nextHumanAction = "Continue the visible Etsy draft workflow.",
} = {}) {
  assertEtsyAdsPowerTask(task);
  if (!["active", "paused_for_verification", "evidence_collected", "completed"].includes(state)) {
    throw adapterError("ETSY_CHECKPOINT_INVALID", "Unsupported Etsy task checkpoint state.");
  }
  return {
    contractVersion: "task-checkpoint.v1",
    state,
    stage: requiredText(stage, "checkpoint.stage", 80),
    pageUrl: pageUrl ? etsyUrl(pageUrl, "checkpoint.pageUrl") : "",
    evidenceCount: 0,
    detailEvidenceCount: 0,
    pausedReason: String(pausedReason || "").trim().slice(0, 1_000),
    nextHumanAction: String(nextHumanAction || "").trim().slice(0, 1_000),
  };
}

export function buildEtsyReadbackDocument(task, {
  status,
  listingId = "",
  listingUrl = "",
  failureReason = "",
  observedAt = new Date().toISOString(),
} = {}) {
  assertEtsyAdsPowerTask(task);
  if (!new Set(["uploaded", "failed"]).has(status)) throw adapterError("ETSY_READBACK_STATUS_INVALID", "Only uploaded or failed readback documents are supported.");
  const normalizedUrl = listingUrl ? etsyUrl(listingUrl, "listingUrl") : "";
  const normalizedListingId = String(listingId || "").trim().slice(0, 180);
  const normalizedFailure = String(failureReason || "").trim().slice(0, 2_000);
  if (status === "uploaded" && (!normalizedListingId || !normalizedUrl)) {
    throw adapterError("ETSY_PLATFORM_READBACK_INVALID", "An uploaded Etsy draft requires a visible listingId and Etsy draft URL.");
  }
  if (status === "failed" && !normalizedFailure) throw adapterError("ETSY_FAILURE_REASON_REQUIRED", "A failed Etsy task requires a failure reason.");
  const timestamp = new Date(observedAt).toISOString();
  return {
    contractVersion: ETSY_ADSPOWER_ARTIFACT_CONTRACT,
    kind: "etsy_publish_readback",
    status,
    taskId: task.id,
    operationId: task.operationId,
    listingDraftId: task.payload.listingDraftId,
    listingId: normalizedListingId,
    listingUrl: normalizedUrl,
    sourceUrl: normalizedUrl || "https://www.etsy.com/",
    failureReason: normalizedFailure,
    capturedAt: timestamp,
    observedAt: timestamp,
    publicPublishPerformed: false,
    credentialsIncluded: false,
  };
}

function bytesToBase64(bytes, btoaImpl) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoaImpl(binary);
}

async function encodeReadbackArtifact(document, { cryptoImpl, btoaImpl }) {
  const content = new globalThis.TextEncoder().encode(JSON.stringify(document));
  const digest = new Uint8Array(await cryptoImpl.subtle.digest("SHA-256", content));
  return {
    sourceUrl: document.sourceUrl,
    capturedAt: document.capturedAt,
    mimeType: "application/json",
    encoding: "base64",
    contentBase64: bytesToBase64(content, btoaImpl),
    sha256: [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    redactionStatus: "verified",
  };
}

export function createEtsyAdsPowerTaskAdapter({
  request,
  storage,
  now = () => Date.now(),
  cryptoImpl = globalThis.crypto,
  btoaImpl = globalThis.btoa,
} = {}) {
  if (typeof request !== "function") throw new TypeError("request is required");
  if (!storage?.get || !storage?.set || !storage?.remove) throw new TypeError("storage is required");
  if (!cryptoImpl?.subtle || typeof btoaImpl !== "function") throw new TypeError("Web Crypto and base64 encoding are required");

  const readActive = async () => (await storage.get([ETSY_ADSPOWER_ACTIVE_TASK_KEY]))[ETSY_ADSPOWER_ACTIVE_TASK_KEY] || null;
  const saveActive = async (record) => {
    if (!record) {
      await storage.remove([ETSY_ADSPOWER_ACTIVE_TASK_KEY]);
      return null;
    }
    await storage.set({ [ETSY_ADSPOWER_ACTIVE_TASK_KEY]: record });
    return record;
  };

  const next = async () => {
    const result = await request(`/api/tasks/next?capability=${ETSY_ADSPOWER_CAPABILITY}`);
    if (result.task) assertEtsyAdsPowerTask(result.task);
    return result;
  };

  const resumable = async () => {
    const result = await request(`/api/tasks/resumable?capability=${ETSY_ADSPOWER_CAPABILITY}`);
    if (result.task) assertEtsyAdsPowerTask(result.task);
    return result;
  };

  const claim = async (taskId) => {
    const id = requiredText(taskId, "taskId", 180);
    const result = await request(`/api/tasks/${encodeURIComponent(id)}/claim`, { method: "POST" });
    assertEtsyAdsPowerTask(result.task, { requireLease: true, now: now() });
    await saveActive({ task: result.task, reconciliationRequired: false, platformObservation: null });
    return result;
  };

  const resume = async (task = null) => {
    const record = task ? { task } : await readActive();
    const current = record?.task || record;
    assertEtsyAdsPowerTask(current);
    if (!RESUMABLE_STATUSES.has(current.status)) throw adapterError("ETSY_TASK_NOT_RESUMABLE", "The Etsy task is not in a resumable state.");
    const result = await request(`/api/tasks/${encodeURIComponent(current.id)}/resume`, { method: "POST" });
    assertEtsyAdsPowerTask(result.task, { requireLease: true, now: now() });
    await saveActive({ ...(record?.task ? record : {}), task: result.task, reconciliationRequired: false });
    return result;
  };

  const active = async ({ refresh = true } = {}) => {
    const record = await readActive();
    if (!record?.task) return null;
    if (!refresh) return record;
    const result = await request(`/api/tasks/${encodeURIComponent(record.task.id)}`);
    if (!result.task || TERMINAL_STATUSES.has(result.task.status)) {
      if (result.task?.publishReadback) return { ...record, task: result.task, terminal: true };
      await saveActive(null);
      return null;
    }
    assertEtsyAdsPowerTask(result.task);
    const updated = { ...record, task: result.task };
    await saveActive(updated);
    return updated;
  };

  const heartbeat = async () => {
    const record = await readActive();
    if (!record?.task || !RESUMABLE_STATUSES.has(record.task.status)) return { heartbeat: false, reason: "no_active_task" };
    try {
      const result = await request(`/api/tasks/${encodeURIComponent(record.task.id)}/heartbeat`, { method: "POST" });
      const task = { ...record.task, lease: result.lease };
      await saveActive({ ...record, task, leaseLost: false });
      return { heartbeat: true, taskId: task.id, lease: result.lease };
    } catch (error) {
      await saveActive({ ...record, leaseLost: true, leaseError: String(error.message || error).slice(0, 1_000) });
      throw adapterError("ETSY_TASK_LEASE_LOST", "The Etsy task heartbeat failed; stop all page writes until the task is explicitly resumed.");
    }
  };

  const checkpoint = async (values = {}) => {
    const record = await readActive();
    const task = record?.task;
    assertEtsyAdsPowerTask(task, { requireLease: true, now: now() });
    const payload = buildEtsyTaskCheckpoint(task, values);
    const result = await request(`/api/tasks/${encodeURIComponent(task.id)}/checkpoint`, { method: "POST", body: JSON.stringify(payload) });
    await saveActive({ ...record, task: result.task });
    return result;
  };

  const preflight = async () => {
    const record = await readActive();
    if (!record?.task) throw adapterError("ETSY_TASK_MISSING", "No claimed Etsy AdsPower task is stored locally.");
    const taskResult = await request(`/api/tasks/${encodeURIComponent(record.task.id)}`);
    const operationResult = await request(`/api/operations/${encodeURIComponent(taskResult.task?.operationId || record.task.operationId)}`);
    const verified = assertEtsyDraftPreflight(taskResult.task, operationResult.operation, { now: now() });
    await saveActive({ ...record, task: verified.task, preflightVerifiedAt: new Date(now()).toISOString(), listingDraft: verified.listingDraft });
    await checkpoint({ stage: "preflight_verified", nextHumanAction: "Open the approved Etsy draft workflow and keep public publishing disabled." });
    return verified;
  };

  const pauseForVerification = async ({ stage = "human_verification_required", pageUrl = "", reason = "Human verification is required." } = {}) => {
    return checkpoint({ state: "paused_for_verification", stage, pageUrl, pausedReason: reason, nextHumanAction: reason });
  };

  const uploadArtifact = async (task, document) => {
    const payload = await encodeReadbackArtifact(document, { cryptoImpl, btoaImpl });
    const result = await request(`/api/tasks/${encodeURIComponent(task.id)}/artifacts`, { method: "POST", body: JSON.stringify(payload) });
    const artifactRef = requiredText(result.artifact?.storageRef, "artifact.storageRef", 2_000);
    return { artifact: result.artifact, artifactRef };
  };

  const reconcile = async () => {
    const record = await readActive();
    if (!record?.task) return { reconciled: false, status: "no_active_task" };
    const taskResult = await request(`/api/tasks/${encodeURIComponent(record.task.id)}`);
    const operationResult = await request(`/api/operations/${encodeURIComponent(record.task.operationId)}`);
    const draft = operationResult.operation?.listingDrafts?.find((candidate) => candidate.id === record.task.payload.listingDraftId);
    const serverReadback = taskResult.task?.publishReadback;
    if (serverReadback && draft?.readback
      && serverReadback.taskId === record.task.id
      && serverReadback.operationId === record.task.operationId
      && serverReadback.listingDraftId === record.task.payload.listingDraftId
      && draft.readback.artifactRef === serverReadback.artifactRef) {
      await saveActive(null);
      return { reconciled: true, status: serverReadback.status, task: taskResult.task, listingDraft: draft, operation: operationResult.operation };
    }
    await saveActive({ ...record, task: taskResult.task, reconciliationRequired: true });
    return { reconciled: false, status: taskResult.task?.status || "unknown", retrySubmissionAllowed: false, task: taskResult.task, listingDraft: draft || null };
  };

  const recordReadback = async ({ status, listingId = "", listingUrl = "", failureReason = "", observedAt, humanConfirmedDraftSaved = false } = {}) => {
    if (status === "uploaded" && humanConfirmedDraftSaved !== true) {
      throw adapterError("ETSY_HUMAN_CONFIRMATION_REQUIRED", "Confirm the visible Etsy draft ID and URL before recording an uploaded readback.");
    }
    const verified = await preflight();
    await heartbeat();
    const document = buildEtsyReadbackDocument(verified.task, { status, listingId, listingUrl, failureReason, observedAt });
    await checkpoint({ stage: status === "uploaded" ? "platform_draft_observed" : "platform_write_failed", pageUrl: document.listingUrl || document.sourceUrl, nextHumanAction: "Persist the redacted readback Artifact and reconcile the Control Center terminal state." });
    const { artifact, artifactRef } = await uploadArtifact(verified.task, document);
    await checkpoint({ stage: "readback_artifact_uploaded", pageUrl: document.listingUrl || document.sourceUrl, nextHumanAction: "Record the task readback once; do not repeat the Etsy page action." });
    const body = {
      contractVersion: ETSY_ADSPOWER_READBACK_CONTRACT,
      taskId: verified.task.id,
      operationId: verified.task.operationId,
      listingDraftId: verified.task.payload.listingDraftId,
      status,
      artifactRef,
      listingId: document.listingId,
      draftUrl: document.listingUrl,
      failureReason: document.failureReason,
      observedAt: document.observedAt,
    };
    try {
      const result = await request(`/api/tasks/${encodeURIComponent(verified.task.id)}/readback`, { method: "POST", body: JSON.stringify(body) });
      if (result.readbackRecorded !== true || result.externalActionPerformed !== false
        || result.readback?.taskId !== verified.task.id
        || result.readback?.operationId !== verified.task.operationId
        || result.readback?.listingDraftId !== verified.task.payload.listingDraftId
        || result.readback?.artifactRef !== artifactRef) {
        throw adapterError("ETSY_READBACK_RECONCILIATION_REQUIRED", "Control Center returned an inconsistent Etsy readback; reconcile before any retry.");
      }
      const record = await readActive();
      await saveActive({ ...record, task: result.task, platformObservation: document, artifactRef, reconciliationRequired: false });
      const reconciled = await reconcile();
      if (!reconciled.reconciled) throw adapterError("ETSY_READBACK_RECONCILIATION_REQUIRED", "Etsy readback was submitted but terminal readback reconciliation is incomplete.");
      return { ...result, artifact, reconciliation: reconciled };
    } catch (error) {
      const record = await readActive();
      await saveActive({ ...record, platformObservation: document, artifactRef, reconciliationRequired: true, retrySubmissionAllowed: false, readbackError: String(error.message || error).slice(0, 1_000) });
      if (error.code === "ETSY_READBACK_RECONCILIATION_REQUIRED") throw error;
      throw adapterError("ETSY_READBACK_RECONCILIATION_REQUIRED", "The Etsy page result was observed, but Control Center readback is uncertain. Reconcile the task; do not repeat the Etsy page action.");
    }
  };

  return {
    next,
    resumable,
    claim,
    resume,
    active,
    heartbeat,
    checkpoint,
    preflight,
    pauseForVerification,
    recordUploaded: (input = {}) => recordReadback({ ...input, status: "uploaded" }),
    recordFailed: (input = {}) => recordReadback({ ...input, status: "failed" }),
    reconcile,
    clearActive: () => saveActive(null),
  };
}
