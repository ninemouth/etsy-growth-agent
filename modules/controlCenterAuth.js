import { createDeviceProof, encodeDeviceProof, getInstallationIdentity } from "./deviceProof.js";

const DEFAULT_CONTROL_CENTER_ORIGIN = "https://www.marqel.shop";
export const CLIENT_ID = "etsy-growth-agent";
const DEVICE_NAME = "Etsy Growth Agent（AdsPower Etsy 运营）";
const SESSION_KEY = "marqelControlCenterSession";
const REFRESH_TOKEN_KEY = "marqelControlCenterRefreshToken";
const CONFIG_KEY = "marqelClientConfig";
const PENDING_DEVICE_KEY = "marqelControlCenterPendingDevice";

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

function publicSession(session = {}, extra = {}) {
  return {
    accessToken: session.accessToken,
    expiresAt: session.expiresAt,
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
    clientType: pending.clientType || "chrome_extension",
    clientId: pending.clientId || CLIENT_ID,
    reused: Boolean(pending.reused),
  };
}

function publicAuthSession(session = {}, extra = {}) {
  return {
    status: extra.status || "authorized",
    user: session.user,
    expiresAt: session.expiresAt,
    authVersion: Number(session.authVersion || 2),
    clientId: session.clientId || CLIENT_ID,
    deviceId: session.deviceId || "",
    configStatus: extra.configStatus || "not_synced",
  };
}

async function storedRefreshToken() {
  const data = await storageGet(chrome.storage.local, [REFRESH_TOKEN_KEY]);
  return String(data[REFRESH_TOKEN_KEY] || "");
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
  };
  await storageSet(accessSessionStore(), { [SESSION_KEY]: session });
  if (result.refreshToken) await storageSet(chrome.storage.local, { [REFRESH_TOKEN_KEY]: result.refreshToken });
  return publicSession(session, { configStatus });
}

async function clearStoredSession() {
  await Promise.all([
    storageRemove(accessSessionStore(), [SESSION_KEY]),
    storageRemove(chrome.storage.local, [REFRESH_TOKEN_KEY, CONFIG_KEY, PENDING_DEVICE_KEY]),
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
    storageGet(chrome.storage.local, [REFRESH_TOKEN_KEY]),
  ]);
  const session = access[SESSION_KEY] || null;
  return session ? { ...session, refreshToken: String(refresh[REFRESH_TOKEN_KEY] || "") } : null;
}

async function applyClientConfig(config) {
  if (!config) return null;
  const current = await storageGet(chrome.storage.local, [
    "apiKey", "llmProvider", "llmModel", "llmFallbackModels", "llmBaseUrl", "temperature",
    "imageGenerationModel", "imageProvider", "imageBaseUrl", "imageApiKey", "llmVisionModel",
  ]);
  const llm = config.llm || {};
  const image = config.image || {};
  const next = {
    marqelClientConfig: config,
    marqelClientConfigRevision: Number(config.revision || 0),
  };
  const setIfConfigured = (key, value) => {
    if (value !== undefined && value !== null && String(value).trim() !== "") next[key] = value;
  };
  setIfConfigured("apiKey", llm.apiKey || current.apiKey);
  setIfConfigured("llmProvider", llm.provider || current.llmProvider);
  setIfConfigured("llmModel", llm.model || current.llmModel);
  setIfConfigured("llmFallbackModels", Array.isArray(llm.fallbackModels) ? llm.fallbackModels.join("\n") : current.llmFallbackModels);
  setIfConfigured("llmBaseUrl", llm.baseUrl || current.llmBaseUrl);
  setIfConfigured("llmVisionModel", llm.visionModel || current.llmVisionModel);
  if (llm.temperature !== undefined && llm.temperature !== null) next.temperature = llm.temperature;
  setIfConfigured("imageGenerationModel", image.model || current.imageGenerationModel);
  setIfConfigured("imageProvider", image.provider || current.imageProvider);
  setIfConfigured("imageBaseUrl", image.baseUrl || current.imageBaseUrl);
  setIfConfigured("imageApiKey", image.apiKey || current.imageApiKey);
  await storageSet(chrome.storage.local, next);
  return config;
}

async function syncClientConfigForSession(session) {
  const result = await request(`/api/client-config?targetId=${encodeURIComponent(CLIENT_ID)}`, {
    headers: { Authorization: `Bearer ${session.accessToken}` },
  }, session);
  if (result.config) await applyClientConfig(result.config);
  else await storageRemove(chrome.storage.local, [CONFIG_KEY]);
  return result;
}

async function refreshStoredSession(session) {
  const refreshToken = session?.refreshToken || await storedRefreshToken();
  if (!refreshToken) throw new Error("请重新登录 Marqel，当前插件没有可轮换的设备会话。");
  const proof = await createDeviceProof("POST", "/api/auth/refresh");
  const result = await request("/api/auth/refresh", {
    method: "POST",
    body: JSON.stringify({ refreshToken, clientId: CLIENT_ID, proof }),
  });
  const saved = await saveSession(result);
  try {
    const config = await syncClientConfigForSession(saved);
    return { ...saved, configStatus: config.status || "synced" };
  } catch {
    return { ...saved, configStatus: "sync_failed" };
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
      clientType: "chrome_extension",
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
    clientType: result.clientType || "chrome_extension",
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

export async function signOut() {
  await clearStoredSession();
}
