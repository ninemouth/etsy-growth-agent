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

let pollCount = 0;
globalThis.fetch = async (url) => {
  if (url.endsWith("/api/auth/device/start")) {
    return new Response(JSON.stringify({
      deviceCode: "growth-device-secret",
      userCode: "87654321",
      verificationUri: "https://www.marqel.shop/device-approval.html",
      verificationUriComplete: "https://www.marqel.shop/device-approval.html?user_code=87654321",
      expiresInSeconds: 600,
      intervalSeconds: 5,
      clientType: "chrome_extension",
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
      authVersion: 2,
      clientId: "etsy-growth-agent",
      deviceId: "growth-device-id",
      user: { id: "growth-user", phone: "+8613900000000" },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (url.includes("/api/client-config")) return new Response(JSON.stringify({ status: "not_configured", config: null }), { status: 200, headers: { "Content-Type": "application/json" } });
  throw new Error(`Unexpected request: ${url}`);
};

const { getPendingDeviceAuthorization, pollDeviceAuthorization, signOut, startDeviceAuthorization } = await import("../modules/controlCenterAuth.js");

const started = await startDeviceAuthorization();
assert.equal(started.status, "approval_required");
assert.equal(started.clientId, "etsy-growth-agent");
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
assert.equal(Object.hasOwn(authorized, "accessToken"), false);
assert.equal(Object.hasOwn(authorized, "refreshToken"), false);
assert.ok(await getPendingDeviceAuthorization() === null);

await signOut();
console.log("control-center auth message-boundary smoke passed");
