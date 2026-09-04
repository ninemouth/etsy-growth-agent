import { createDeviceProof, encodeDeviceProof, getInstallationIdentity } from "./deviceProof.js";

const DEFAULT_CONTROL_CENTER_ORIGIN = "https://www.marqel.shop";
export const CLIENT_ID = "etsy-growth-agent";
export const CLIENT_TYPE = "etsy_adspower";
const DEVICE_NAME = "Marqel Etsy Edge";
const SESSION_KEY = "marqelControlCenterSession";
const REFRESH_TOKEN_KEY = "marqelControlCenterRefreshToken";
const REFRESH_EXPIRES_AT_KEY = "marqelControlCenterRefreshExpiresAt";
const REFRESH_POLICY_KEY = "marqelControlCenterRefreshPolicy";
const PENDING_DEVICE_KEY = "marqelControlCenterPendingDevice";
const RETIRED_CONFIGURATION_KEYS = Object.freeze([
  "apiKey", "llmProvider", "llmModel", "llmFallbackModels", "llmBaseUrl",
  "temperature", "llmVisionModel", "imageGenerationModel", "imageProvider",
  "imageBaseUrl", "imageApiKey", "marqelClientConfig",
  "marqelClientConfigBackup", "marqelClientConfigRevision",
]);
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

async function purgeRetiredConfiguration() {
  await storageRemove(chrome.storage.local, RETIRED_CONFIGURATION_KEYS);
}

async function request(path, options = {}, session = null) {
  const method = String(options.method || "GET").toUpperCase();
  const url = new URL(path, controlCenterOrigin());
  if (url.origin !== controlCenterOrigin()) throw new Error("Control Center request escaped the configured origin.");
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (session?.accessToken && Number(session.authVersion || 2) === 2) {
    headers["X-Marqel-Device-Proof"] = encodeDeviceProof(await createDeviceProof(method, url.pathname));
  }
  const response = await fetch(url.href, { ...options, method, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error?.message || "Marqel authorization failed.");
    error.status = response.status;
    error.code = payload.error?.code || "CONTROL_CENTER_ERROR";
    throw error;
  }
  return payload;
}

function publicSession(session = {}) {
  return {
    accessToken: session.accessToken,
    expiresAt: Number(session.expiresAt || 0),
    refreshExpiresAt: Number(session.refreshExpiresAt || 0),
    refreshPolicy: String(session.refreshPolicy || "rolling"),
    user: session.user || null,
    clientId: String(session.clientId || CLIENT_ID),
    deviceId: String(session.deviceId || ""),
    authVersion: Number(session.authVersion || 2),
    controlCenterOrigin: controlCenterOrigin(),
  };
}

function publicDeviceRequest(pending = {}) {
  return {
    status: pending.status || "approval_required",
    userCode: String(pending.userCode || ""),
    expiresAt: Number(pending.expiresAt || 0),
    intervalSeconds: Number(pending.intervalSeconds || 5),
    clientType: String(pending.clientType || CLIENT_TYPE),
    clientId: String(pending.clientId || CLIENT_ID),
    reused: Boolean(pending.reused),
  };
}

function publicAuthorizedSession(session = {}) {
  return {
    status: "authorized",
    user: session.user || null,
    expiresAt: Number(session.expiresAt || 0),
    refreshExpiresAt: Number(session.refreshExpiresAt || 0),
    refreshPolicy: String(session.refreshPolicy || "rolling"),
    authVersion: Number(session.authVersion || 2),
    clientId: String(session.clientId || CLIENT_ID),
    deviceId: String(session.deviceId || ""),
    configurationMode: "edge_only",
  };
}

async function readStoredSession() {
  const [access, refresh] = await Promise.all([
    storageGet(accessSessionStore(), [SESSION_KEY]),
    storageGet(chrome.storage.local, [REFRESH_TOKEN_KEY, REFRESH_EXPIRES_AT_KEY, REFRESH_POLICY_KEY]),
  ]);
  const session = access[SESSION_KEY] || null;
  const refreshToken = String(refresh[REFRESH_TOKEN_KEY] || "");
  if (!session && !refreshToken) return null;
  return {
    ...(session || {}),
    refreshToken,
    refreshExpiresAt: Number(refresh[REFRESH_EXPIRES_AT_KEY] || session?.refreshExpiresAt || 0),
    refreshPolicy: String(refresh[REFRESH_POLICY_KEY] || session?.refreshPolicy || "rolling"),
  };
}

async function saveSession(result = {}) {
  const session = {
    accessToken: String(result.accessToken || ""),
    expiresAt: Date.now() + Number(result.expiresInSeconds || 0) * 1000,
    user: result.user || null,
    clientId: String(result.clientId || CLIENT_ID),
    deviceId: String(result.deviceId || ""),
    authVersion: Number(result.authVersion || 2),
    refreshExpiresAt: result.refreshExpiresAt
      ? new Date(result.refreshExpiresAt).getTime()
      : Date.now() + Number(result.refreshExpiresInSeconds || 0) * 1000,
    refreshPolicy: String(result.refreshPolicy || "rolling"),
  };
  if (!session.accessToken) throw new Error("Control Center did not return an access token.");
  await Promise.all([
    storageSet(accessSessionStore(), { [SESSION_KEY]: session }),
    result.refreshToken
      ? storageSet(chrome.storage.local, {
        [REFRESH_TOKEN_KEY]: String(result.refreshToken),
        [REFRESH_EXPIRES_AT_KEY]: session.refreshExpiresAt,
        [REFRESH_POLICY_KEY]: session.refreshPolicy,
      })
      : Promise.resolve(),
    purgeRetiredConfiguration(),
  ]);
  return publicSession(session);
}

async function clearStoredSession() {
  await Promise.all([
    storageRemove(accessSessionStore(), [SESSION_KEY]),
    storageRemove(chrome.storage.local, [
      REFRESH_TOKEN_KEY,
      REFRESH_EXPIRES_AT_KEY,
      REFRESH_POLICY_KEY,
      PENDING_DEVICE_KEY,
      ...RETIRED_CONFIGURATION_KEYS,
    ]),
  ]);
}

export async function getPendingDeviceAuthorization() {
  const stored = await storageGet(chrome.storage.local, [PENDING_DEVICE_KEY]);
  const pending = stored[PENDING_DEVICE_KEY] || null;
  if (pending && Number(pending.expiresAt || 0) <= Date.now()) {
    await storageRemove(chrome.storage.local, [PENDING_DEVICE_KEY]);
    return null;
  }
  return pending ? publicDeviceRequest(pending) : null;
}

async function readPrivatePendingDeviceAuthorization() {
  const stored = await storageGet(chrome.storage.local, [PENDING_DEVICE_KEY]);
  const pending = stored[PENDING_DEVICE_KEY] || null;
  if (pending && Number(pending.expiresAt || 0) <= Date.now()) {
    await storageRemove(chrome.storage.local, [PENDING_DEVICE_KEY]);
    return null;
  }
  return pending;
}

async function openDeviceApproval(url) {
  if (url && chrome.tabs?.create) await chrome.tabs.create({ url, active: true });
}

async function refreshStoredSession(session = null) {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const stored = session?.refreshToken ? session : await readStoredSession();
    if (!stored?.refreshToken) throw new Error("请重新连接 Marqel，当前设备没有可轮换的授权。" );
    if (Number(stored.refreshExpiresAt || 0) > 0 && Number(stored.refreshExpiresAt) <= Date.now()) {
      await clearStoredSession();
      throw new Error("Marqel 设备授权已到期，请重新连接。" );
    }
    const proof = await createDeviceProof("POST", "/api/auth/refresh");
    const result = await request("/api/auth/refresh", {
      method: "POST",
      body: JSON.stringify({ refreshToken: stored.refreshToken, clientId: CLIENT_ID, proof }),
    });
    return saveSession(result);
  })();
  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

export async function controlCenterRequest(path, options = {}) {
  let session = await getActiveSession({ revalidate: false });
  if (!session?.accessToken) throw new Error("请先完成 Marqel V2 设备授权，再访问 Web 任务。" );
  const authorized = (current) => ({
    ...options,
    headers: { Authorization: `Bearer ${current.accessToken}`, ...(options.headers || {}) },
  });
  try {
    return await request(path, authorized(session), session);
  } catch (error) {
    if (error.status !== 401) throw error;
    session = await refreshStoredSession(await readStoredSession());
    return request(path, authorized(session), session);
  }
}

export async function startDeviceAuthorization({ reopen = false } = {}) {
  await purgeRetiredConfiguration();
  const existing = await readPrivatePendingDeviceAuthorization();
  if (existing?.installationKeyId && !reopen) {
    await openDeviceApproval(existing.verificationUriComplete || existing.verificationUri);
    return publicDeviceRequest({ ...existing, reused: true });
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
  const pending = {
    deviceCode: result.deviceCode,
    userCode: result.userCode,
    verificationUri: result.verificationUri,
    verificationUriComplete: result.verificationUriComplete,
    expiresAt: Date.now() + Number(result.expiresInSeconds || 600) * 1000,
    intervalSeconds: Number(result.intervalSeconds || 5),
    clientType: result.clientType || CLIENT_TYPE,
    clientId: result.clientId || CLIENT_ID,
    installationKeyId: result.installationKeyId || identity.keyId,
  };
  await storageSet(chrome.storage.local, { [PENDING_DEVICE_KEY]: pending });
  await openDeviceApproval(pending.verificationUriComplete || pending.verificationUri);
  return publicDeviceRequest(pending);
}

export async function pollDeviceAuthorization() {
  const pending = await readPrivatePendingDeviceAuthorization();
  if (!pending) return { status: "idle" };
  let result;
  try {
    const proof = await createDeviceProof("POST", "/api/auth/device/poll");
    result = await request("/api/auth/device/poll", {
      method: "POST",
      body: JSON.stringify({ deviceCode: pending.deviceCode, proof }),
    });
  } catch (error) {
    if (error.status === 428 && error.code === "AUTHORIZATION_PENDING") {
      return publicDeviceRequest({ ...pending, status: "approval_pending" });
    }
    await storageRemove(chrome.storage.local, [PENDING_DEVICE_KEY]);
    throw error;
  }
  if (result.status === "approval_pending") return publicDeviceRequest({ ...pending, ...result });
  await storageRemove(chrome.storage.local, [PENDING_DEVICE_KEY]);
  return publicAuthorizedSession(await saveSession(result));
}

export async function getActiveSession({ revalidate = false } = {}) {
  let stored = await readStoredSession();
  if (!stored?.accessToken && stored?.refreshToken) return refreshStoredSession(stored);
  if (!stored?.accessToken) return null;
  if (Number(stored.expiresAt || 0) <= Date.now() + 60_000) {
    if (!stored.refreshToken) {
      await clearStoredSession();
      return null;
    }
    return refreshStoredSession(stored);
  }
  if (!revalidate) return publicSession(stored);
  try {
    const result = await request("/api/auth/me", {
      headers: { Authorization: `Bearer ${stored.accessToken}` },
    }, stored);
    stored = { ...stored, user: result.user || stored.user };
    await storageSet(accessSessionStore(), { [SESSION_KEY]: {
      accessToken: stored.accessToken,
      expiresAt: stored.expiresAt,
      user: stored.user,
      clientId: stored.clientId || CLIENT_ID,
      deviceId: stored.deviceId || "",
      authVersion: Number(stored.authVersion || 2),
      refreshExpiresAt: Number(stored.refreshExpiresAt || 0),
      refreshPolicy: stored.refreshPolicy || "rolling",
    } });
    return publicSession(stored);
  } catch (error) {
    if (error.status === 401 && stored.refreshToken) return refreshStoredSession(stored);
    await clearStoredSession();
    throw error;
  }
}

export async function signOut() {
  await clearStoredSession();
}
