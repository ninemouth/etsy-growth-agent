import { createDeviceProof, encodeDeviceProof, getInstallationIdentity } from "./deviceProof.js";

const DEFAULT_CONTROL_CENTER_ORIGIN = "https://www.marqel.shop";
export const CLIENT_ID = "etsy-growth-agent";
export const CLIENT_TYPE = "etsy_adspower";
const DEVICE_NAME = "Etsy Growth Agent（AdsPower Etsy 运营）";
const SESSION_KEY = "marqelControlCenterSession";
const REFRESH_TOKEN_KEY = "marqelControlCenterRefreshToken";
const REFRESH_EXPIRES_AT_KEY = "marqelControlCenterRefreshExpiresAt";
const REFRESH_POLICY_KEY = "marqelControlCenterRefreshPolicy";
const CONFIG_KEY = "marqelClientConfig";
const CONFIG_BACKUP_KEY = "marqelClientConfigBackup";
const MANAGED_LLM_SETTING_KEYS = Object.freeze(["apiKey", "llmProvider", "llmModel", "llmFallbackModels", "llmBaseUrl", "temperature", "llmVisionModel"]);
const MANAGED_IMAGE_SETTING_KEYS = Object.freeze(["imageGenerationModel", "imageProvider", "imageBaseUrl", "imageApiKey"]);
const PENDING_DEVICE_KEY = "marqelControlCenterPendingDevice";
let refreshInFlight = null;

function controlCenterOrigin() {
  const configured = String(globalThis.ETSY_OPS_CONTROL_CENTER || DEFAULT_CONTROL_CENTER_ORIGIN).trim();
  const url = new URL(configured);
  if (url.protocol !== "https:") throw new Error("Marqel Control Center must use HTTPS.");
  return url.origin;
}

function accessSessionStore() {
  return chrome.storage.session || chrome.storage.local;
}

function storageGet(store, keys) {
  return new Promise((resolve) => store.get(keys, resolve));
}

function storageSet(store, value) {
  return new Promise((resolve) => store.set(value, resolve));
}

function storageRemove(store, keys) {
  return new Promise((resolve) => store.remove(keys, resolve));
}

async function request(path, options = {}, session = null) {
  const method = String(options.method || "GET").toUpperCase();
  const url = new URL(path, controlCenterOrigin());
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (session?.accessToken && Number(session.authVersion || 2) === 2) {
    headers["X-Marqel-Device-Proof"] = encodeDeviceProof(await createDeviceProof(method, url.pathname));
  }
  const response = await fetch(`${controlCenterOrigin()}${path}`, {
    ...options,
    headers,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error?.message || "Marqel authorization failed.");
    error.status = response.status;
    error.code = payload.error?.code || "CONTROL_CENTER_ERROR";
    throw error;
  }
  return payload;
}

export async function controlCenterRequest(path, options = {}) {
  let session = await getActiveSession({ revalidate: false });
  if (!session?.accessToken) throw new Error("请先完成 Marqel V2 设备授权，再访问 Control Center 任务。");
  try {
    return await request(path, {
      ...options,
      headers: { Authorization: `Bearer ${session.accessToken}`, ...(options.headers || {}) },
    }, session);
  } catch (error) {
    if (error.status !== 401) throw error;
    const stored = await readStoredSession();
    session = await refreshStoredSession(stored);
    return request(path, {
      ...options,
      headers: { Authorization: `Bearer ${session.accessToken}`, ...(options.headers || {}) },
    }, session);
  }
}

function publicSession(session = {}, extra = {}) {
  return {
    accessToken: session.accessToken,
    expiresAt: session.expiresAt,
    refreshExpiresAt: session.refreshExpiresAt || 0,
    refreshPolicy: session.refreshPolicy || "rolling",
    user: session.user,
    clientId: session.clientId || CLIENT_ID,
    deviceId: session.deviceId || "",
    authVersion: Number(session.authVersion || 1),
    controlCenterOrigin: controlCenterOrigin(),
    ...extra,
  };
}

function publicDeviceRequest(pending = {}) {
  return {
    status: pending.status || "approval_required",
    userCode: pending.userCode || "",
    expiresAt: pending.expiresAt || 0,
    intervalSeconds: Number(pending.intervalSeconds || 5),
    clientType: pending.clientType || CLIENT_TYPE,
    clientId: pending.clientId || CLIENT_ID,
    reused: Boolean(pending.reused),
  };
}

function publicAuthSession(session = {}, extra = {}) {
  return {
    status: extra.status || "authorized",
    user: session.user,
    expiresAt: session.expiresAt,
    refreshExpiresAt: session.refreshExpiresAt || 0,
    refreshPolicy: session.refreshPolicy || "rolling",
    authVersion: Number(session.authVersion || 2),
    clientId: session.clientId || CLIENT_ID,
    deviceId: session.deviceId || "",
    configStatus: extra.configStatus || "not_synced",
  };
}

async function storedRefreshSession() {
  const data = await storageGet(chrome.storage.local, [REFRESH_TOKEN_KEY, REFRESH_EXPIRES_AT_KEY, REFRESH_POLICY_KEY]);
  return {
    refreshToken: String(data[REFRESH_TOKEN_KEY] || ""),
    refreshExpiresAt: Number(data[REFRESH_EXPIRES_AT_KEY] || 0),
    refreshPolicy: String(data[REFRESH_POLICY_KEY] || "rolling"),
  };
}

async function storedConfig() {
  const data = await storageGet(chrome.storage.local, [CONFIG_KEY]);
  return data[CONFIG_KEY] || null;
}

async function saveSession(result, { configStatus = "not_synced" } = {}) {
  const session = {
    accessToken: result.accessToken,
    expiresAt: Date.now() + Number(result.expiresInSeconds || 0) * 1000,
    user: result.user,
    clientId: result.clientId || CLIENT_ID,
    deviceId: result.deviceId || "",
    authVersion: Number(result.authVersion || 1),
    refreshExpiresAt: result.refreshExpiresAt
      ? new Date(result.refreshExpiresAt).getTime()
      : Number(result.refreshExpiresInSeconds || 0) > 0
        ? Date.now() + Number(result.refreshExpiresInSeconds) * 1000
        : 0,
    refreshPolicy: result.refreshPolicy || "rolling",
  };
  await storageSet(accessSessionStore(), { [SESSION_KEY]: session });
  if (result.refreshToken) {
    await storageSet(chrome.storage.local, {
      [REFRESH_TOKEN_KEY]: result.refreshToken,
      [REFRESH_EXPIRES_AT_KEY]: session.refreshExpiresAt,
      [REFRESH_POLICY_KEY]: session.refreshPolicy,
    });
  }
  return publicSession(session, { configStatus });
}

async function clearStoredSession() {
  await restoreClientConfigSettings();
  await Promise.all([
    storageRemove(accessSessionStore(), [SESSION_KEY]),
    storageRemove(chrome.storage.local, [REFRESH_TOKEN_KEY, REFRESH_EXPIRES_AT_KEY, REFRESH_POLICY_KEY, CONFIG_KEY, PENDING_DEVICE_KEY]),
  ]);
}

async function getPendingDeviceAuthorization() {
  const data = await storageGet(chrome.storage.local, [PENDING_DEVICE_KEY]);
  const pending = data[PENDING_DEVICE_KEY] || null;
  if (pending && Number(pending.expiresAt) <= Date.now()) {
    await storageRemove(chrome.storage.local, [PENDING_DEVICE_KEY]);
    return null;
  }
  return pending;
}

async function savePendingDeviceAuthorization(pending) {
  await storageSet(chrome.storage.local, { [PENDING_DEVICE_KEY]: pending });
  return pending;
}

async function openDeviceApproval(verificationUri) {
  if (!verificationUri || !chrome.tabs?.create) return;
  await chrome.tabs.create({ url: verificationUri, active: true });
}

async function readStoredSession() {
  const [access, refresh] = await Promise.all([
    storageGet(accessSessionStore(), [SESSION_KEY]),
    storedRefreshSession(),
  ]);
  const session = access[SESSION_KEY] || null;
  if (!session && !refresh.refreshToken) return null;
  return { ...(session || {}), ...refresh };
}

async function applyClientConfig(config) {
  if (!config) return null;
  const managedKeys = [...MANAGED_LLM_SETTING_KEYS, ...MANAGED_IMAGE_SETTING_KEYS];
  const current = await storageGet(chrome.storage.local, [...managedKeys, CONFIG_BACKUP_KEY]);
  const llm = config.llm || {};
  const image = config.image || {};
  const backup = current[CONFIG_BACKUP_KEY] || Object.fromEntries(managedKeys.filter((key) => Object.hasOwn(current, key) && current[key] !== undefined).map((key) => [key, current[key]]));
  const next = {
    marqelClientConfig: config,
    marqelClientConfigRevision: Number(config.revision || 0),
    [CONFIG_BACKUP_KEY]: backup,
  };
  const removals = [];
  const setManaged = (key, value) => {
    if (value === undefined || value === null || (typeof value === "string" && !value.trim())) removals.push(key);
    else next[key] = value;
  };
  if (llm.enabled !== false) {
    setManaged("apiKey", llm.apiKey);
    setManaged("llmProvider", llm.provider);
    setManaged("llmModel", llm.model);
    setManaged("llmFallbackModels", Array.isArray(llm.fallbackModels) ? llm.fallbackModels.join("\n") : "");
    setManaged("llmBaseUrl", llm.baseUrl);
    setManaged("llmVisionModel", llm.visionModel);
    setManaged("temperature", llm.temperature);
  }
  if (image.enabled !== false) {
    setManaged("imageGenerationModel", image.model);
    setManaged("imageProvider", image.provider);
    setManaged("imageBaseUrl", image.baseUrl);
    setManaged("imageApiKey", image.apiKey);
  }
  await storageSet(chrome.storage.local, next);
  if (removals.length) await storageRemove(chrome.storage.local, removals);
  return config;
}

async function restoreClientConfigSettings() {
  const managedKeys = [...MANAGED_LLM_SETTING_KEYS, ...MANAGED_IMAGE_SETTING_KEYS];
  const stored = await storageGet(chrome.storage.local, [CONFIG_BACKUP_KEY]);
  const backup = stored[CONFIG_BACKUP_KEY];
  if (backup && typeof backup === "object") {
    const restored = Object.fromEntries(managedKeys.filter((key) => Object.hasOwn(backup, key)).map((key) => [key, backup[key]]));
    if (Object.keys(restored).length) await storageSet(chrome.storage.local, restored);
    const absent = managedKeys.filter((key) => !Object.hasOwn(backup, key));
    if (absent.length) await storageRemove(chrome.storage.local, absent);
  }
  await storageRemove(chrome.storage.local, [CONFIG_KEY, CONFIG_BACKUP_KEY, "marqelClientConfigRevision"]);
}

async function syncClientConfigForSession(session) {
  const result = await request(`/api/client-config?targetId=${encodeURIComponent(CLIENT_ID)}`, {
    headers: { Authorization: `Bearer ${session.accessToken}` },
  }, session);
  if (!result.config) {
    await restoreClientConfigSettings();
    return { ...result, status: result.status || "not_configured", config: null };
  }
  await applyClientConfig(result.config);
  await request("/api/client-config/ack", {
    method: "POST",
    headers: { Authorization: `Bearer ${session.accessToken}` },
    body: JSON.stringify({
      contractVersion: "marqel-client-config-ack.v1",
      targetId: CLIENT_ID,
      status: "applied",
      deliveryRevision: result.config.deliveryRevision,
      deliveryDigest: result.config.deliveryDigest,
    }),
  }, session);
  return { ...result, status: "applied", config: result.config };
}

async function refreshStoredSession(session) {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const refresh = session?.refreshToken ? session : await storedRefreshSession();
    if (!refresh.refreshToken) throw new Error("请重新登录 Marqel，当前插件没有可轮换的设备会话。");
    if (Number(refresh.refreshExpiresAt || 0) > 0 && Number(refresh.refreshExpiresAt) <= Date.now()) {
      await clearStoredSession();
      throw new Error("Marqel 长期设备授权已到期，请重新发起设备授权。");
    }
    const proof = await createDeviceProof("POST", "/api/auth/refresh");
    const result = await request("/api/auth/refresh", {
      method: "POST",
      body: JSON.stringify({ refreshToken: refresh.refreshToken, clientId: CLIENT_ID, proof }),
    });
    const saved = await saveSession(result);
    try {
      const config = await syncClientConfigForSession(saved);
      return { ...saved, configStatus: config.status || "synced" };
    } catch {
      return { ...saved, configStatus: "sync_failed" };
    }
  })();
  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

export async function startDeviceAuthorization({ reopen = false } = {}) {
  const existing = await getPendingDeviceAuthorization();
  if (existing?.installationKeyId && !reopen) {
    await openDeviceApproval(existing.verificationUriComplete || existing.verificationUri);
    return publicDeviceRequest({ ...existing, status: "approval_required", reused: true });
  }
  const identity = await getInstallationIdentity();
  const result = await request("/api/auth/device/start", {
    method: "POST",
    body: JSON.stringify({
      clientType: CLIENT_TYPE,
      clientId: CLIENT_ID,
      deviceName: DEVICE_NAME,
      installationPublicKey: identity.publicKey,
      installationKeyId: identity.keyId,
    }),
  });
  const pending = await savePendingDeviceAuthorization({
    deviceCode: result.deviceCode,
    userCode: result.userCode,
    verificationUri: result.verificationUri,
    verificationUriComplete: result.verificationUriComplete,
    expiresAt: Date.now() + Number(result.expiresInSeconds || 600) * 1000,
    intervalSeconds: Number(result.intervalSeconds || 5),
    clientType: result.clientType || CLIENT_TYPE,
    clientId: result.clientId || CLIENT_ID,
    installationKeyId: result.installationKeyId || identity.keyId,
  });
  await openDeviceApproval(pending.verificationUriComplete || pending.verificationUri);
  return publicDeviceRequest(pending);
}

export async function pollDeviceAuthorization() {
  const pending = await getPendingDeviceAuthorization();
  if (!pending) return { status: "idle" };
  let result;
  try {
    const proof = await createDeviceProof("POST", "/api/auth/device/poll");
    result = await request("/api/auth/device/poll", {
      method: "POST",
      body: JSON.stringify({ deviceCode: pending.deviceCode, proof }),
    });
  } catch (error) {
    if (error.status === 428 && error.code === "AUTHORIZATION_PENDING") return publicDeviceRequest({ ...pending, status: "approval_pending" });
    await storageRemove(chrome.storage.local, [PENDING_DEVICE_KEY]);
    throw error;
  }
  if (result.status === "approval_pending") return publicDeviceRequest({ ...pending, ...result });
  await storageRemove(chrome.storage.local, [PENDING_DEVICE_KEY]);
  const session = await saveSession(result);
  try {
    const config = await syncClientConfigForSession(session);
    return publicAuthSession(session, { status: "authorized", configStatus: config.status || "synced" });
  } catch {
    return publicAuthSession(session, { status: "authorized", configStatus: "sync_failed" });
  }
}

export { getPendingDeviceAuthorization };

export async function getActiveSession({ revalidate = false } = {}) {
  let stored = await readStoredSession();
  if (!stored?.accessToken && stored?.refreshToken) return refreshStoredSession(stored);
  if (!stored?.accessToken) return null;
  if (Number(stored.expiresAt) <= Date.now() + 60_000) {
    if (!stored.refreshToken) {
      await clearStoredSession();
      return null;
    }
    return refreshStoredSession(stored);
  }
  if (!revalidate) return publicSession(stored, { config: await storedConfig() });
  try {
    const result = await request("/api/auth/me", { headers: { Authorization: `Bearer ${stored.accessToken}` } }, stored);
    stored = { ...stored, user: result.user };
    await storageSet(accessSessionStore(), { [SESSION_KEY]: {
      accessToken: stored.accessToken,
      expiresAt: stored.expiresAt,
      user: stored.user,
      clientId: stored.clientId || CLIENT_ID,
      deviceId: stored.deviceId || "",
      authVersion: Number(stored.authVersion || 1),
      refreshExpiresAt: stored.refreshExpiresAt || 0,
      refreshPolicy: stored.refreshPolicy || "rolling",
    } });
    let configStatus = "not_synced";
    try {
      const config = await syncClientConfigForSession(stored);
      configStatus = config.status || "synced";
    } catch {
      configStatus = "sync_failed";
    }
    return publicSession(stored, { configStatus, config: await storedConfig() });
  } catch (error) {
    if (error.status === 401 && stored.refreshToken) return refreshStoredSession(stored);
    await clearStoredSession();
    throw error;
  }
}

export async function requireActiveSession() {
  const session = await getActiveSession({ revalidate: true });
  if (!session) throw new Error("请先发起并批准 Marqel V2 设备授权；账号需已启用且订阅有效后才能执行此操作。");
  return session;
}

export async function getLocalClientConfig() {
  return storedConfig();
}

export async function syncClientConfig() {
  const session = await getActiveSession({ revalidate: false });
  if (!session?.accessToken) throw new Error("请先登录 Marqel，再同步 Etsy Growth Agent 配置。");
  const result = await syncClientConfigForSession(session);
  return { ...result, config: await storedConfig() };
}

function sanitizedEtsyIntegration(integration = {}) {
  if (integration.contractVersion !== "marqel-etsy-api-status.v1") throw new Error("Control Center returned an unsupported Etsy API status contract.");
  if (integration.credentialDelivery !== "server_only" || integration.externalActionPerformed !== false) throw new Error("Control Center did not preserve the server-only Etsy credential boundary.");
  return {
    contractVersion: integration.contractVersion,
    configured: Boolean(integration.configured),
    canConfigure: Boolean(integration.canConfigure),
    appType: integration.appType || "seller",
    credentialStatus: integration.credentialStatus || "not_configured",
    oauthStatus: integration.oauthStatus || "not_connected",
    keystringLast4: String(integration.keystring?.last4 || ""),
    scopes: Array.isArray(integration.scopes) ? integration.scopes.map(String) : [],
    applicationId: String(integration.applicationId || ""),
    shop: integration.shop ? { id: String(integration.shop.id || ""), name: String(integration.shop.name || "") } : null,
    accessState: integration.accessState || "not_available",
    refreshState: integration.refreshState || "not_available",
    accessExpiresAt: integration.accessExpiresAt || "",
    refreshExpiresAt: integration.refreshExpiresAt || "",
    updatedAt: integration.updatedAt || "",
    lastErrorCode: integration.lastErrorCode || "",
    dataProxy: integration.dataProxy && typeof integration.dataProxy === "object" ? {
      status: String(integration.dataProxy.status || "unavailable"),
      mode: String(integration.dataProxy.mode || ""),
      source: String(integration.dataProxy.source || ""),
      resources: Array.isArray(integration.dataProxy.resources) ? integration.dataProxy.resources.map(String) : [],
      unsupported: Array.isArray(integration.dataProxy.unsupported) ? integration.dataProxy.unsupported.map(String) : [],
    } : { status: "unavailable", mode: "", source: "", resources: [], unsupported: [] },
    credentialDelivery: "server_only",
    externalActionPerformed: false,
    controlCenterUrl: `${controlCenterOrigin()}/etsy-api.html`,
  };
}

export async function getEtsyIntegrationStatus() {
  const result = await controlCenterRequest("/api/etsy/integration");
  return sanitizedEtsyIntegration(result.integration || {});
}

export async function openEtsyIntegrationConfiguration() {
  const url = `${controlCenterOrigin()}/etsy-api.html`;
  if (!chrome.tabs?.create) throw new Error("当前 Chrome 无法打开 Control Center Etsy API 连接页。");
  await chrome.tabs.create({ url, active: true });
  return { opened: true, url };
}

function installedChromeVersion() {
  return navigator.userAgent.match(/(?:Chrome|Chromium)\/(\d+(?:\.\d+){0,3})/)?.[1] || "0";
}

export async function detectInternalExtensionInstallMode() {
  if (!chrome.management?.getSelf) {
    const error = new Error("当前 Chrome 无法核对插件安装模式；内部发布必须从开发者模式加载 unpacked 目录。");
    error.code = "EXTENSION_INSTALL_MODE_UNAVAILABLE";
    throw error;
  }
  const extension = await chrome.management.getSelf();
  if (extension?.installType !== "development") {
    const error = new Error(`当前插件安装类型为 ${extension?.installType || "unknown"}；内部发布策略只接受开发者模式加载的 unpacked 插件。`);
    error.code = "INTERNAL_UNPACKED_INSTALL_REQUIRED";
    throw error;
  }
  return "unpacked";
}

export async function reportBrowserExtensionInstallation() {
  const session = await getActiveSession({ revalidate: false });
  if (!session?.accessToken) throw new Error("请先完成 Marqel V2 设备授权，再上报插件版本。");
  const installMode = await detectInternalExtensionInstallMode();
  return request("/api/browser-extensions/report", {
    method: "POST",
    headers: { Authorization: `Bearer ${session.accessToken}` },
    body: JSON.stringify({
      contractVersion: "marqel-browser-extension-report.v1",
      extension: {
        id: CLIENT_ID,
        version: chrome.runtime.getManifest().version,
        runtimeExtensionId: chrome.runtime.id || "",
        chromeVersion: installedChromeVersion(),
        platform: "adspower_etsy",
        installMode,
      },
    }),
  }, session);
}

export async function reportBrowserExtensionInstallationStatus() {
  try {
    const result = await reportBrowserExtensionInstallation();
    return {
      ok: true,
      status: "reported",
      state: result.status?.state || result.installation?.state || "reported",
      installedVersion: result.status?.installedVersion || result.installation?.installedVersion || chrome.runtime.getManifest().version,
      runtimeExtensionId: chrome.runtime.id || "",
      installMode: "unpacked",
    };
  } catch (error) {
    return {
      ok: false,
      status: "report_failed",
      state: "not_current",
      error: String(error?.message || error),
      errorCode: error?.code || "EXTENSION_INSTALLATION_REPORT_FAILED",
    };
  }
}

export async function signOut() {
  await clearStoredSession();
}
