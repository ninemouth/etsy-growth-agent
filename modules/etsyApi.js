// modules/etsyApi.js - Etsy Open API compatibility adapter

const ETSY_API_BASE = "https://openapi.etsy.com/v3/application";
const ETSY_MIN_REQUEST_INTERVAL_MS = 1100;
const ETSY_RATE_LIMIT_RETRY_MS = 1600;

export const ETSY_PERSONAL_API_CAPABILITIES = Object.freeze({
  accessModel: "personal_seller_api",
  scope: "仅当前授权店主及其自营店铺",
  supported: [
    "active_listings",
    "listing_details",
    "seller_receipts",
    "seller_fulfillment_posting_compatibility",
  ],
  unsupported: [
    "competitor_private_shop_data",
    "platform_wide_search_volume",
    "sessions_or_page_views",
    "click_through_rate",
    "add_to_cart_rate",
    "advertising_attribution",
    "finance_transaction_ledger",
    "platform_fulfilled_warehouse_metrics",
  ],
  publicBrowserBoundary: "竞品和 Etsy 搜索只能通过公开浏览器页面取证，不能从个人 API 读取竞品后台数据。",
});

export function getEtsyApiCapabilities() {
  return JSON.parse(JSON.stringify(ETSY_PERSONAL_API_CAPABILITIES));
}

let lastEtsyRequestAt = 0;
let etsyRequestQueue = Promise.resolve();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toDateString(date) {
  return date.toISOString().slice(0, 10);
}

function toUnixDayStart(dateString) {
  return Math.floor(new Date(`${dateString}T00:00:00Z`).getTime() / 1000);
}

function toUnixDayEnd(dateString) {
  return Math.floor(new Date(`${dateString}T23:59:59Z`).getTime() / 1000);
}

export function getDefaultEtsyDateRange(days = 14) {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - Math.max(1, days));
  return {
    dateFrom: toDateString(from),
    dateTo: toDateString(to),
  };
}

export async function getEtsySettings(explicitShopId = null) {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      [
        "etsyShops",
        "activeShopId",
        "etsyApiKey",
        "etsyOAuthToken",
        "etsyRefreshToken",
        "etsyShopId",
        "etsyWarehouseType",
      ],
      (data) => {
        const shops = data.etsyShops || [];
        const activeId = explicitShopId || data.activeShopId;
        let activeShop = shops.find((shop) => shop.id === activeId || shop.shopId === activeId);
        if (!activeShop && shops.length > 0) activeShop = shops.find((shop) => shop.isDefault) || shops[0];

        resolve({
          apiKey: activeShop?.apiKey || data.etsyApiKey || "",
          oauthToken: activeShop?.oauthToken || data.etsyOAuthToken || "",
          refreshToken: activeShop?.refreshToken || data.etsyRefreshToken || "",
          shopId: activeShop?.shopId || activeShop?.id || data.etsyShopId || "",
          shopName: activeShop?.name || "Etsy Shop",
          warehouseType: activeShop?.warehouseType || data.etsyWarehouseType || "Etsy seller-fulfilled",
        });
      }
    );
  });
}

export async function saveEtsySettings(apiKey, oauthToken = "", shopId = "", shopName = "Etsy Shop", refreshToken = "") {
  return new Promise((resolve) => {
    chrome.storage.local.get(["etsyShops"], (data) => {
      const shops = data.etsyShops || [];
      const newShop = {
        id: shopId || `shop_${Date.now()}`,
        shopId,
        name: shopName,
        apiKey,
        oauthToken,
        refreshToken,
        warehouseType: "Etsy seller-fulfilled",
        isDefault: shops.length === 0,
      };
      shops.push(newShop);
      chrome.storage.local.set(
        {
          etsyShops: shops,
          activeShopId: newShop.id,
          etsyApiKey: apiKey,
          etsyOAuthToken: oauthToken,
          etsyRefreshToken: refreshToken,
          etsyShopId: shopId,
        },
        () => resolve(true)
      );
    });
  });
}

function getEtsyClientId(apiKey = "") {
  return String(apiKey || "").split(":")[0].trim();
}

async function persistRefreshedOAuthToken({ accessToken, refreshToken }) {
  const settings = await getEtsySettings();
  const storage = await new Promise((resolve) => chrome.storage.local.get(["etsyShops", "activeShopId"], resolve));
  const shops = (storage.etsyShops || []).map((shop) => {
    if (shop.id !== storage.activeShopId && shop.shopId !== settings.shopId) return shop;
    return {
      ...shop,
      oauthToken: accessToken || shop.oauthToken,
      refreshToken: refreshToken || shop.refreshToken,
    };
  });
  await new Promise((resolve) => chrome.storage.local.set({
    etsyShops: shops,
    etsyOAuthToken: accessToken || settings.oauthToken,
    etsyRefreshToken: refreshToken || settings.refreshToken,
  }, resolve));
}

async function refreshEtsyOAuthToken(settings) {
  if (!settings.refreshToken) return null;
  const clientId = getEtsyClientId(settings.apiKey);
  if (!clientId) return null;

  const response = await fetch("https://api.etsy.com/v3/public/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: settings.refreshToken,
    }),
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`Etsy OAuth refresh failed (${response.status}): ${parseEtsyError(responseText)}`);
  }

  const tokenPayload = responseText ? JSON.parse(responseText) : {};
  if (!tokenPayload.access_token) return null;
  await persistRefreshedOAuthToken({
    accessToken: tokenPayload.access_token,
    refreshToken: tokenPayload.refresh_token || settings.refreshToken,
  });
  return tokenPayload.access_token;
}

async function waitForEtsyRateSlot() {
  const elapsed = Date.now() - lastEtsyRequestAt;
  if (elapsed < ETSY_MIN_REQUEST_INTERVAL_MS) {
    await sleep(ETSY_MIN_REQUEST_INTERVAL_MS - elapsed);
  }
  lastEtsyRequestAt = Date.now();
}

function parseEtsyError(responseText) {
  try {
    const parsed = JSON.parse(responseText);
    return parsed.error || parsed.message || JSON.stringify(parsed);
  } catch (_) {
    return responseText || "Empty error response";
  }
}

function buildQuery(params = {}) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    query.set(key, String(value));
  });
  const text = query.toString();
  return text ? `?${text}` : "";
}

function buildUnconfiguredApiResult(kind, settings = {}, extra = {}) {
  return {
    ok: true,
    skipped: true,
    reason: "etsy_personal_api_not_configured",
    source: "etsy_personal_seller_api",
    accessModel: ETSY_PERSONAL_API_CAPABILITIES.accessModel,
    kind,
    configured: Boolean(settings.apiKey && settings.shopId),
    apiKeyConfigured: Boolean(settings.apiKey),
    shopIdConfigured: Boolean(settings.shopId),
    oauthConfigured: Boolean(settings.oauthToken),
    message: "未配置/未取得 Etsy 个人访问 API，本轮允许继续使用公开页面、搜索和截图证据；订单、Sessions、转化、履约成本等后台数据必须降级为待验证假设。",
    limitation: "未配置 Etsy 个人 API 时，不能声称已验证真实订单、真实流量、Sessions、转化或履约成本；需后续授权后复核。",
    ...extra,
  };
}

async function makeQueuedEtsyRequest(endpoint, { query = {}, method = "GET", body = null, requireOAuth = false } = {}, attempt = 0) {
  const settings = await getEtsySettings();
  const { apiKey, oauthToken } = settings;
  if (!apiKey) {
    throw new Error("未配置 Etsy 个人访问 API Key，请在设置中填写 keystring:shared_secret。");
  }
  if (requireOAuth && !oauthToken) {
    throw new Error("该 Etsy 个人访问数据需要 OAuth Access Token；请在设置中补充 Access Token，建议同时保存 Refresh Token。");
  }

  await waitForEtsyRateSlot();
  const url = `${ETSY_API_BASE}${endpoint}${buildQuery(query)}`;
  const headers = {
    "x-api-key": apiKey,
    "Content-Type": "application/json",
  };
  if (oauthToken) headers.Authorization = `Bearer ${oauthToken}`;

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null,
  });

  const responseText = await response.text();
  if (!response.ok) {
    const errorText = parseEtsyError(responseText);
    if ((response.status === 401 || response.status === 403) && requireOAuth && settings.refreshToken && attempt < 1) {
      const refreshedToken = await refreshEtsyOAuthToken(settings);
      if (refreshedToken) {
        return makeQueuedEtsyRequest(endpoint, { query, method, body, requireOAuth }, attempt + 1);
      }
    }
    if (response.status === 429 && attempt < 2) {
      const retryDelay = ETSY_RATE_LIMIT_RETRY_MS * (attempt + 1);
      console.warn(`[Etsy API Rate Limit] ${endpoint} hit 429, retrying in ${retryDelay}ms...`);
      await sleep(retryDelay);
      return makeQueuedEtsyRequest(endpoint, { query, method, body, requireOAuth }, attempt + 1);
    }
    throw new Error(`Etsy API 请求失败 (${response.status}): ${errorText}`);
  }

  return responseText ? JSON.parse(responseText) : {};
}

async function makeEtsyRequest(endpoint, options = {}) {
  const run = () => makeQueuedEtsyRequest(endpoint, options);
  const queued = etsyRequestQueue.then(run, run);
  etsyRequestQueue = queued.catch(() => {});
  return queued;
}

function normalizeListing(listing = {}) {
  const image = listing.images?.[0]?.url_fullxfull || listing.images?.[0]?.url_570xN || "";
  return {
    product_id: listing.listing_id,
    offer_id: listing.sku?.[0] || String(listing.listing_id || ""),
    sku: listing.sku?.[0] || String(listing.listing_id || ""),
    title: listing.title || "Etsy Listing",
    name: listing.title || "Etsy Listing",
    visibility: listing.state || "active",
    price: listing.price?.amount ? Number(listing.price.amount) / Number(listing.price.divisor || 100) : Number(listing.price || 0),
    currency_code: listing.price?.currency_code || listing.currency_code || "USD",
    quantity: Number(listing.quantity || 0),
    url: listing.url || "",
    image,
    raw: listing,
  };
}

function normalizeReceipt(receipt = {}) {
  const firstTransaction = receipt.transactions?.[0] || {};
  const orderTotal = receipt.grandtotal?.amount
    ? Number(receipt.grandtotal.amount) / Number(receipt.grandtotal.divisor || 100)
    : Number(receipt.total_price || receipt.order_total || 0);
  return {
    orderId: receipt.receipt_id || receipt.order_id || "--",
    sku: firstTransaction.sku || String(firstTransaction.listing_id || "--"),
    cat: firstTransaction.title || receipt.name || "Etsy Order",
    qty: Number(firstTransaction.quantity || receipt.transactions?.length || 1),
    price: Number.isFinite(orderTotal) ? orderTotal : 0,
    logisticsType: receipt.shipping_carrier || "Etsy seller-fulfilled",
    status: receipt.status || (receipt.was_shipped ? "shipped" : "open"),
    countdown: receipt.expected_ship_date
      ? new Date(Number(receipt.expected_ship_date) * 1000).toLocaleString()
      : "--",
    raw: receipt,
  };
}

export async function etsyGetProductList(limit = 100, offset = 0) {
  const settings = await getEtsySettings();
  const { shopId } = settings;
  if (!settings.apiKey || !shopId) {
    return buildUnconfiguredApiResult("active_listings", settings, {
      items: [],
      total: 0,
      last_id: String(Number(offset || 0)),
      raw: {},
    });
  }

  const res = await makeEtsyRequest(`/shops/${encodeURIComponent(shopId)}/listings/active`, {
    query: {
      limit: Math.min(Number(limit || 100), 100),
      offset: Number(offset || 0),
      includes: "Images",
    },
  });
  const listings = res.results || [];
  return {
    items: listings.map(normalizeListing),
    total: Number(res.count || listings.length),
    last_id: String(Number(offset || 0) + listings.length),
    raw: res,
  };
}

export async function etsyGetAllProductListings({ pageSize = 100, maxPages = 20 } = {}) {
  const items = [];
  let total = 0;
  let pagesFetched = 0;
  for (let page = 0; page < Math.max(1, Math.min(Number(maxPages) || 20, 50)); page++) {
    const result = await etsyGetProductList(pageSize, page * pageSize);
    if (result.skipped) {
      return {
        ...result,
        pagesFetched,
        complete: false,
        coverage: result.message,
      };
    }
    pagesFetched += 1;
    total = Number(result.total || total || 0);
    items.push(...(result.items || []));
    if (!result.items?.length || result.items.length < pageSize || items.length >= total) break;
  }
  return {
    items,
    total: total || items.length,
    pagesFetched,
    complete: total > 0 ? items.length >= total : pagesFetched < maxPages,
    coverage: `自营 active listings 分页读取 ${pagesFetched} 页，已获得 ${items.length} 条；API total=${total || "未返回"}`,
  };
}

export async function etsyGetProductInfo(productIds = [], skus = []) {
  const settings = await getEtsySettings();
  if (!settings.apiKey) {
    return buildUnconfiguredApiResult("listing_details", settings, {
      items: [],
      failures: [],
    });
  }
  const ids = Array.isArray(productIds) ? productIds.filter(Boolean) : [];
  if (!ids.length && Array.isArray(skus) && skus.length) {
    const list = await etsyGetProductList(100, 0);
    return {
      items: list.items.filter((item) => skus.includes(item.sku)),
      raw: list.raw,
    };
  }
  if (!ids.length) return { items: [] };

  const settled = await Promise.allSettled(
    ids.slice(0, 20).map((id) =>
      makeEtsyRequest(`/listings/${encodeURIComponent(id)}`, {
        query: { includes: "Images" },
      })
    )
  );

  return {
    items: settled
      .filter((result) => result.status === "fulfilled")
      .map((result) => normalizeListing(result.value)),
    failures: settled
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason?.message || String(result.reason)),
  };
}

export async function etsyGetAnalyticsData(dateFrom, dateTo, dimension = ["sku"], metrics = ["sessions", "orders", "revenue"]) {
  return {
    supported: false,
    accessModel: ETSY_PERSONAL_API_CAPABILITIES.accessModel,
    data: [],
    metrics: [],
    requestedMetrics: metrics,
    dimension,
    dateFrom: dateFrom || "",
    dateTo: dateTo || "",
    limitation: "Etsy 个人卖家 API 当前不提供 Sessions、页面浏览、点击率或加购率 analytics；不能从 receipts 合成这些指标。",
    nextStep: "使用公开 Etsy 页面和浏览器证据分析曝光/转化方向；使用个人 API 仅核对自营 listings、订单和发货资料。",
  };
}

export async function etsyGetReceipts(dateFrom, dateTo, offset = 0, limit = 50) {
  const settings = await getEtsySettings();
  const { shopId } = settings;
  if (!settings.apiKey || !shopId || !settings.oauthToken) {
    return buildUnconfiguredApiResult("seller_receipts", settings, {
      receipts: [],
      count: 0,
      orders: [],
      raw: {},
    });
  }
  const res = await makeEtsyRequest(`/shops/${encodeURIComponent(shopId)}/receipts`, {
    requireOAuth: true,
    query: {
      limit: Math.min(Number(limit || 50), 100),
      offset: Number(offset || 0),
      min_created: toUnixDayStart(dateFrom),
      max_created: toUnixDayEnd(dateTo),
    },
  });
  const receipts = res.results || [];
  return {
    receipts,
    count: Number(res.count || receipts.length),
    orders: receipts.map(normalizeReceipt),
    raw: res,
  };
}

export async function etsyGetReceiptWindow(dateFrom, dateTo, { pageSize = 100, maxPages = 20 } = {}) {
  const receipts = [];
  let total = 0;
  let pagesFetched = 0;
  const pageLimit = Math.max(1, Math.min(Number(maxPages) || 20, 50));
  for (let page = 0; page < pageLimit; page++) {
    const result = await etsyGetReceipts(dateFrom, dateTo, page * pageSize, pageSize);
    if (result.skipped) {
      return {
        ...result,
        pagesFetched,
        complete: false,
        coverage: result.message,
      };
    }
    pagesFetched += 1;
    total = Number(result.count || total || 0);
    receipts.push(...(result.receipts || []));
    if (!result.receipts?.length || result.receipts.length < pageSize || receipts.length >= total) break;
  }
  return {
    receipts,
    count: total || receipts.length,
    orders: receipts.map(normalizeReceipt),
    pagesFetched,
    complete: total > 0 ? receipts.length >= total : pagesFetched < pageLimit,
    coverage: `自营 receipts 分页读取 ${pagesFetched} 页，已获得 ${receipts.length} 条；API total=${total || "未返回"}`,
  };
}

export async function etsyGetFbsPostingList(dateFrom, dateTo, offset = 0, limit = 50) {
  return etsyGetReceipts(dateFrom, dateTo, offset, limit);
}

export async function etsyGetFboPostingList() {
  return {
    receipts: [],
    postings: [],
    count: 0,
    note: "Etsy has no native platform-fulfilled warehouse equivalent in this adapter; use receipts and seller-fulfilled shipping evidence.",
  };
}

export async function etsyGetStoreSnapshot(args = {}) {
  const { dateFrom, dateTo } = args.dateFrom && args.dateTo
    ? args
    : getDefaultEtsyDateRange(args.days || 14);
  const metrics = args.metrics || ["ordered_units", "revenue"];

  const runSettled = async (fn) => {
    try {
      return { status: "fulfilled", value: await fn() };
    } catch (reason) {
      return { status: "rejected", reason };
    }
  };

  const products = await runSettled(() => etsyGetAllProductListings({ pageSize: args.productPageSize || 100, maxPages: args.productMaxPages || 20 }));
  const receipts = await runSettled(() => etsyGetReceiptWindow(dateFrom, dateTo, { pageSize: args.pageSize || 100, maxPages: args.receiptMaxPages || 20 }));

  const failures = [];
  const result = {
    ok: true,
    source: "etsy_personal_seller_api",
    accessModel: ETSY_PERSONAL_API_CAPABILITIES.accessModel,
    capabilities: getEtsyApiCapabilities(),
    dateFrom,
    dateTo,
    products: { items: [], total: 0 },
    analytics: {
      supported: false,
      data: [],
      totals: {},
      metrics: [],
      requestedMetrics: metrics,
      limitation: "个人卖家 API 不提供 Sessions、页面浏览、点击率或加购率 analytics；以下快照不填充这些指标。",
    },
    postings: { fbs: [], fbo: [], count: 0 },
    receipts: [],
    orders: [],
    failures,
  };

  if (products.status === "fulfilled") {
    result.products = products.value;
    result.productCoverage = products.value.coverage;
    result.productsComplete = products.value.complete;
  } else {
    failures.push({ endpoint: "etsyGetProductList", error: products.reason?.message || String(products.reason) });
  }

  if (receipts.status === "fulfilled") {
    result.receipts = receipts.value.receipts || [];
    result.orders = receipts.value.orders || [];
    result.postings.fbs = result.receipts;
    result.postings.count = result.receipts.length;
    result.receiptCoverage = receipts.value.coverage;
    result.receiptsComplete = receipts.value.complete;
  } else {
    failures.push({ endpoint: "etsyGetReceipts", error: receipts.reason?.message || String(receipts.reason) });
  }

  result.ok = failures.length === 0;
  return result;
}
