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
globalThis.chrome = {
  storage: { session: sessionStorage, local: localStorage },
  tabs: { create: async ({ url }) => openedUrls.push(url) },
};

await new Promise((resolve) => localStorage.set({
  apiKey: "retired-key",
  llmModel: "retired-model",
  imageApiKey: "retired-image-key",
  marqelClientConfig: { llm: { apiKey: "retired-config-key" } },
}, resolve));

let pollCount = 0;
let refreshCount = 0;
let taskRequestCount = 0;
globalThis.fetch = async (url, options = {}) => {
  if (url.endsWith("/api/auth/device/start")) {
    return new Response(JSON.stringify({
      deviceCode: "private-device-code",
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
    if (pollCount === 1) {
      return new Response(JSON.stringify({ error: { code: "AUTHORIZATION_PENDING", message: "pending" } }), {
        status: 428,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({
      accessToken: "private-access-token",
      refreshToken: "private-refresh-token",
      expiresInSeconds: 1800,
      refreshExpiresInSeconds: 7776000,
      authVersion: 2,
      clientId: "etsy-growth-agent",
      deviceId: "growth-device-id",
      user: { id: "growth-user", email: "operator@example.com" },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (url.endsWith("/api/auth/refresh")) {
    refreshCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return new Response(JSON.stringify({
      accessToken: "rotated-access-token",
      refreshToken: "rotated-refresh-token",
      expiresInSeconds: 1800,
      refreshExpiresInSeconds: 7776000,
      authVersion: 2,
      clientId: "etsy-growth-agent",
      deviceId: "growth-device-id",
      user: { id: "growth-user", email: "operator@example.com" },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (url.endsWith("/api/tasks/next")) {
    taskRequestCount += 1;
    assert.match(options.headers.Authorization, /^Bearer /);
    assert.ok(options.headers["X-Marqel-Device-Proof"]);
    return new Response(JSON.stringify({ task: null }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  throw new Error(`Unexpected request: ${url}`);
};

const {
  controlCenterRequest,
  getActiveSession,
  getPendingDeviceAuthorization,
  pollDeviceAuthorization,
  signOut,
  startDeviceAuthorization,
} = await import("../modules/controlCenterAuth.js");

const started = await startDeviceAuthorization();
assert.equal(started.status, "approval_required");
assert.equal(started.userCode, "87654321");
assert.equal(Object.hasOwn(started, "deviceCode"), false);
assert.equal(Object.hasOwn(started, "verificationUriComplete"), false);
assert.deepEqual(openedUrls, ["https://www.marqel.shop/device-approval.html?user_code=87654321"]);

const retired = await new Promise((resolve) => localStorage.get(["apiKey", "llmModel", "imageApiKey", "marqelClientConfig"], resolve));
assert.equal(retired.apiKey, undefined);
assert.equal(retired.llmModel, undefined);
assert.equal(retired.imageApiKey, undefined);
assert.equal(retired.marqelClientConfig, undefined);

const pending = await pollDeviceAuthorization();
assert.equal(pending.status, "approval_pending");
assert.equal(Object.hasOwn(pending, "deviceCode"), false);

const authorized = await pollDeviceAuthorization();
assert.equal(authorized.status, "authorized");
assert.equal(authorized.configurationMode, "edge_only");
assert.equal(Object.hasOwn(authorized, "accessToken"), false);
assert.equal(Object.hasOwn(authorized, "refreshToken"), false);
assert.equal(await getPendingDeviceAuthorization(), null);

await controlCenterRequest("/api/tasks/next");
assert.equal(taskRequestCount, 1);

await new Promise((resolve) => sessionStorage.remove("marqelControlCenterSession", resolve));
const [recoveredFirst, recoveredSecond] = await Promise.all([getActiveSession(), getActiveSession()]);
assert.equal(recoveredFirst.accessToken, "rotated-access-token");
assert.equal(recoveredSecond.accessToken, "rotated-access-token");
assert.equal(refreshCount, 1, "single-use refresh token must rotate only once");

await signOut();
assert.equal(await getActiveSession(), null);
console.log("control-center auth edge-only smoke passed");
