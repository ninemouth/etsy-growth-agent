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
    getManifest: () => ({ version: "1.2.4" }),
  },
  management: { getSelf: async () => ({ installType }) },
};
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Mozilla/5.0 Chrome/140.0.7339.10" }, configurable: true });

let pollCount = 0;
const extensionReports = [];
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
      authVersion: 2,
      clientId: "etsy-growth-agent",
      deviceId: "growth-device-id",
      user: { id: "growth-user", phone: "+8613900000000" },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (url.includes("/api/client-config")) return new Response(JSON.stringify({ status: "not_configured", config: null }), { status: 200, headers: { "Content-Type": "application/json" } });
  if (url.endsWith("/api/browser-extensions/report")) {
    extensionReports.push({ body: JSON.parse(options.body), headers: options.headers });
    return new Response(JSON.stringify({ status: { state: "current", installedVersion: "1.2.4" } }), { status: 201, headers: { "Content-Type": "application/json" } });
  }
  throw new Error(`Unexpected request: ${url}`);
};

const { detectInternalExtensionInstallMode, getPendingDeviceAuthorization, pollDeviceAuthorization, reportBrowserExtensionInstallationStatus, signOut, startDeviceAuthorization } = await import("../modules/controlCenterAuth.js");

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
assert.equal(Object.hasOwn(authorized, "accessToken"), false);
assert.equal(Object.hasOwn(authorized, "refreshToken"), false);
assert.ok(await getPendingDeviceAuthorization() === null);

assert.equal(await detectInternalExtensionInstallMode(), "unpacked");
const reported = await reportBrowserExtensionInstallationStatus();
assert.equal(reported.ok, true);
assert.equal(reported.state, "current");
assert.equal(extensionReports.length, 1);
assert.deepEqual(extensionReports[0].body.extension, {
  id: "etsy-growth-agent",
  version: "1.2.4",
  runtimeExtensionId: "abcdefghijklmnopabcdefghijklmnop",
  chromeVersion: "140.0.7339.10",
  platform: "adspower_etsy",
  installMode: "unpacked",
});
assert.match(extensionReports[0].headers.Authorization, /^Bearer growth-access-secret$/);

installType = "normal";
const rejected = await reportBrowserExtensionInstallationStatus();
assert.equal(rejected.ok, false);
assert.equal(rejected.errorCode, "INTERNAL_UNPACKED_INSTALL_REQUIRED");
assert.equal(extensionReports.length, 1, "non-unpacked installs must fail before the Control Center report");

await signOut();
console.log("control-center auth message-boundary smoke passed");
