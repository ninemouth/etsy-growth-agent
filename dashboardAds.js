import { buildAdsEvidenceBundle, parseAdsEvidenceDocument } from "./modules/etsyCampaignAdapter.js";

const STORAGE_KEY = "etsyAdsEvidenceBundles";
const MAX_HISTORY = 24;
const state = { currentBundle: null, importedRowCount: 0 };
const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? "—").replace(/[&<>'"]/g, (character) => ({ "&": "&#38;", "<": "&#60;", ">": "&#62;", "'": "&#39;", '"': "&#34;" })[character]);
}

function localDateTimeValue(value) {
  const date = value instanceof Date ? value : new Date(value);
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function isoFromLocalInput(id) {
  const value = $(id)?.value;
  const parsed = new Date(value || "");
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : "";
}

function stringList(value) {
  return [...new Set(String(value || "").split(/[\n|;]/).map((item) => item.trim()).filter(Boolean))];
}

function orderedStringList(value) {
  return String(value || "").split(/[\n|;]/).map((item) => item.trim()).filter(Boolean);
}

function numericValue(id, { integer = false } = {}) {
  const value = Number($(id)?.value);
  if (!Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) throw new Error(`${$(id)?.closest("label")?.querySelector("span")?.textContent || id} 必须是非负${integer ? "整数" : "数字"}。`);
  return value;
}

function setMessage(message = "", kind = "info") {
  const element = $("ads-evidence-message");
  if (!element) return;
  element.textContent = message;
  element.dataset.kind = kind;
  element.hidden = !message;
}

function defaultFormValues() {
  const now = new Date();
  const periodStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  $("ads-evidence-observed-at").value = localDateTimeValue(now);
  $("ads-evidence-period-end").value = localDateTimeValue(now);
  $("ads-evidence-period-start").value = localDateTimeValue(periodStart);
  $("ads-evidence-time-zone").value = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  $("ads-evidence-attribution-window").value = "30";
  $("ads-evidence-currency").value = "USD";
}

function readMetadata() {
  return {
    source: $("ads-evidence-source").value,
    sourceRefs: stringList($("ads-evidence-source-refs").value),
    orderRefs: orderedStringList($("ads-evidence-order-refs").value),
    observedAt: isoFromLocalInput("ads-evidence-observed-at"),
    periodStart: isoFromLocalInput("ads-evidence-period-start"),
    periodEnd: isoFromLocalInput("ads-evidence-period-end"),
    timeZone: $("ads-evidence-time-zone").value.trim(),
    currency: $("ads-evidence-currency").value.trim(),
    attributionWindowDays: Number($("ads-evidence-attribution-window").value),
    revenueBasis: $("ads-evidence-revenue-basis").value,
    rowCount: state.importedRowCount || 1,
  };
}

function readAggregateRow() {
  return {
    spend_usd: numericValue("ads-evidence-spend"),
    attributed_revenue_usd: numericValue("ads-evidence-revenue"),
    attributed_orders: numericValue("ads-evidence-orders", { integer: true }),
    attributed_order_refs: orderedStringList($("ads-evidence-order-refs").value),
    clicks: numericValue("ads-evidence-clicks", { integer: true }),
    impressions: numericValue("ads-evidence-impressions", { integer: true }),
  };
}

function fillMetrics(metrics = {}) {
  $("ads-evidence-source").value = ["etsy_ads_export", "operator_snapshot"].includes(metrics.source) ? metrics.source : "operator_snapshot";
  $("ads-evidence-source-refs").value = (metrics.source_refs || []).join("\n");
  $("ads-evidence-order-refs").value = (metrics.attributed_order_refs || []).join("\n");
  $("ads-evidence-spend").value = String(metrics.spend_usd ?? metrics.spend ?? 0);
  $("ads-evidence-revenue").value = String(metrics.attributed_revenue_usd ?? metrics.attributedRevenue ?? metrics.revenue ?? 0);
  $("ads-evidence-orders").value = String(metrics.attributed_orders ?? metrics.orders ?? 0);
  $("ads-evidence-clicks").value = String(metrics.clicks ?? 0);
  $("ads-evidence-impressions").value = String(metrics.impressions ?? 0);
  if (metrics.observed_at) $("ads-evidence-observed-at").value = localDateTimeValue(metrics.observed_at);
  if (metrics.period_start) $("ads-evidence-period-start").value = localDateTimeValue(metrics.period_start);
  if (metrics.period_end) $("ads-evidence-period-end").value = localDateTimeValue(metrics.period_end);
  if (metrics.time_zone) $("ads-evidence-time-zone").value = metrics.time_zone;
  if (metrics.attribution_window_days) $("ads-evidence-attribution-window").value = String(metrics.attribution_window_days);
  if (["etsy_ads_attributed_gross", "order_net_reconciled"].includes(metrics.revenue_basis)) $("ads-evidence-revenue-basis").value = metrics.revenue_basis;
}

function computedMetric(numerator, denominator) {
  return denominator > 0 ? Number((numerator / denominator).toFixed(2)) : null;
}

function renderSummary(bundle = state.currentBundle) {
  const qualityBadge = $("ads-evidence-quality");
  const summary = $("ads-evidence-summary");
  $("ads-evidence-download").disabled = !bundle;
  if (!bundle) {
    qualityBadge.textContent = "尚无证据";
    qualityBadge.dataset.tone = "neutral";
    summary.innerHTML = "<span>导入后显示 Spend、ROAS、CPA、证据缺口和本地非权威建议。</span>";
    return;
  }
  const metrics = bundle.metrics || {};
  const gaps = bundle.data_quality?.gaps || [];
  const valid = bundle.data_quality?.status === "valid";
  const roas = computedMetric(metrics.attributed_revenue_usd, metrics.spend_usd);
  const cpa = computedMetric(metrics.spend_usd, metrics.attributed_orders);
  const ctr = metrics.impressions > 0 ? Number(((metrics.clicks / metrics.impressions) * 100).toFixed(2)) : null;
  qualityBadge.textContent = valid ? "证据格式有效" : `存在 ${gaps.length} 个缺口`;
  qualityBadge.dataset.tone = valid ? "safe" : "attention";
  summary.innerHTML = `<dl><div><dt>Spend</dt><dd>$${escapeHtml(metrics.spend_usd)}</dd></div><div><dt>Revenue</dt><dd>$${escapeHtml(metrics.attributed_revenue_usd)}</dd></div><div><dt>ROAS</dt><dd>${escapeHtml(roas ?? "—")}</dd></div><div><dt>CPA</dt><dd>${escapeHtml(cpa ?? "—")}</dd></div><div><dt>CTR</dt><dd>${escapeHtml(ctr === null ? "—" : `${ctr}%`)}</dd></div><div><dt>Orders</dt><dd>${escapeHtml(metrics.attributed_orders)}</dd></div></dl><p>${valid ? `本地预览：${escapeHtml(bundle.local_preview?.recommendation?.action || "等待 Campaign Operator 评估")}` : `证据缺口：${gaps.map(escapeHtml).join("、")}`}</p><small>本地预览不是正式 Campaign Recommendation；external_action_allowed 始终为 false。</small>`;
}

async function renderHistory() {
  const stored = await new Promise((resolve) => chrome.storage.local.get([STORAGE_KEY], resolve));
  const history = Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
  const element = $("ads-evidence-history");
  if (!history.length) {
    element.innerHTML = "<span>尚无本地 Ads Evidence 历史。</span>";
    return;
  }
  element.innerHTML = history.slice(0, 5).map((bundle) => `<button type="button" data-ads-evidence-id="${escapeHtml(bundle.evidence_id)}"><strong>${escapeHtml(bundle.metrics?.source || "Ads evidence")}</strong><span>${escapeHtml(new Date(bundle.created_at).toLocaleString())}</span><small>Spend $${escapeHtml(bundle.metrics?.spend_usd)} · Orders ${escapeHtml(bundle.metrics?.attributed_orders)} · ${escapeHtml(bundle.data_quality?.status)}</small></button>`).join("");
  element.querySelectorAll("[data-ads-evidence-id]").forEach((button) => button.addEventListener("click", () => {
    const selected = history.find((bundle) => bundle.evidence_id === button.dataset.adsEvidenceId);
    if (!selected) return;
    state.currentBundle = selected;
    state.importedRowCount = Number(selected.evidence?.[0]?.row_count || 1);
    fillMetrics(selected.metrics);
    renderSummary(selected);
    setMessage("已载入本地 Ads Evidence；修改后需重新保存生成新版本。", "info");
  }));
}

async function importEvidenceFile() {
  const file = $("ads-evidence-file").files?.[0];
  if (!file) return;
  if (file.size <= 0 || file.size > 2 * 1024 * 1024) throw new Error("Ads 证据文件必须非空且不超过 2 MiB。");
  const parsed = parseAdsEvidenceDocument(await file.text(), { fileName: file.name });
  if (parsed.bundle) {
    state.currentBundle = parsed.bundle;
    state.importedRowCount = Number(parsed.bundle.evidence?.[0]?.row_count || 1);
    fillMetrics(parsed.bundle.metrics);
    renderSummary(parsed.bundle);
    setMessage("已载入 Evidence Bundle；尚未写入本地历史。", "success");
    return;
  }
  const provisional = buildAdsEvidenceBundle({
    rows: parsed.rows,
    metadata: { ...readMetadata(), source: "etsy_ads_export", sourceRefs: [parsed.sourceRef], rowCount: parsed.rows.length },
  });
  state.importedRowCount = parsed.rows.length;
  $("ads-evidence-source").value = "etsy_ads_export";
  fillMetrics(provisional.metrics);
  state.currentBundle = null;
  renderSummary(null);
  setMessage(`已解析 ${parsed.rows.length} 行并汇总到表单；请核对时间、时区、收入和订单口径后保存。`, "success");
}

async function saveEvidence() {
  const bundle = buildAdsEvidenceBundle({ rows: [readAggregateRow()], metadata: readMetadata() });
  const stored = await new Promise((resolve) => chrome.storage.local.get([STORAGE_KEY], resolve));
  const history = Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
  const nextHistory = [bundle, ...history.filter((entry) => entry.evidence_id !== bundle.evidence_id)].slice(0, MAX_HISTORY);
  await new Promise((resolve) => chrome.storage.local.set({ [STORAGE_KEY]: nextHistory }, resolve));
  state.currentBundle = bundle;
  renderSummary(bundle);
  await renderHistory();
  const valid = bundle.data_quality.status === "valid";
  setMessage(valid ? "Ads Evidence 已保存并完成本地分析；下载 Bundle 后交给 Campaign Operator 生成正式建议。" : "Ads Evidence 已按 fail-closed 保存，但存在证据缺口；Campaign Operator 将返回 INSUFFICIENT_EVIDENCE。", valid ? "success" : "error");
}

function downloadEvidence() {
  if (!state.currentBundle) return;
  const blob = new Blob([`${JSON.stringify(state.currentBundle, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${state.currentBundle.evidence_id}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  setMessage("Evidence Bundle 已下载。可将同一文件同时用于 Campaign Operator 的 --metrics 与 --evidence 参数。", "success");
}

function clearForm() {
  state.currentBundle = null;
  state.importedRowCount = 0;
  $("ads-evidence-file").value = "";
  $("ads-evidence-source").value = "operator_snapshot";
  $("ads-evidence-revenue-basis").value = "etsy_ads_attributed_gross";
  $("ads-evidence-source-refs").value = "";
  $("ads-evidence-order-refs").value = "";
  ["spend", "revenue", "orders", "clicks", "impressions"].forEach((suffix) => { $(`ads-evidence-${suffix}`).value = "0"; });
  defaultFormValues();
  renderSummary(null);
  setMessage();
}

document.addEventListener("DOMContentLoaded", async () => {
  if (!$("ads-evidence-file")) return;
  defaultFormValues();
  $("ads-evidence-file").addEventListener("change", () => importEvidenceFile().catch((error) => setMessage(error.message, "error")));
  $("ads-evidence-save").addEventListener("click", () => saveEvidence().catch((error) => setMessage(error.message, "error")));
  $("ads-evidence-download").addEventListener("click", downloadEvidence);
  $("ads-evidence-clear").addEventListener("click", clearForm);
  await renderHistory();
});
