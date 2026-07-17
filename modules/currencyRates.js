// modules/currencyRates.js - Shared currency and arbitrage assumptions

export const CURRENCY_RATES_STORAGE_KEY = "currencyRates";

export const DEFAULT_CURRENCY_RATES = Object.freeze({
  baseCurrency: "USD",
  quoteCurrency: "CNY",
  usdToCny: 7.25,
  eurToUsd: 1.09,
  shippingPerKgUsd: 5.5,
  parcelFeeUsd: 2,
  handlingFeeCny: 2,
  platformFeeRate: 0.12,
  customsThresholdUsd: 220,
  customsDutyRate: 0.15,
  fxLossRate: 0.02,
  source: "default_assumption",
  updated_at: "",
});

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function normalizeCurrencyRates(raw = {}) {
  const rates = {
    ...DEFAULT_CURRENCY_RATES,
    ...(raw && typeof raw === "object" ? raw : {}),
  };
  return {
    ...rates,
    usdToCny: Math.max(0.01, finiteNumber(rates.usdToCny, DEFAULT_CURRENCY_RATES.usdToCny)),
    eurToUsd: Math.max(0.01, finiteNumber(rates.eurToUsd, DEFAULT_CURRENCY_RATES.eurToUsd)),
    shippingPerKgUsd: Math.max(0, finiteNumber(rates.shippingPerKgUsd, DEFAULT_CURRENCY_RATES.shippingPerKgUsd)),
    parcelFeeUsd: Math.max(0, finiteNumber(rates.parcelFeeUsd, DEFAULT_CURRENCY_RATES.parcelFeeUsd)),
    handlingFeeCny: Math.max(0, finiteNumber(rates.handlingFeeCny, DEFAULT_CURRENCY_RATES.handlingFeeCny)),
    platformFeeRate: Math.max(0, finiteNumber(rates.platformFeeRate, DEFAULT_CURRENCY_RATES.platformFeeRate)),
    customsThresholdUsd: Math.max(0, finiteNumber(rates.customsThresholdUsd, DEFAULT_CURRENCY_RATES.customsThresholdUsd)),
    customsDutyRate: Math.max(0, finiteNumber(rates.customsDutyRate, DEFAULT_CURRENCY_RATES.customsDutyRate)),
    fxLossRate: Math.max(0, finiteNumber(rates.fxLossRate, DEFAULT_CURRENCY_RATES.fxLossRate)),
    updated_at: rates.updated_at || "",
  };
}

export function calculateQuickArbitrage({ costCny = 0, weightKg = 0, priceUsd = 0, rates = {} } = {}) {
  const normalized = normalizeCurrencyRates(rates);
  const safeCostCny = Math.max(0, finiteNumber(costCny, 0));
  const safeWeightKg = Math.max(0, finiteNumber(weightKg, 0));
  const safePriceUsd = Math.max(0, finiteNumber(priceUsd, 0));

  const costUsd = (safeCostCny / normalized.usdToCny) * (1 + normalized.fxLossRate);
  const handlingUsd = (normalized.handlingFeeCny / normalized.usdToCny) * (1 + normalized.fxLossRate);
  const shippingUsd = (safeWeightKg * normalized.shippingPerKgUsd) + normalized.parcelFeeUsd + handlingUsd;
  const commissionUsd = safePriceUsd * normalized.platformFeeRate;
  const customsUsd = safePriceUsd > normalized.customsThresholdUsd
    ? (safePriceUsd - normalized.customsThresholdUsd) * normalized.customsDutyRate
    : 0;
  const netProfitUsd = safePriceUsd - costUsd - shippingUsd - commissionUsd - customsUsd;
  const marginRate = safePriceUsd > 0 ? (netProfitUsd / safePriceUsd) * 100 : 0;

  return {
    rates: normalized,
    costCny: safeCostCny,
    weightKg: safeWeightKg,
    priceUsd: safePriceUsd,
    costUsd,
    handlingUsd,
    shippingUsd,
    commissionUsd,
    customsUsd,
    netProfitUsd,
    marginRate,
  };
}

function hasChromeStorage() {
  return typeof chrome !== "undefined" && chrome.storage?.local;
}

async function readStoredRates() {
  if (!hasChromeStorage()) return {};
  return new Promise((resolve) => {
    chrome.storage.local.get([CURRENCY_RATES_STORAGE_KEY], (data) => {
      resolve(data?.[CURRENCY_RATES_STORAGE_KEY] || {});
    });
  });
}

async function writeStoredRates(rates) {
  if (!hasChromeStorage()) return rates;
  return new Promise((resolve) => {
    chrome.storage.local.set({ [CURRENCY_RATES_STORAGE_KEY]: rates }, () => resolve(rates));
  });
}

function isFresh(updatedAt = "", now = Date.now()) {
  const timestamp = Date.parse(updatedAt);
  return Number.isFinite(timestamp) && (now - timestamp) < ONE_DAY_MS;
}

async function fetchUsdRates() {
  const response = await fetch("https://open.er-api.com/v6/latest/USD");
  if (!response.ok) throw new Error(`Currency API returned HTTP ${response.status}`);
  const payload = await response.json();
  const usdToCny = Number(payload?.rates?.CNY);
  const usdToEur = Number(payload?.rates?.EUR);
  if (!Number.isFinite(usdToCny) || usdToCny <= 0) {
    throw new Error("Currency API response did not include a valid USD/CNY rate");
  }
  return {
    usdToCny,
    eurToUsd: Number.isFinite(usdToEur) && usdToEur > 0 ? 1 / usdToEur : DEFAULT_CURRENCY_RATES.eurToUsd,
    source: "open.er-api.com",
    updated_at: new Date().toISOString(),
  };
}

export async function getCurrencyRates({ forceRefresh = false } = {}) {
  const stored = normalizeCurrencyRates(await readStoredRates());
  if (!forceRefresh && isFresh(stored.updated_at)) return stored;

  try {
    const live = await fetchUsdRates();
    const merged = normalizeCurrencyRates({
      ...stored,
      ...live,
      shippingPerKgUsd: stored.shippingPerKgUsd,
      parcelFeeUsd: stored.parcelFeeUsd,
      handlingFeeCny: stored.handlingFeeCny,
      platformFeeRate: stored.platformFeeRate,
      customsThresholdUsd: stored.customsThresholdUsd,
      customsDutyRate: stored.customsDutyRate,
      fxLossRate: stored.fxLossRate,
    });
    await writeStoredRates(merged);
    return merged;
  } catch (err) {
    const fallback = normalizeCurrencyRates({
      ...stored,
      source: stored.source === "default_assumption" ? "default_assumption_fetch_failed" : stored.source,
      fetch_error: err.message || String(err),
    });
    if (!stored.updated_at) await writeStoredRates(fallback);
    return fallback;
  }
}

export async function saveCurrencyRates(rates = {}) {
  const normalized = normalizeCurrencyRates({
    ...(await readStoredRates()),
    ...rates,
    source: rates.source || "manual",
    updated_at: rates.updated_at || new Date().toISOString(),
  });
  await writeStoredRates(normalized);
  return normalized;
}

export async function getCurrencyRateContextForPrompt() {
  const rates = await getCurrencyRates();
  return {
    base_currency: "USD",
    quote_currency: "CNY",
    USD_to_CNY: rates.usdToCny,
    EUR_to_USD: rates.eurToUsd,
    fx_loss_rate: rates.fxLossRate,
    shipping_per_kg_usd: rates.shippingPerKgUsd,
    parcel_fee_usd: rates.parcelFeeUsd,
    handling_fee_cny: rates.handlingFeeCny,
    platform_fee_rate: rates.platformFeeRate,
    customs_threshold_usd: rates.customsThresholdUsd,
    customs_duty_rate: rates.customsDutyRate,
    updated_at: rates.updated_at || "",
    source: rates.source || "default_assumption",
    limitation: rates.fetch_error
      ? `实时汇率刷新失败，当前使用缓存/默认值：${rates.fetch_error}`
      : "用于 Etsy-1688 跨境套利账本；所有 CNY 成本必须先换算为 USD 后再与 Etsy 售价相减。",
  };
}
