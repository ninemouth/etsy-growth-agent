// modules/updateManager.js - Chrome extension update awareness and release checks

const UPDATE_STATUS_KEY = "extensionUpdateStatus";
const UPDATE_SETTINGS_KEY = "extensionUpdateSettings";
const UPDATE_ALARM_NAME = "etsy_growth_agent_update_check";
const DEFAULT_CHECK_INTERVAL_MINUTES = 12 * 60;
const DEFAULT_RELEASE_MANIFEST_URL = "https://github.com/ninemouth/etsy-growth-agent/releases/latest/download/release-manifest.json";

function nowIso() {
  return new Date().toISOString();
}

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function storageSet(payload) {
  return new Promise((resolve) => chrome.storage.local.set(payload, resolve));
}

function getManifestVersion() {
  return chrome.runtime.getManifest().version || "0.0.0";
}

function normalizeVersionPart(part = "") {
  const value = String(part || "").match(/\d+/)?.[0] || "0";
  return Number.parseInt(value, 10) || 0;
}

export function compareVersions(a = "", b = "") {
  const left = String(a || "").split(".").map(normalizeVersionPart);
  const right = String(b || "").split(".").map(normalizeVersionPart);
  const length = Math.max(left.length, right.length, 3);
  for (let i = 0; i < length; i++) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

async function getUpdateSettings() {
  const stored = await storageGet([UPDATE_SETTINGS_KEY]);
  const settings = stored[UPDATE_SETTINGS_KEY] || {};
  return {
    releaseManifestUrl: settings.releaseManifestUrl || DEFAULT_RELEASE_MANIFEST_URL,
    autoCheckEnabled: settings.autoCheckEnabled !== false,
    autoApplyRuntimeUpdates: settings.autoApplyRuntimeUpdates !== false,
    checkIntervalMinutes: Number(settings.checkIntervalMinutes || DEFAULT_CHECK_INTERVAL_MINUTES),
  };
}

async function saveUpdateStatus(patch = {}) {
  const stored = await storageGet([UPDATE_STATUS_KEY]);
  const current = stored[UPDATE_STATUS_KEY] || {};
  const next = {
    ...current,
    ...patch,
    currentVersion: getManifestVersion(),
    updatedAt: nowIso(),
  };
  await storageSet({ [UPDATE_STATUS_KEY]: next });
  return next;
}

function requestRuntimeUpdateCheck() {
  return new Promise((resolve) => {
    if (!chrome.runtime.requestUpdateCheck) {
      resolve({ status: "unsupported", details: null, error: "" });
      return;
    }
    chrome.runtime.requestUpdateCheck((status, details) => {
      const error = chrome.runtime.lastError?.message || "";
      resolve({ status: status || (error ? "error" : "unknown"), details: details || null, error });
    });
  });
}

async function fetchReleaseManifest(url) {
  if (!url) return { skipped: true, reason: "release_manifest_url_not_configured" };
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }
    const data = await response.json();
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function normalizeReleaseManifest(data = {}) {
  const latestVersion = data.latest_version || data.version || "";
  return {
    latestVersion,
    releaseUrl: data.release_url || data.html_url || data.download_url || "",
    downloadUrl: data.download_url || "",
    changelog: data.changelog || data.notes || "",
    publishedAt: data.published_at || data.date || "",
    minimumChromeVersion: data.minimum_chrome_version || "",
  };
}

export async function checkForUpdates({ force = false } = {}) {
  const settings = await getUpdateSettings();
  const currentVersion = getManifestVersion();
  const runtimeCheck = await requestRuntimeUpdateCheck();
  const releaseResult = await fetchReleaseManifest(settings.releaseManifestUrl);
  const release = releaseResult.ok ? normalizeReleaseManifest(releaseResult.data) : null;
  const releaseUpdateAvailable = Boolean(release?.latestVersion && compareVersions(release.latestVersion, currentVersion) > 0);
  const runtimeUpdateAvailable = runtimeCheck.status === "update_available";
  const next = await saveUpdateStatus({
    currentVersion,
    force,
    lastCheckedAt: nowIso(),
    runtimeStatus: runtimeCheck.status,
    runtimeError: runtimeCheck.error || "",
    pendingRuntimeVersion: runtimeCheck.details?.version || "",
    runtimeUpdateAvailable,
    releaseManifestUrl: settings.releaseManifestUrl,
    releaseManifestConfigured: Boolean(settings.releaseManifestUrl),
    releaseManifestStatus: releaseResult.skipped ? "not_configured" : releaseResult.ok ? "ok" : "error",
    releaseManifestError: releaseResult.error || "",
    latestReleaseVersion: release?.latestVersion || "",
    releaseUpdateAvailable,
    releaseUrl: release?.releaseUrl || "",
    downloadUrl: release?.downloadUrl || "",
    changelog: release?.changelog || "",
    publishedAt: release?.publishedAt || "",
    updateAvailable: runtimeUpdateAvailable || releaseUpdateAvailable,
    updateChannel: runtimeUpdateAvailable ? "chrome_runtime" : releaseUpdateAvailable ? "open_source_release_manifest" : "none",
  });
  return next;
}

export async function markRuntimeUpdateAvailable(details = {}) {
  return await saveUpdateStatus({
    runtimeStatus: "update_available",
    runtimeUpdateAvailable: true,
    updateAvailable: true,
    updateChannel: "chrome_runtime",
    pendingRuntimeVersion: details.version || "",
    updateAvailableAt: nowIso(),
  });
}

export async function getUpdateStatus() {
  const stored = await storageGet([UPDATE_STATUS_KEY, UPDATE_SETTINGS_KEY]);
  const settings = await getUpdateSettings();
  return {
    currentVersion: getManifestVersion(),
    settings,
    status: stored[UPDATE_STATUS_KEY] || {
      currentVersion: getManifestVersion(),
      updateAvailable: false,
      updateChannel: "none",
      runtimeStatus: "not_checked",
      releaseManifestConfigured: Boolean(settings.releaseManifestUrl),
    },
  };
}

export async function saveUpdateSettings(patch = {}) {
  const current = await getUpdateSettings();
  const next = {
    ...current,
    releaseManifestUrl: String(patch.releaseManifestUrl ?? current.releaseManifestUrl ?? "").trim(),
    autoCheckEnabled: patch.autoCheckEnabled !== undefined ? Boolean(patch.autoCheckEnabled) : current.autoCheckEnabled,
    autoApplyRuntimeUpdates: patch.autoApplyRuntimeUpdates !== undefined ? Boolean(patch.autoApplyRuntimeUpdates) : current.autoApplyRuntimeUpdates,
    checkIntervalMinutes: Number(patch.checkIntervalMinutes || current.checkIntervalMinutes || DEFAULT_CHECK_INTERVAL_MINUTES),
  };
  await storageSet({ [UPDATE_SETTINGS_KEY]: next });
  await ensureUpdateAlarm();
  return await getUpdateStatus();
}

export async function ensureUpdateAlarm() {
  const settings = await getUpdateSettings();
  await new Promise((resolve) => chrome.alarms.clear(UPDATE_ALARM_NAME, resolve));
  if (!settings.autoCheckEnabled) return false;
  chrome.alarms.create(UPDATE_ALARM_NAME, {
    delayInMinutes: Math.min(5, Math.max(1, settings.checkIntervalMinutes)),
    periodInMinutes: Math.max(60, settings.checkIntervalMinutes),
  });
  return true;
}

export function isUpdateAlarm(name = "") {
  return name === UPDATE_ALARM_NAME;
}

export async function applyPendingRuntimeUpdate() {
  await saveUpdateStatus({ applyingRuntimeUpdateAt: nowIso() });
  chrome.runtime.reload();
  return { ok: true };
}
