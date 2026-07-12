import assert from "node:assert/strict";
import fs from "node:fs";
import { etsyGetAnalyticsData, getEtsyApiCapabilities } from "../modules/etsyApi.js";

const capabilities = getEtsyApiCapabilities();
assert.equal(capabilities.accessModel, "personal_seller_api");
assert.ok(capabilities.supported.includes("active_listings"));
assert.ok(capabilities.supported.includes("seller_receipts"));
assert.ok(capabilities.unsupported.includes("sessions_or_page_views"));
assert.ok(capabilities.unsupported.includes("add_to_cart_rate"));
assert.ok(capabilities.unsupported.includes("competitor_private_shop_data"));

const analytics = await etsyGetAnalyticsData("2026-07-01", "2026-07-07", ["sku"], ["session_view", "conv_tocart", "ordered_units"]);
assert.equal(analytics.supported, false, "unsupported Etsy personal API analytics must be explicit");
assert.deepEqual(analytics.data, [], "unsupported analytics must not synthesize zero-filled rows from receipts");
assert.match(analytics.limitation, /个人卖家 API.*不提供/);

const source = fs.readFileSync("modules/etsyApi.js", "utf8");
assert.doesNotMatch(source, /rows are synthesized from authorized receipts/i, "receipt data must not masquerade as funnel analytics");
assert.match(source, /ETSY_PERSONAL_API_CAPABILITIES/);
const backgroundSource = fs.readFileSync("background.js", "utf8");
assert.match(backgroundSource, /GET_ETSY_API_CAPABILITIES/);
assert.match(backgroundSource, /etsy_api_get_capabilities/);
const dashboardSource = fs.readFileSync("dashboard.js", "utf8");
assert.match(dashboardSource, /analytics\.supported === true/);
assert.match(dashboardSource, /个人 API 不提供流量\/加购 analytics/);
assert.match(dashboardSource, /cartRate === null \? null/);
console.log("etsy api contract smoke passed");
