// Durable, privacy-safe task observability for MV3 workflows.
// Logs live in IndexedDB rather than chrome.storage.local so checkpoints and
// credentials are not inflated by high-volume execution telemetry.

const DB_NAME = "etsyGrowthAgentTaskLogs";
const DB_VERSION = 1;
const STORE_NAME = "taskLogs";

export const TASK_LOG_RETENTION = Object.freeze({
  maxAgeMs: 14 * 24 * 60 * 60 * 1000,
  maxEntries: 15_000,
  maxEntriesPerWorkflow: 1_200,
});

const memoryFallback = new Map();
let writeQueue = Promise.resolve();

function nowIso() {
  return new Date().toISOString();
}

function createLogId() {
  return `task_log_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function hasIndexedDb() {
  return typeof globalThis.indexedDB !== "undefined";
}

function openDb() {
  if (!hasIndexedDb()) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("createdAtMs", "createdAtMs", { unique: false });
        store.createIndex("workflowId", "workflowId", { unique: false });
        store.createIndex("sessionId", "sessionId", { unique: false });
        store.createIndex("severity", "severity", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Failed to open task log database"));
  });
}

function closeDb(db) {
  try { db?.close?.(); } catch (_) {}
}

function enqueueWrite(operation) {
  const next = writeQueue.then(operation, operation);
  writeQueue = next.catch(() => {});
  return next;
}

function clone(value) {
  if (typeof globalThis.structuredClone === "function") return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function withStore(mode, callback) {
  return openDb().then((db) => {
    if (!db) return null;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      const store = tx.objectStore(STORE_NAME);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error || new Error("Task log transaction failed"));
      tx.onabort = () => reject(tx.error || new Error("Task log transaction aborted"));
      try {
        callback(store, (value) => { result = value; }, reject);
      } catch (error) {
        try { tx.abort(); } catch (_) {}
        reject(error);
      }
    }).finally(() => closeDb(db));
  });
}

function truncate(value, maxLength = 900) {
  const text = String(value ?? "");
  return text.length > maxLength ? `${text.slice(0, maxLength)}...[truncated]` : text;
}

function isSensitiveKey(key = "") {
  return /(?:api[_-]?key|token|authorization|password|secret|cookie|credential|screenshot|dataurl)/i.test(String(key));
}

export function sanitizeTaskLogValue(value, depth = 0, key = "") {
  if (isSensitiveKey(key)) return "[redacted]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (/^data:/i.test(value) || /(?:bearer\s+|api[_-]?key\s*[:=])/i.test(value)) return "[redacted]";
    return truncate(value);
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 4) return "[max_depth]";
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => sanitizeTaskLogValue(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 40).map(([childKey, childValue]) => [
      childKey,
      sanitizeTaskLogValue(childValue, depth + 1, childKey),
    ]));
  }
  return truncate(value);
}

export async function appendTaskLog({
  workflowId = "",
  sessionId = "",
  skillId = "",
  severity = "info",
  category = "workflow",
  event = "event",
  message = "",
  context = {},
} = {}) {
  const createdAt = nowIso();
  const record = {
    id: createLogId(),
    workflowId: String(workflowId || ""),
    sessionId: String(sessionId || ""),
    skillId: String(skillId || ""),
    severity: ["debug", "info", "warn", "error"].includes(severity) ? severity : "info",
    category: String(category || "workflow"),
    event: String(event || "event"),
    message: truncate(message, 1_200),
    context: sanitizeTaskLogValue(context),
    createdAt,
    createdAtMs: Date.now(),
  };

  return enqueueWrite(async () => {
    memoryFallback.set(record.id, clone(record));
    try {
      const result = await withStore("readwrite", (store, finish, reject) => {
        const request = store.put(record);
        request.onsuccess = () => finish(record);
        request.onerror = () => reject(request.error || new Error("Failed to append task log"));
      });
      return clone(result || record);
    } catch (_) {
      return clone(record);
    }
  });
}

function sortNewestFirst(entries = []) {
  return entries.sort((a, b) => Number(b.createdAtMs || 0) - Number(a.createdAtMs || 0));
}

function selectEntriesToPrune(entries = [], retention = TASK_LOG_RETENTION) {
  const now = Date.now();
  const shouldRemoveByAge = (entry) => Number(entry.createdAtMs || 0) < now - retention.maxAgeMs;
  const newest = sortNewestFirst(entries.slice());
  const workflowCounts = new Map();
  const idsToDelete = new Set();
  newest.forEach((entry, index) => {
    const workflowId = entry.workflowId || "__unscoped__";
    const workflowCount = (workflowCounts.get(workflowId) || 0) + 1;
    workflowCounts.set(workflowId, workflowCount);
    if (shouldRemoveByAge(entry) || index >= retention.maxEntries || workflowCount > retention.maxEntriesPerWorkflow) {
      idsToDelete.add(entry.id);
    }
  });
  return { newest, idsToDelete };
}

export async function listTaskLogs({ workflowId = "", sessionId = "", limit = 300, before = 0 } = {}) {
  const normalizedLimit = Math.max(1, Math.min(Number(limit) || 300, 1_000));
  const filter = (entry) =>
    (!workflowId || entry.workflowId === workflowId) &&
    (!sessionId || entry.sessionId === sessionId) &&
    (!before || Number(entry.createdAtMs || 0) < Number(before));
  try {
    const records = await withStore("readonly", (store, finish, reject) => {
      const request = store.getAll();
      request.onsuccess = () => finish(request.result || []);
      request.onerror = () => reject(request.error || new Error("Failed to list task logs"));
    });
    if (records) return clone(sortNewestFirst(records.filter(filter)).slice(0, normalizedLimit));
  } catch (_) {}
  return clone(sortNewestFirst(Array.from(memoryFallback.values()).filter(filter)).slice(0, normalizedLimit));
}

export async function pruneTaskLogs(policy = {}) {
  const retention = { ...TASK_LOG_RETENTION, ...policy };
  return enqueueWrite(async () => {
    try {
      const records = await withStore("readonly", (store, finish, reject) => {
        const request = store.getAll();
        request.onsuccess = () => finish(request.result || []);
        request.onerror = () => reject(request.error || new Error("Failed to read task logs for pruning"));
      });
      const sourceRecords = records || Array.from(memoryFallback.values());
      const { newest, idsToDelete } = selectEntriesToPrune(sourceRecords, retention);
      if (records && idsToDelete.size > 0) {
        await withStore("readwrite", (store) => {
          idsToDelete.forEach((id) => store.delete(id));
        });
      }
      idsToDelete.forEach((id) => memoryFallback.delete(id));
      return { ok: true, deleted: idsToDelete.size, retained: newest.length - idsToDelete.size };
    } catch (error) {
      const entries = sortNewestFirst(Array.from(memoryFallback.values()));
      const { idsToDelete } = selectEntriesToPrune(entries, retention);
      idsToDelete.forEach((id) => memoryFallback.delete(id));
      return { ok: false, deleted: idsToDelete.size, retained: memoryFallback.size, error: error.message };
    }
  });
}

export async function clearTaskLogs() {
  return enqueueWrite(async () => {
    const memoryCount = memoryFallback.size;
    memoryFallback.clear();
    try {
      const result = await withStore("readwrite", (store, finish) => {
        const request = store.clear();
        request.onsuccess = () => finish({ ok: true, cleared: true });
      });
      return {
        ok: true,
        cleared: true,
        memoryCount,
        indexedDbCleared: Boolean(result?.cleared),
      };
    } catch (error) {
      return {
        ok: false,
        cleared: true,
        memoryCount,
        indexedDbCleared: false,
        error: error.message,
      };
    }
  });
}

export const __testInternals = { memoryFallback, sanitizeTaskLogValue, selectEntriesToPrune };
