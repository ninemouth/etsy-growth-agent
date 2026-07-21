// Central ownership for workflow-created browser tabs.
// Tools may still use the Chrome API directly for legacy paths, but Etsy crawl
// jobs use this manager so cleanup is tied to workflow ownership.

const ownedTabs = new Map();
const protectedTabs = new Map();
const STORAGE_KEY = "etsyWorkflowBrowserSessionTabs";
let hydrationPromise = hydrateFromStorage();
let saveTimer = null;

function hasStorage() {
  return typeof chrome !== "undefined" && chrome.storage?.local;
}

function serializeMap(map) {
  return Object.fromEntries(
    Array.from(map.entries()).map(([workflowId, ids]) => [
      workflowId,
      Array.from(ids).filter((id) => Number.isInteger(Number(id))).map(Number),
    ])
  );
}

function mergeSerializedMap(map, value = {}) {
  Object.entries(value || {}).forEach(([workflowId, ids]) => {
    if (!map.has(workflowId)) map.set(workflowId, new Set());
    const target = map.get(workflowId);
    (Array.isArray(ids) ? ids : []).forEach((id) => {
      const normalized = Number(id);
      if (Number.isInteger(normalized)) target.add(normalized);
    });
  });
}

async function hydrateFromStorage() {
  if (!hasStorage()) return;
  try {
    const data = await new Promise((resolve) => chrome.storage.local.get([STORAGE_KEY], resolve));
    const stored = data[STORAGE_KEY] || {};
    mergeSerializedMap(ownedTabs, stored.ownedTabs || {});
    mergeSerializedMap(protectedTabs, stored.protectedTabs || {});
  } catch (err) {
    console.warn("Could not hydrate workflow browser session tabs:", err.message);
  }
}

async function persistToStorage() {
  if (!hasStorage()) return;
  await hydrationPromise;
  const payload = {
    ownedTabs: serializeMap(ownedTabs),
    protectedTabs: serializeMap(protectedTabs),
    updatedAt: new Date().toISOString(),
  };
  await new Promise((resolve) => chrome.storage.local.set({ [STORAGE_KEY]: payload }, resolve));
}

function scheduleSave() {
  if (!hasStorage()) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persistToStorage().catch((err) => console.warn("Could not persist workflow browser session tabs:", err.message));
  }, 0);
}

async function ensureHydrated() {
  await hydrationPromise;
}

function workflowTabs(workflowId = "default") {
  if (!ownedTabs.has(workflowId)) ownedTabs.set(workflowId, new Set());
  return ownedTabs.get(workflowId);
}

function workflowProtectedTabs(workflowId = "default") {
  if (!protectedTabs.has(workflowId)) protectedTabs.set(workflowId, new Set());
  return protectedTabs.get(workflowId);
}

async function focusCreatedTab(tab) {
  if (!tab?.id) return false;
  try {
    await new Promise((resolve) => chrome.tabs.update(tab.id, { active: true }, () => resolve()));
    if (Number.isInteger(Number(tab.windowId)) && chrome.windows?.update) {
      await new Promise((resolve) => chrome.windows.update(tab.windowId, { focused: true }, () => resolve()));
    }
    return true;
  } catch (_) {
    return false;
  }
}

export function protectWorkflowTab(workflowId = "default", tabId) {
  const id = Number(tabId);
  if (Number.isInteger(id)) {
    workflowProtectedTabs(workflowId).add(id);
    scheduleSave();
  }
}

export function isProtectedWorkflowTab(workflowId = "default", tabId) {
  const id = Number(tabId);
  return Number.isInteger(id) && Boolean(protectedTabs.get(workflowId)?.has(id));
}

export async function createOwnedTab({ workflowId = "default", url, active = false, openerTabId = null } = {}) {
  if (!url) throw new Error("url is required");
  await ensureHydrated();
  const tab = await new Promise((resolve, reject) => {
    const createArgs = { url, active };
    if (Number.isInteger(Number(openerTabId))) createArgs.openerTabId = Number(openerTabId);
    chrome.tabs.create(createArgs, (created) => {
      if (chrome.runtime.lastError || !created) {
        reject(new Error(chrome.runtime.lastError?.message || "Failed to create owned tab"));
      } else {
        resolve(created);
      }
    });
  });
  workflowTabs(workflowId).add(tab.id);
  scheduleSave();
  if (active) await focusCreatedTab(tab);
  return tab;
}

export function createOwnedTabCallback({ workflowId = "default", url, active = false, openerTabId = null } = {}, callback) {
  const createArgs = { url, active };
  if (Number.isInteger(Number(openerTabId))) createArgs.openerTabId = Number(openerTabId);
  chrome.tabs.create(createArgs, async (tab) => {
    if (!chrome.runtime.lastError && tab?.id !== undefined) {
      workflowTabs(workflowId).add(tab.id);
      scheduleSave();
      if (active) await focusCreatedTab(tab);
    }
    callback(tab);
  });
}

export function registerOwnedTab(workflowId = "default", tabId) {
  if (Number.isInteger(Number(tabId))) {
    workflowTabs(workflowId).add(Number(tabId));
    scheduleSave();
  }
}

export async function closeOwnedTab(workflowId = "default", tabId) {
  await ensureHydrated();
  const id = Number(tabId);
  if (!Number.isInteger(id)) return false;
  if (isProtectedWorkflowTab(workflowId, id)) {
    ownedTabs.get(workflowId)?.delete(id);
    scheduleSave();
    return false;
  }
  try {
    await chrome.tabs.remove(id);
  } catch (_) {
    // The tab may already have been closed by the user or browser.
  }
  ownedTabs.get(workflowId)?.delete(id);
  scheduleSave();
  return true;
}

export async function cleanupOwnedTabs(workflowId = "default") {
  await ensureHydrated();
  const protectedIds = protectedTabs.get(workflowId) || new Set();
  const ids = Array.from(ownedTabs.get(workflowId) || []).filter((id) => !protectedIds.has(id));
  await Promise.all(ids.map((id) => closeOwnedTab(workflowId, id)));
  ownedTabs.delete(workflowId);
  protectedTabs.delete(workflowId);
  await persistToStorage().catch((err) => console.warn("Could not persist workflow browser session cleanup:", err.message));
  return ids;
}

export function listOwnedTabs(workflowId = "default") {
  return Array.from(ownedTabs.get(workflowId) || []);
}

export const __testInternals = { ownedTabs, protectedTabs, STORAGE_KEY, focusCreatedTab, hydrateFromStorage, persistToStorage, serializeMap };
