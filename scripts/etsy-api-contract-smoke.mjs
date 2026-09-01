import assert from "node:assert/strict";
import fs from "node:fs";
import { etsyGetAnalyticsData, etsyGetProductInfo, etsyGetProductList, etsyGetReceipts, getEtsyApiCapabilities, getEtsySettings, purgeLegacyEtsyCredentials, saveEtsySettings } from "../modules/etsyApi.js";

const localData = {
  marqelControlCenterRefreshToken: "",
  etsyApiKey: "retired-key",
  etsyOAuthToken: "retired-access",
  etsyRefreshToken: "retired-refresh",
  etsyClientId: "retired-client",
  etsyShops: [{ id: "legacy", shopId: "24680", name: "Legacy", apiKey: "nested-key", oauthToken: "nested-access", refreshToken: "nested-refresh", sharedSecret: "nested-secret" }],
};
const sessionData = {
  marqelControlCenterSession: {
    accessToken: "marqel-session-token",
    expiresAt: Date.now() + 60 * 60 * 1000,
    authVersion: 1,
    user: { id: "operator-1" },
    clientId: "etsy-growth-agent",
  },
};

function storageArea(data) {
  return {
    get(keys, callback) {
      const requested = Array.isArray(keys) ? keys : [keys];
      callback(Object.fromEntries(requested.filter((key) => Object.hasOwn(data, key)).map((key) => [key, data[key]])));
    },
    set(values, callback = () => {}) { Object.assign(data, values); callback(); },
    remove(keys, callback = () => {}) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; callback(); },
  };
}

globalThis.chrome = { storage: { local: storageArea(localData), session: storageArea(sessionData) } };
const providerRequests = [];
globalThis.fetch = async (url, options = {}) => {
  providerRequests.push({ url: String(url), options });
  const pathname = new URL(url).pathname;
  let body;
  if (pathname === "/api/etsy/integration") {
    body = { integration: { contractVersion: "marqel-etsy-api-status.v1", configured: true, canConfigure: false, appType: "seller", credentialStatus: "verified", oauthStatus: "connected", keystring: { last4: "7890" }, scopes: ["shops_r", "listings_r"], shop: { id: "24680", name: "Owner Shop" }, accessState: "active", refreshState: "active", credentialDelivery: "server_only", dataProxy: { status: "available", mode: "read_only", source: "etsy_official_api", resources: ["active_listings", "listing_details"], unsupported: ["receipts", "ads"] }, externalActionPerformed: false } };
  } else if (pathname === "/api/etsy/listings") {
    body = { data: { contractVersion: "marqel-etsy-listing-page.v1", source: "etsy_official_api", shop: { id: "24680", name: "Owner Shop" }, items: [{ contractVersion: "marqel-etsy-listing.v1", listingId: "13579", title: "Proxy listing", state: "active", quantity: 3, skus: ["SKU-1"], price: { amount: 1299, divisor: 100, currencyCode: "USD" }, url: "https://www.etsy.com/listing/13579", primaryImage: { imageId: "99", url: "https://i.etsystatic.com/test.jpg" } }], count: 1, limit: 25, offset: 0, nextOffset: 1 }, externalActionPerformed: false };
  } else if (pathname === "/api/etsy/listings/13579") {
    body = { data: { contractVersion: "marqel-etsy-listing.v1", source: "etsy_official_api", shop: { id: "24680", name: "Owner Shop" }, listing: { contractVersion: "marqel-etsy-listing.v1", listingId: "13579", title: "Proxy listing detail", state: "active", quantity: 3, skus: ["SKU-1"], price: { amount: 1299, divisor: 100, currencyCode: "USD" }, url: "https://www.etsy.com/listing/13579", primaryImage: null } }, externalActionPerformed: false };
  } else throw new Error(`Unexpected request ${url}`);
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
};

const capabilities = getEtsyApiCapabilities();
assert.equal(capabilities.accessModel, "control_center_server_only_seller_api");
assert.deepEqual(capabilities.supported, ["active_listings", "listing_details"]);
assert.ok(capabilities.unsupported.includes("seller_receipts"));
assert.ok(capabilities.unsupported.includes("etsy_ads_management"));
assert.ok(capabilities.unsupported.includes("sessions_or_page_views"));

const analytics = await etsyGetAnalyticsData("2026-07-01", "2026-07-07", ["sku"], ["session_view"]);
assert.equal(analytics.supported, false);
assert.equal(analytics.skipped, true);
assert.deepEqual(analytics.data, []);

const settings = await getEtsySettings();
assert.equal(settings.credentialDelivery, "server_only");
assert.equal(settings.apiKey, "");
assert.equal(settings.oauthToken, "");
await assert.rejects(() => saveEtsySettings("local-key"), (error) => error.code === "ETSY_LOCAL_CREDENTIALS_RETIRED");

const listingPage = await etsyGetProductList(25, 0);
assert.equal(listingPage.items[0].product_id, "13579");
assert.equal(listingPage.items[0].price, 12.99);
assert.equal(listingPage.source, "etsy_official_api_via_control_center");
const listingDetail = await etsyGetProductInfo(["13579"]);
assert.equal(listingDetail.items[0].title, "Proxy listing detail");

const receipts = await etsyGetReceipts("2026-07-01", "2026-07-07");
assert.equal(receipts.reason, "control_center_proxy_scope_not_supported");
assert.deepEqual(receipts.orders, []);

assert.ok(providerRequests.every((request) => request.options.headers.Authorization === "Bearer marqel-session-token"));
assert.ok(providerRequests.every((request) => !request.options.headers["x-api-key"]));
assert.ok(providerRequests.every((request) => !request.url.includes("api.etsy.com")));

const purge = await purgeLegacyEtsyCredentials();
assert.equal(purge.shopsSanitized, 1);
for (const key of ["etsyApiKey", "etsyOAuthToken", "etsyRefreshToken", "etsyClientId"]) assert.equal(Object.hasOwn(localData, key), false);
assert.deepEqual(localData.etsyShops[0], { id: "legacy", shopId: "24680", name: "Legacy" });

const source = fs.readFileSync("modules/etsyApi.js", "utf8");
assert.doesNotMatch(source, /openapi\.etsy\.com|api\.etsy\.com/);
assert.doesNotMatch(source, /x-api-key|Authorization:\s*`Bearer/);
assert.match(source, /control_center_proxy_scope_not_supported/);
assert.match(source, /purgeLegacyEtsyCredentials/);
const backgroundSource = fs.readFileSync("background.js", "utf8");
assert.match(backgroundSource, /purgeLegacyEtsyCredentials\(\)/);
assert.match(backgroundSource, /GET_ETSY_API_CAPABILITIES/);
assert.match(backgroundSource, /GET_ETSY_API_CONNECTION_STATUS/);
console.log("etsy api contract smoke passed");
