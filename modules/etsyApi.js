// modules/etsyApi.js - governed Etsy read adapter
// Etsy Seller App credentials and OAuth tokens are server-only. This module
// consumes the Control Center proxy and never calls Etsy directly.

import { controlCenterRequest, getEtsyIntegrationStatus } from "./controlCenterAuth.js";

export const ETSY_PERSONAL_API_CAPABILITIES = Object.freeze({
  accessModel: "control_center_server_only_seller_api",
  scope: "仅当前设备授权所属组织及其已绑定自营 Etsy 店铺",
  supported: ["active_listings", "listing_details"],
  unsupported: ["seller_receipts", "finance_transaction_ledger", "etsy_ads_management", "listing_writes", "competitor_private_shop_data", "platform_wide_search_volume", "sessions_or_page_views", "click_through_rate", "add_to_cart_rate", "advertising_attribution", "platform_fulfilled_warehouse_metrics"],
  credentialBoundary: "Etsy Key、Secret、Access Token、Refresh Token 只保存在 Control Center 服务端；插件仅发送带设备证明的 Marqel 请求。",
  publicBrowserBoundary: "竞品和 Etsy 搜索只能通过公开浏览器页面取证，不能从 Seller App 读取竞品后台数据。",
});

export function getEtsyApiCapabilities() {
  return JSON.parse(JSON.stringify(ETSY_PERSONAL_API_CAPABILITIES));
}

function toDateString(date) { return date.toISOString().slice(0, 10); }

export function getDefaultEtsyDateRange(days = 14) {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - Math.max(1, Number(days) || 14));
  return { dateFrom: toDateString(from), dateTo: toDateString(to) };
}

function unsupportedResult(kind, extra = {}) {
  return {
    ok: true,
    skipped: true,
    supported: false,
    reason: "control_center_proxy_scope_not_supported",
    source: "marqel_control_center",
    accessModel: ETSY_PERSONAL_API_CAPABILITIES.accessModel,
    kind,
    message: "当前服务端只读代理仅开放自营 active listings 与 listing details；订单、交易、广告和写入能力未授权，不能从旧本地凭据降级直连。",
    limitation: "不得把缺失的订单、Sessions、转化、广告归因、财务或履约数据视为 0，也不得声称已验证。",
    ...extra,
  };
}

function normalizedPrice(price = {}) {
  const amount = Number(price.amount || 0);
  const divisor = Number(price.divisor || 100);
  return Number.isFinite(amount) && Number.isFinite(divisor) && divisor > 0 ? amount / divisor : 0;
}

function normalizeListing(listing = {}) {
  const listingId = String(listing.listingId || "");
  const sku = Array.isArray(listing.skus) ? String(listing.skus[0] || listingId) : listingId;
  return {
    product_id: listingId,
    offer_id: sku,
    sku,
    title: String(listing.title || "Etsy Listing"),
    name: String(listing.title || "Etsy Listing"),
    visibility: String(listing.state || "active"),
    price: normalizedPrice(listing.price),
    currency_code: String(listing.price?.currencyCode || "USD"),
    quantity: Number(listing.quantity || 0),
    url: String(listing.url || ""),
    image: String(listing.primaryImage?.url || ""),
    source: "etsy_official_api_via_control_center",
    contractVersion: listing.contractVersion || "marqel-etsy-listing.v1",
  };
}

function boundedPageNumber(value, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, maximum);
}

async function requireConnectedIntegration() {
  const integration = await getEtsyIntegrationStatus();
  if (integration.oauthStatus !== "connected" || !integration.shop?.id) {
    const error = new Error("请先在 Marqel Control Center 完成 Etsy Seller App 与店主只读 OAuth 连接。");
    error.code = "ETSY_OAUTH_NOT_CONNECTED";
    throw error;
  }
  if (integration.dataProxy?.status !== "available" || integration.dataProxy?.mode !== "read_only") {
    const error = new Error("Control Center 尚未开放 Etsy Listing 只读数据代理；禁止使用旧本地 Key/Token 直连。");
    error.code = "ETSY_DATA_PROXY_UNAVAILABLE";
    throw error;
  }
  return integration;
}

export async function getEtsySettings() {
  const integration = await getEtsyIntegrationStatus().catch(() => null);
  return {
    source: "marqel_control_center",
    configured: Boolean(integration?.configured),
    oauthStatus: integration?.oauthStatus || "not_connected",
    shopId: String(integration?.shop?.id || ""),
    shopName: String(integration?.shop?.name || "Etsy Shop"),
    apiKey: "",
    oauthToken: "",
    refreshToken: "",
    credentialDelivery: "server_only",
  };
}

export async function saveEtsySettings() {
  const error = new Error("本地 Etsy Key/Token 配置已停用；请在 Marqel Control Center 的 Etsy API 连接页配置。");
  error.code = "ETSY_LOCAL_CREDENTIALS_RETIRED";
  throw error;
}

export async function purgeLegacyEtsyCredentials() {
  const stored = await new Promise((resolve) => chrome.storage.local.get(["etsyShops"], resolve));
  const sanitizedShops = (Array.isArray(stored.etsyShops) ? stored.etsyShops : []).map(({ apiKey: _apiKey, oauthToken: _oauthToken, refreshToken: _refreshToken, sharedSecret: _sharedSecret, ...shop }) => shop);
  await new Promise((resolve) => chrome.storage.local.set({ etsyShops: sanitizedShops }, resolve));
  await new Promise((resolve) => chrome.storage.local.remove(["etsyApiKey", "etsyOAuthToken", "etsyRefreshToken", "etsyClientId"], resolve));
  return { removed: true, shopsSanitized: sanitizedShops.length, credentialDelivery: "server_only" };
}

export async function etsyGetProductList(limit = 25, offset = 0) {
  await requireConnectedIntegration();
  const pageLimit = Math.max(1, boundedPageNumber(limit, 25, 100));
  const pageOffset = boundedPageNumber(offset, 0, 100_000);
  const payload = await controlCenterRequest(`/api/etsy/listings?limit=${pageLimit}&offset=${pageOffset}`);
  const page = payload.data || {};
  if (page.contractVersion !== "marqel-etsy-listing-page.v1" || page.source !== "etsy_official_api") throw new Error("Control Center returned an unsupported Etsy listing page contract.");
  const items = (Array.isArray(page.items) ? page.items : []).map(normalizeListing);
  return { items, total: Number(page.count || items.length), last_id: String(Number(page.nextOffset ?? pageOffset + items.length)), source: "etsy_official_api_via_control_center", shop: page.shop || null, contractVersion: page.contractVersion };
}

export async function etsyGetAllProductListings({ pageSize = 25, maxPages = 20 } = {}) {
  const items = [];
  let total = 0;
  let pagesFetched = 0;
  const safePageSize = Math.max(1, Math.min(Number(pageSize) || 25, 100));
  const pageLimit = Math.max(1, Math.min(Number(maxPages) || 20, 50));
  for (let page = 0; page < pageLimit; page += 1) {
    const result = await etsyGetProductList(safePageSize, page * safePageSize);
    pagesFetched += 1;
    total = Number(result.total || total || 0);
    items.push(...result.items);
    if (!result.items.length || result.items.length < safePageSize || items.length >= total) break;
  }
  return { items, total: total || items.length, pagesFetched, complete: total > 0 ? items.length >= total : pagesFetched < pageLimit, source: "etsy_official_api_via_control_center", coverage: `Control Center 只读代理分页读取 ${pagesFetched} 页，已获得 ${items.length} 条 active listings；API total=${total || "未返回"}` };
}

export async function etsyGetProductInfo(productIds = [], skus = []) {
  await requireConnectedIntegration();
  const ids = Array.isArray(productIds) ? [...new Set(productIds.map(String).filter((id) => /^\d{1,24}$/.test(id)))].slice(0, 20) : [];
  if (!ids.length && Array.isArray(skus) && skus.length) {
    const list = await etsyGetAllProductListings({ pageSize: 100, maxPages: 20 });
    return { items: list.items.filter((item) => skus.map(String).includes(item.sku)), failures: [], source: list.source };
  }
  if (!ids.length) return { items: [], failures: [], source: "etsy_official_api_via_control_center" };
  const settled = await Promise.allSettled(ids.map((id) => controlCenterRequest(`/api/etsy/listings/${encodeURIComponent(id)}`)));
  return {
    items: settled.filter((result) => result.status === "fulfilled").map((result) => normalizeListing(result.value.data?.listing || {})),
    failures: settled.map((result, index) => ({ result, listingId: ids[index] })).filter(({ result }) => result.status === "rejected").map(({ result, listingId }) => ({ listingId, error: result.reason?.message || String(result.reason) })),
    source: "etsy_official_api_via_control_center",
  };
}

export async function etsyGetAnalyticsData(dateFrom, dateTo, dimension = ["sku"], metrics = ["sessions", "orders", "revenue"]) {
  return unsupportedResult("seller_analytics", { data: [], metrics: [], requestedMetrics: metrics, dimension, dateFrom: dateFrom || "", dateTo: dateTo || "" });
}

export async function etsyGetReceipts(dateFrom, dateTo) {
  return unsupportedResult("seller_receipts", { dateFrom: dateFrom || "", dateTo: dateTo || "", receipts: [], count: 0, orders: [] });
}

export async function etsyGetReceiptWindow(dateFrom, dateTo) {
  return { ...(await etsyGetReceipts(dateFrom, dateTo)), pagesFetched: 0, complete: false };
}

export async function etsyGetFbsPostingList(dateFrom, dateTo) { return etsyGetReceipts(dateFrom, dateTo); }

export async function etsyGetFboPostingList() { return unsupportedResult("platform_fulfillment", { receipts: [], postings: [], count: 0 }); }

export async function etsyGetStoreSnapshot(args = {}) {
  const { dateFrom, dateTo } = args.dateFrom && args.dateTo ? args : getDefaultEtsyDateRange(args.days || 14);
  const products = await etsyGetAllProductListings({ pageSize: args.productPageSize || 25, maxPages: args.productMaxPages || 20 });
  const receipts = await etsyGetReceipts(dateFrom, dateTo);
  return {
    ok: true,
    source: "etsy_official_api_via_control_center",
    accessModel: ETSY_PERSONAL_API_CAPABILITIES.accessModel,
    capabilities: getEtsyApiCapabilities(),
    dateFrom, dateTo, products,
    productCoverage: products.coverage,
    productsComplete: products.complete,
    analytics: await etsyGetAnalyticsData(dateFrom, dateTo, args.dimension, args.metrics),
    postings: { fbs: [], fbo: [], count: 0, skipped: true },
    receipts: [], orders: [],
    receiptCoverage: receipts.message,
    receiptsComplete: false,
    limitations: [receipts.limitation],
    failures: [],
  };
}
