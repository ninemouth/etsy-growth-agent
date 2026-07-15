// Global foreground workflow scheduler for the MV3 service worker.
// It gives every UI entrypoint the same runtime truth instead of letting each
// port decide independently whether a workflow may start.

const SCHEDULER_STORAGE_KEY = "etsyWorkflowSchedulerState";
const DEFAULT_SLOT_TTL_MS = 90_000;
let memoryState = {
  active: null,
  updatedAt: "",
};

function nowIso() {
  return new Date().toISOString();
}

function hasStorage() {
  return typeof chrome !== "undefined" && chrome.storage?.local;
}

function clone(value) {
  if (typeof globalThis.structuredClone === "function") return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

async function readState() {
  if (!hasStorage()) return clone(memoryState);
  const data = await new Promise((resolve) => chrome.storage.local.get([SCHEDULER_STORAGE_KEY], resolve));
  return data[SCHEDULER_STORAGE_KEY] || clone(memoryState);
}

async function writeState(state) {
  const next = {
    active: state.active || null,
    updatedAt: nowIso(),
  };
  memoryState = clone(next);
  if (hasStorage()) {
    await new Promise((resolve) => chrome.storage.local.set({ [SCHEDULER_STORAGE_KEY]: next }, resolve));
  }
  return clone(next);
}

function isSlotActive(slot = null, now = Date.now()) {
  return Boolean(slot?.ownerId && Number(slot.expiresAt || 0) > now && !["completed", "failed", "interrupted", "released"].includes(String(slot.status || "")));
}

export async function acquireWorkflowSlot({
  ownerId,
  workflowId = "",
  skillId = "",
  growthActionId = "",
  source = "unknown",
  ttlMs = DEFAULT_SLOT_TTL_MS,
} = {}) {
  if (!ownerId) throw new Error("ownerId is required");
  const state = await readState();
  const now = Date.now();
  if (isSlotActive(state.active, now) && state.active.ownerId !== ownerId) {
    return {
      ok: false,
      active: clone(state.active),
      message: "当前已有任务正在运行。请等待完成、暂停后恢复，或在历史会话中选择需要继续的任务。",
    };
  }
  const active = {
    ownerId,
    workflowId: workflowId || state.active?.workflowId || "",
    skillId,
    growthActionId,
    source,
    status: "running",
    startedAt: state.active?.ownerId === ownerId ? state.active.startedAt : nowIso(),
    updatedAt: nowIso(),
    expiresAt: now + Math.max(15_000, Number(ttlMs) || DEFAULT_SLOT_TTL_MS),
  };
  await writeState({ active });
  return { ok: true, active: clone(active) };
}

export async function updateWorkflowSlot(ownerId, patch = {}) {
  const state = await readState();
  if (!state.active || state.active.ownerId !== ownerId) return { ok: false, active: state.active || null };
  const active = {
    ...state.active,
    ...patch,
    updatedAt: nowIso(),
  };
  if (patch.ttlMs) active.expiresAt = Date.now() + Math.max(15_000, Number(patch.ttlMs) || DEFAULT_SLOT_TTL_MS);
  await writeState({ active });
  return { ok: true, active: clone(active) };
}

export async function renewWorkflowSlot(ownerId, ttlMs = DEFAULT_SLOT_TTL_MS) {
  return updateWorkflowSlot(ownerId, {
    ttlMs,
    status: "running",
  });
}

export async function releaseWorkflowSlot(ownerId, status = "released") {
  const state = await readState();
  if (!state.active || state.active.ownerId !== ownerId) return { ok: false, active: state.active || null };
  const released = {
    ...state.active,
    status,
    releasedAt: nowIso(),
    expiresAt: 0,
    updatedAt: nowIso(),
  };
  await writeState({ active: null });
  return { ok: true, released };
}

export async function getWorkflowSchedulerState() {
  const state = await readState();
  if (state.active && !isSlotActive(state.active)) {
    const released = {
      ...state.active,
      status: "expired",
      releasedAt: nowIso(),
      expiresAt: 0,
    };
    await writeState({ active: null });
    return { active: null, expired: released, updatedAt: nowIso() };
  }
  return clone(state);
}

export async function clearWorkflowSchedulerState() {
  return await writeState({ active: null });
}

export const __testInternals = {
  SCHEDULER_STORAGE_KEY,
  memoryState,
  isSlotActive,
};
