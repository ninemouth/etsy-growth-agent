import assert from "node:assert/strict";

function createStorage() {
  const values = new Map();
  return {
    get(keys, callback) {
      const requested = Array.isArray(keys) ? keys : [keys];
      callback(Object.fromEntries(requested.map((key) => [key, values.get(key)])));
    },
    set(payload, callback) {
      for (const [key, value] of Object.entries(payload)) values.set(key, value);
      callback?.();
    },
    remove(keys, callback) {
      for (const key of (Array.isArray(keys) ? keys : [keys])) values.delete(key);
      callback?.();
    },
  };
}

const sessionStorage = createStorage();
const localStorage = createStorage();
const openedUrls = [];
let installType = "development";
globalThis.chrome = {
  storage: { session: sessionStorage, local: localStorage },
  tabs: { create: async ({ url }) => openedUrls.push(url) },
  runtime: {
    id: "abcdefghijklmnopabcdefghijklmnop",
    getManifest: () => ({ version: "1.2.5" }),
  },
  management: { getSelf: async () => ({ installType }) },
};
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Mozilla/5.0 Chrome/140.0.7339.10" }, configurable: true });

await new Promise((resolve) => localStorage.set({ apiKey: "manual-key", llmModel: "manual-model", imageApiKey: "manual-image-key" }, resolve));

let pollCount = 0;
let refreshCount = 0;
const extensionReports = [];
const configAcknowledgements = [];
globalThis.fetch = async (url, options = {}) => {
  if (url.endsWith("/api/auth/device/start")) {
    return new Response(JSON.stringify({
      deviceCode: "growth-device-secret",
      userCode: "87654321",
      verificationUri: "https://www.marqel.shop/device-approval.html",
      verificationUriComplete: "https://www.marqel.shop/device-approval.html?user_code=87654321",
      expiresInSeconds: 600,
      intervalSeconds: 5,
      clientType: "etsy_adspower",
      clientId: "etsy-growth-agent",
    }), { status: 201, headers: { "Content-Type": "application/json" } });
  }
  if (url.endsWith("/api/auth/device/poll")) {
    pollCount += 1;
    if (pollCount === 1) return new Response(JSON.stringify({ error: { code: "AUTHORIZATION_PENDING", message: "pending" } }), { status: 428, headers: { "Content-Type": "application/json" } });
    return new Response(JSON.stringify({
      accessToken: "growth-access-secret",
      refreshToken: "growth-refresh-secret",
      expiresInSeconds: 1800,
      refreshExpiresInSeconds: 7776000,
      refreshExpiresAt: new Date(Date.now() + 7776000 * 1000).toISOString(),
      refreshPolicy: "rolling",
      authVersion: 2,
      clientId: "etsy-growth-agent",
      deviceId: "growth-device-id",
      user: { id: "growth-user", phone: "+8613900000000", membershipExpiresAt: new Date(Date.now() + 2592000 * 1000).toISOString() },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (url.endsWith("/api/auth/refresh")) {
    refreshCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return new Response(JSON.stringify({
      accessToken: "growth-access-refreshed",
      refreshToken: "growth-refresh-rotated",
      expiresInSeconds: 1800,
      refreshExpiresInSeconds: 7776000,
      refreshExpiresAt: new Date(Date.now() + 7776000 * 1000).toISOString(),
      refreshPolicy: "rolling",
      authVersion: 2,
      clientId: "etsy-growth-agent",
      deviceId: "growth-device-id",
      user: { id: "growth-user", phone: "+8613900000000", membershipExpiresAt: new Date(Date.now() + 2592000 * 1000).toISOString() },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (url.endsWith("/api/client-config/ack")) {
    configAcknowledgements.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ accepted: true, receipt: configAcknowledgements.at(-1) }), { status: 201, headers: { "Content-Type": "application/json" } });
  }
  if (url.includes("/api/client-config")) return new Response(JSON.stringify({ status: "configured", config: {
    revision: 3,
    deliveryRevision: "scene:3;llm:5;image:0",
    deliveryDigest: "b".repeat(64),
    updatedAt: "2026-09-01T00:00:00.000Z",
    llm: { apiKey: "team-secret", model: "qwen-vl-max" },
    image: { enabled: false, apiKey: "" },
    interaction: { multimodalEnabled: true },
  } }), { status: 200, headers: { "Content-Type": "application/json" } });
  if (url.endsWith("/api/browser-extensions/report")) {
    extensionReports.push({ body: JSON.parse(options.body), headers: options.headers });
    return new Response(JSON.stringify({ status: { state: "current", installedVersion: "1.2.5" } }), { status: 201, headers: { "Content-Type": "application/json" } });
  }
  throw new Error(`Unexpected request: ${url}`);
};

const { detectInternalExtensionInstallMode, getActiveSession, getPendingDeviceAuthorization, pollDeviceAuthorization, reportBrowserExtensionInstallationStatus, signOut, startDeviceAuthorization } = await import("../modules/controlCenterAuth.js");

const started = await startDeviceAuthorization();
assert.equal(started.status, "approval_required");
assert.equal(started.clientId, "etsy-growth-agent");
assert.equal(started.clientType, "etsy_adspower");
assert.equal(started.userCode, "87654321");
assert.equal(Object.hasOwn(started, "deviceCode"), false);
assert.equal(Object.hasOwn(started, "verificationUriComplete"), false);
assert.deepEqual(openedUrls, ["https://www.marqel.shop/device-approval.html?user_code=87654321"]);

const pending = await pollDeviceAuthorization();
assert.equal(pending.status, "approval_pending");
assert.equal(pending.userCode, "87654321");
assert.equal(Object.hasOwn(pending, "deviceCode"), false);

const authorized = await pollDeviceAuthorization();
assert.equal(authorized.status, "authorized");
assert.equal(authorized.configStatus, "applied");
assert.equal(Object.hasOwn(authorized, "accessToken"), false);
assert.equal(Object.hasOwn(authorized, "refreshToken"), false);
assert.equal(configAcknowledgements.length, 1);
assert.equal(configAcknowledgements[0].deliveryRevision, "scene:3;llm:5;image:0");
assert.equal(configAcknowledgements[0].deliveryDigest, "b".repeat(64));
assert.equal(JSON.stringify(configAcknowledgements[0]).includes("team-secret"), false);
const appliedSettings = await new Promise((resolve) => localStorage.get(["apiKey", "llmModel", "imageApiKey"], resolve));
assert.equal(appliedSettings.apiKey, "team-secret");
assert.equal(appliedSettings.llmModel, "qwen-vl-max");
assert.equal(appliedSettings.imageApiKey, "manual-image-key", "a multimodal-only Web target must not replace the user's image provider setting");
assert.ok(await getPendingDeviceAuthorization() === null);

await new Promise((resolve) => sessionStorage.remove("marqelControlCenterSession", resolve));
const [recoveredFirst, recoveredSecond] = await Promise.all([getActiveSession(), getActiveSession()]);
assert.equal(recoveredFirst.accessToken, "growth-access-refreshed");
assert.equal(recoveredSecond.accessToken, "growth-access-refreshed");
assert.equal(refreshCount, 1, "browser restart recovery must rotate a single-use refresh token only once");
assert.equal(recoveredFirst.refreshPolicy, "rolling");

assert.equal(await detectInternalExtensionInstallMode(), "unpacked");
const reported = await reportBrowserExtensionInstallationStatus();
assert.equal(reported.ok, true);
assert.equal(reported.state, "current");
assert.equal(extensionReports.length, 1);
assert.deepEqual(extensionReports[0].body.extension, {
  id: "etsy-growth-agent",
  version: "1.2.5",
  runtimeExtensionId: "abcdefghijklmnopabcdefghijklmnop",
  chromeVersion: "140.0.7339.10",
  platform: "adspower_etsy",
  installMode: "unpacked",
});
assert.match(extensionReports[0].headers.Authorization, /^Bearer growth-access-refreshed$/);

installType = "normal";
const rejected = await reportBrowserExtensionInstallationStatus();
assert.equal(rejected.ok, false);
assert.equal(rejected.errorCode, "INTERNAL_UNPACKED_INSTALL_REQUIRED");
assert.equal(extensionReports.length, 1, "non-unpacked installs must fail before the Control Center report");

await signOut();
const restoredSettings = await new Promise((resolve) => localStorage.get(["apiKey", "llmModel", "imageApiKey", "marqelClientConfig", "marqelClientConfigBackup"], resolve));
assert.equal(restoredSettings.apiKey, "manual-key");
assert.equal(restoredSettings.llmModel, "manual-model");
assert.equal(restoredSettings.imageApiKey, "manual-image-key");
assert.equal(restoredSettings.marqelClientConfig, undefined);
assert.equal(restoredSettings.marqelClientConfigBackup, undefined);
console.log("control-center auth message-boundary smoke passed");
