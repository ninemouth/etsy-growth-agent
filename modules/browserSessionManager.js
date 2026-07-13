// Central ownership for workflow-created browser tabs.
// Tools may still use the Chrome API directly for legacy paths, but Etsy crawl
// jobs use this manager so cleanup is tied to workflow ownership.

const ownedTabs = new Map();

function workflowTabs(workflowId = "default") {
  if (!ownedTabs.has(workflowId)) ownedTabs.set(workflowId, new Set());
  return ownedTabs.get(workflowId);
}

export async function createOwnedTab({ workflowId = "default", url, active = false, openerTabId = null } = {}) {
  if (!url) throw new Error("url is required");
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
  return tab;
}

export function createOwnedTabCallback({ workflowId = "default", url, active = false, openerTabId = null } = {}, callback) {
  const createArgs = { url, active };
  if (Number.isInteger(Number(openerTabId))) createArgs.openerTabId = Number(openerTabId);
  chrome.tabs.create(createArgs, (tab) => {
    if (!chrome.runtime.lastError && tab?.id !== undefined) workflowTabs(workflowId).add(tab.id);
    callback(tab);
  });
}

export function registerOwnedTab(workflowId = "default", tabId) {
  if (Number.isInteger(Number(tabId))) workflowTabs(workflowId).add(Number(tabId));
}

export async function closeOwnedTab(workflowId = "default", tabId) {
  const id = Number(tabId);
  if (!Number.isInteger(id)) return false;
  try {
    await chrome.tabs.remove(id);
  } catch (_) {
    // The tab may already have been closed by the user or browser.
  }
  ownedTabs.get(workflowId)?.delete(id);
  return true;
}

export async function cleanupOwnedTabs(workflowId = "default") {
  const ids = Array.from(ownedTabs.get(workflowId) || []);
  await Promise.all(ids.map((id) => closeOwnedTab(workflowId, id)));
  ownedTabs.delete(workflowId);
  return ids;
}

export function listOwnedTabs(workflowId = "default") {
  return Array.from(ownedTabs.get(workflowId) || []);
}

export const __testInternals = { ownedTabs };
