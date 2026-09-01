// Etsy Campaign Adapter: local, evidence-aware analysis and a safe outbound handoff.
// It deliberately does not call an Ads endpoint or mutate Etsy campaign settings.

const HANDOFF_VERSION = "promotion-object-handoff.v1";
export const ADS_EVIDENCE_BUNDLE_VERSION = "marqel.etsy-ads-evidence-bundle.v1";
const ADS_EVIDENCE_VERSION = "marqel.etsy-ads-evidence.v1";
const ACCEPTED_ADS_IMPORT_SOURCES = new Set(["etsy_ads_export", "operator_snapshot"]);
const SENSITIVE_ADS_INPUT_KEY = /(?:authorization|cookie|password|secret|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|buyer|email|phone|address|payment)/i;

function finiteNonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const cleaned = String(value ?? "").replace(/[,$£€¥%\s]/g, "").replace(/\((.+)\)/, "-$1");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function requiredText(value, label, maximum = 2_000) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maximum) throw new Error(`${label} is required and must be no longer than ${maximum} characters.`);
  return normalized;
}

function textList(value, maximumItems = 500) {
  const list = Array.isArray(value) ? value : String(value ?? "").split(/[\n|;]/);
  return list.map((item) => String(item ?? "").trim()).filter(Boolean).slice(0, maximumItems);
}

function uniqueTextList(value, maximumItems = 500) {
  return [...new Set(textList(value, maximumItems))];
}

function assertNoSensitiveAdsInput(value, trail = "input", depth = 0) {
  if (depth > 10) throw new Error(`${trail} exceeds the accepted nesting depth.`);
  if (Array.isArray(value)) return value.forEach((item, index) => assertNoSensitiveAdsInput(item, `${trail}[${index}]`, depth + 1));
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_ADS_INPUT_KEY.test(key)) throw new Error(`${trail}.${key} contains private or credential-like data that Ads evidence imports do not accept.`);
    assertNoSensitiveAdsInput(nested, `${trail}.${key}`, depth + 1);
  }
}

function splitDelimitedLine(line, delimiter) {
  const values = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) {
      values.push(value.trim());
      value = "";
    } else {
      value += character;
    }
  }
  if (quoted) throw new Error("Ads evidence contains an unterminated quoted field.");
  values.push(value.trim());
  return values;
}

function parseDelimitedRows(text) {
  const lines = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) throw new Error("Ads CSV/TSV must contain a header and at least one data row.");
  const delimiter = [",", "\t", ";"].map((candidate) => ({ candidate, count: splitDelimitedLine(lines[0], candidate).length })).sort((left, right) => right.count - left.count)[0].candidate;
  const headers = splitDelimitedLine(lines[0], delimiter).map((header) => requiredText(header, "Ads evidence column", 160));
  if (headers.some((header) => SENSITIVE_ADS_INPUT_KEY.test(header))) throw new Error("Ads evidence columns must not contain buyer, payment, contact, or credential data.");
  return lines.slice(1).map((line) => {
    const values = splitDelimitedLine(line, delimiter);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  });
}

function stableEvidenceFingerprint(value) {
  let hash = 2166136261;
  for (const character of String(value || "")) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Parses a user-selected JSON, CSV, or TSV Ads evidence file without accessing an Etsy page. */
export function parseAdsEvidenceDocument(text, { fileName = "ads-evidence" } = {}) {
  const raw = requiredText(text, "Ads evidence file", 2 * 1024 * 1024);
  let input;
  let format;
  if (/\.json$/i.test(fileName) || /^[\s\r\n]*[\[{]/.test(raw)) {
    input = JSON.parse(raw);
    assertNoSensitiveAdsInput(input);
    format = "json";
    if (input?.schema_version === ADS_EVIDENCE_BUNDLE_VERSION) {
      if (!input.metrics || !Array.isArray(input.evidence)) throw new Error("Ads evidence bundle is missing metrics or evidence records.");
      return { format: "bundle", bundle: structuredClone(input), rows: [structuredClone(input.metrics)], sourceRef: input.metrics.source_refs?.[0] || "" };
    }
    if (Array.isArray(input)) input = { rows: input };
    if (input?.metrics && !input.rows) input = { rows: [input.metrics] };
    if (!Array.isArray(input?.rows) || !input.rows.length) throw new Error("Ads JSON must be an array, a rows object, a metrics object, or a supported evidence bundle.");
  } else {
    input = { rows: parseDelimitedRows(raw) };
    format = "delimited";
  }
  return {
    format,
    rows: structuredClone(input.rows),
    sourceRef: `operator-file://${String(fileName || "ads-evidence").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 120)}/${stableEvidenceFingerprint(raw)}`,
  };
}

function normalizedKey(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function firstValue(row, aliases) {
  for (const [key, value] of Object.entries(row || {})) {
    if (aliases.includes(normalizedKey(key))) return value;
  }
  return null;
}

function parsedMetric(row, aliases, label, { integer = false } = {}) {
  const raw = firstValue(row, aliases);
  if (raw === null || raw === undefined || String(raw).trim() === "") return 0;
  const parsed = parseNumber(raw);
  if (!finiteNonNegative(parsed) || (integer && !Number.isInteger(parsed))) throw new Error(`${label} must be a non-negative${integer ? " integer" : ""} value.`);
  return parsed;
}

function aggregateAdsRows(rows = []) {
  if (!Array.isArray(rows) || !rows.length) throw new Error("At least one Ads evidence row is required.");
  const totals = { spend: 0, attributedRevenue: 0, orders: 0, clicks: 0, impressions: 0, orderRefs: [] };
  rows.forEach((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(`Ads evidence row ${index + 1} must be an object.`);
    assertNoSensitiveAdsInput(row, `rows[${index}]`);
    totals.spend += parsedMetric(row, ["spendusd", "spend", "cost", "adspend", "advertisingspend"], `Row ${index + 1} spend`);
    totals.attributedRevenue += parsedMetric(row, ["attributedrevenueusd", "attributedrevenue", "revenue", "sales", "ordersrevenue"], `Row ${index + 1} attributed revenue`);
    totals.orders += parsedMetric(row, ["attributedorders", "orders", "salescount", "purchases"], `Row ${index + 1} orders`, { integer: true });
    totals.clicks += parsedMetric(row, ["clicks", "adclicks"], `Row ${index + 1} clicks`, { integer: true });
    totals.impressions += parsedMetric(row, ["impressions", "views", "adviews"], `Row ${index + 1} impressions`, { integer: true });
    totals.orderRefs.push(...textList(firstValue(row, ["attributedorderrefs", "orderrefs", "orderreferences", "orderids"])));
  });
  return totals;
}

function validTimeZone(value) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: String(value || "") }).format();
    return true;
  } catch {
    return false;
  }
}

/** Builds one Campaign Operator-compatible, non-secret evidence bundle from a user-selected file or manual aggregate. */
export function buildAdsEvidenceBundle({ rows = [], metadata = {}, now = new Date() } = {}) {
  const totals = aggregateAdsRows(rows);
  const source = String(metadata.source || "operator_snapshot");
  if (!ACCEPTED_ADS_IMPORT_SOURCES.has(source)) throw new Error("Ads imports support only etsy_ads_export or operator_snapshot; visible-page evidence requires a separately authorized capture path.");
  const sourceRefs = uniqueTextList(metadata.sourceRefs);
  const metadataOrderRefs = textList(metadata.orderRefs);
  const orderRefs = metadataOrderRefs.length ? metadataOrderRefs : totals.orderRefs;
  const observedAt = String(metadata.observedAt || now.toISOString());
  const periodStart = String(metadata.periodStart || "");
  const periodEnd = String(metadata.periodEnd || "");
  const timeZone = String(metadata.timeZone || "UTC");
  const currency = String(metadata.currency || "USD").toUpperCase();
  const attributionWindowDays = Number(metadata.attributionWindowDays ?? 30);
  const revenueBasis = String(metadata.revenueBasis || "etsy_ads_attributed_gross");
  const gaps = [];
  const observedTime = Date.parse(observedAt);
  const periodStartTime = Date.parse(periodStart);
  const periodEndTime = Date.parse(periodEnd);
  if (!sourceRefs.length) gaps.push("metrics_source_refs_missing");
  if (!Number.isFinite(observedTime)) gaps.push("observed_at_invalid");
  if (!Number.isFinite(periodStartTime) || !Number.isFinite(periodEndTime) || periodEndTime <= periodStartTime) gaps.push("measurement_period_invalid");
  if (Number.isFinite(observedTime) && Number.isFinite(periodEndTime) && periodEndTime > observedTime + 300_000) gaps.push("measurement_period_after_observation");
  if (!validTimeZone(timeZone)) gaps.push("time_zone_invalid");
  if (currency !== "USD") gaps.push("currency_mismatch");
  if (!Number.isInteger(attributionWindowDays) || attributionWindowDays <= 0) gaps.push("attribution_window_invalid");
  if (!["etsy_ads_attributed_gross", "order_net_reconciled"].includes(revenueBasis)) gaps.push("revenue_basis_unsupported");
  if (totals.orders > 0 && orderRefs.length !== totals.orders) gaps.push("attributed_order_refs_count_mismatch");
  if (totals.orders > 0 && new Set(orderRefs).size !== orderRefs.length) gaps.push("duplicate_attributed_order_refs");
  const reconciliationStatus = totals.orders === 0 ? "not_applicable" : orderRefs.length === totals.orders ? "reconciled" : "unreconciled";
  const metrics = {
    source,
    source_refs: sourceRefs,
    observed_at: observedAt,
    period_start: periodStart,
    period_end: periodEnd,
    time_zone: timeZone,
    currency,
    attribution_window_days: attributionWindowDays,
    revenue_basis: revenueBasis,
    reconciliation_status: reconciliationStatus,
    spend_usd: round(totals.spend),
    attributed_revenue_usd: round(totals.attributedRevenue),
    attributed_orders: totals.orders,
    attributed_order_refs: orderRefs,
    clicks: totals.clicks,
    impressions: totals.impressions,
  };
  const localAnalysis = analyzeEtsyAdvertising([{ channel: "etsy_ads", spend: totals.spend, attributedRevenue: totals.attributedRevenue, orders: totals.orders, clicks: totals.clicks, impressions: totals.impressions }]);
  const createdAt = now.toISOString();
  return {
    schema_version: ADS_EVIDENCE_BUNDLE_VERSION,
    evidence_id: `etsy-ads-evidence-${stableEvidenceFingerprint(`${createdAt}:${sourceRefs.join(":")}`)}`,
    created_at: createdAt,
    data_quality: { status: gaps.length ? "invalid" : "valid", gaps: [...new Set(gaps)] },
    metrics,
    evidence: [{
      schema_version: ADS_EVIDENCE_VERSION,
      source,
      source_refs: sourceRefs,
      observed_at: observedAt,
      input_mode: "user_selected_file_or_manual_aggregate",
      row_count: Number.isInteger(Number(metadata.rowCount)) && Number(metadata.rowCount) > 0 ? Number(metadata.rowCount) : rows.length,
      contains_raw_rows: false,
    }],
    local_preview: localAnalysis.channels.etsy_ads,
    safety: {
      external_action_allowed: false,
      noAutomaticBudgetMutation: true,
      browserScrapingPerformed: false,
      credentialsIncluded: false,
      canonicalDecisionOwner: "etsy-campaign-operator_and_control_center",
    },
  };
}

function detectedChannel(capture = {}) {
  const page = `${capture.pageTitle || ""} ${capture.pageHeading || ""}`.toLowerCase();
  if (page.includes("offsite")) return "offsite_ads";
  if (page.includes("etsy ads") || page.includes("advertising")) return "etsy_ads";
  return "unknown";
}

function round(value, digits = 2) {
  return Number(value.toFixed(digits));
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

function metricTotals(rows = []) {
  const sum = (field) => rows.reduce((total, row) => total + (finiteNonNegative(row[field]) ? row[field] : 0), 0);
  const spend = sum("spend");
  const attributedRevenue = sum("attributedRevenue");
  const orders = sum("orders");
  const clicks = sum("clicks");
  const impressions = sum("impressions");
  return {
    rows: rows.length,
    spend: round(spend), attributedRevenue: round(attributedRevenue), orders, clicks, impressions,
    roas: ratio(attributedRevenue, spend) === null ? null : round(ratio(attributedRevenue, spend)),
    acos: ratio(spend, attributedRevenue) === null ? null : round(ratio(spend, attributedRevenue) * 100),
    cpa: ratio(spend, orders) === null ? null : round(ratio(spend, orders)),
    cpc: ratio(spend, clicks) === null ? null : round(ratio(spend, clicks)),
    ctr: ratio(clicks, impressions) === null ? null : round(ratio(clicks, impressions) * 100, 3),
    conversionRate: ratio(orders, clicks) === null ? null : round(ratio(orders, clicks) * 100, 2),
  };
}

function evidenceStatus(records = [], now = new Date()) {
  if (!records.length) return { status: "missing", coverage: 0, freshestAt: null, reasons: ["No source records supplied."] };
  const dated = records.filter((record) => record.observedAt && !Number.isNaN(Date.parse(record.observedAt)));
  const freshestAt = dated.length ? dated.map((record) => record.observedAt).sort().at(-1) : null;
  const ageDays = freshestAt ? (now - new Date(freshestAt)) / 86_400_000 : Infinity;
  const observed = records.filter((record) => record.kind === "observed").length;
  const coverage = Number((observed / records.length).toFixed(2));
  const status = coverage === 0 ? "missing" : ageDays > 14 ? "stale" : coverage < 0.7 ? "partial" : "ready";
  const reasons = [];
  if (coverage < 0.7) reasons.push(`Only ${observed}/${records.length} inputs are observed data.`);
  if (ageDays > 14) reasons.push(freshestAt ? `Freshest input is ${Math.floor(ageDays)} days old.` : "Inputs have no usable observation timestamp.");
  return { status, coverage, freshestAt, reasons };
}

/** Converts separately authorized visible Shop Manager evidence into rows. This is not wired to the production UI. */
export function normalizeVisibleAdsCapture(capture = {}) {
  if (capture.schemaVersion !== "etsy.shop-manager.visible-capture.v1") throw new Error("Unsupported Etsy visible Ads capture schema.");
  if (!String(capture.authorizationReference || "").trim()) throw new Error("Visible Etsy Ads capture requires an explicit Etsy authorization reference; use user-selected file import otherwise.");
  if (!capture.capturedAt || Number.isNaN(Date.parse(capture.capturedAt))) throw new Error("Visible Ads capture must include an ISO capturedAt timestamp.");
  const channel = detectedChannel(capture);
  const rows = (capture.tables || []).flatMap((table) => table.rows || []).map((raw) => {
    const spend = parseNumber(firstValue(raw, ["spend", "cost", "adspend", "advertisingspend"]));
    const attributedRevenue = parseNumber(firstValue(raw, ["revenue", "sales", "attributedrevenue", "ordersrevenue"]));
    const orders = parseNumber(firstValue(raw, ["orders", "salescount", "purchases"]));
    const clicks = parseNumber(firstValue(raw, ["clicks", "adclicks"]));
    const impressions = parseNumber(firstValue(raw, ["impressions", "views"]));
    const listingId = firstValue(raw, ["listingid", "listing", "itemid", "item"]);
    return {
      date: capture.capturedAt.slice(0, 10), observedAt: capture.capturedAt, kind: "observed", source: "etsy_shop_manager_visible_page", channel,
      listingId: listingId ? String(listingId) : null,
      ...(finiteNonNegative(spend) ? { spend } : {}), ...(finiteNonNegative(attributedRevenue) ? { attributedRevenue } : {}),
      ...(finiteNonNegative(orders) ? { orders } : {}), ...(finiteNonNegative(clicks) ? { clicks } : {}), ...(finiteNonNegative(impressions) ? { impressions } : {}),
    };
  }).filter((row) => ["spend", "attributedRevenue", "orders", "clicks", "impressions"].some((key) => key in row));
  return {
    source: "etsy_shop_manager_visible_page", capturedAt: capture.capturedAt,
    page: { title: capture.pageTitle || "", heading: capture.pageHeading || "", url: capture.pageUrl || "" }, channel, rows,
    warnings: [
      ...(channel === "unknown" ? ["无法从当前可见页面标题区分 Etsy Ads 与 Offsite Ads。"] : []),
      ...(rows.length === 0 ? ["可见表格未识别到标准广告指标；必须人工检查原始页面。"] : []),
      "数据来自用户触发的可见页面采集，并非 Etsy Open API 返回值。",
      `页面采集授权引用：${capture.authorizationReference}`,
    ],
  };
}

function recommendation(channel, metrics, previous, targetAcosPct, minOrders) {
  if (metrics.rows === 0) return { action: "collect_data", mode: "no_mutation", reason: "没有导入可用观察记录。" };
  if (metrics.orders < minOrders) return { action: "hold_for_sample", mode: "no_mutation", reason: `归因订单 ${metrics.orders}/${minOrders}，样本不足。` };
  if (metrics.acos === null) return { action: "audit_attribution", mode: "no_mutation", reason: "缺少广告花费或归因收入，ACOS 无法计算。" };
  const worsening = previous?.acos !== null && previous?.acos !== undefined && metrics.acos > previous.acos * 1.15;
  if (channel === "etsy_ads" && metrics.acos <= targetAcosPct * 0.8 && !worsening) return { action: "candidate_scale", mode: "approval_required", reason: "ACOS 显著低于目标且订单样本足够；仅建议人工批准的有限预算实验。" };
  if (metrics.acos > targetAcosPct || worsening) return channel === "offsite_ads"
    ? { action: "review_listing_economics", mode: "approval_required", reason: "Offsite Ads 不是逐 Listing 出价界面；先复核利润、价格和页面转化。" }
    : { action: "candidate_reduce_or_retarget", mode: "approval_required", reason: "ACOS 超过目标或恶化；先复核搜索词、页面转化和利润。" };
  return { action: "maintain_and_test_creative", mode: "approval_required", reason: "效率位于护栏内；一次只测试一个 Listing 或创意变量。" };
}

/** Analyses Etsy Ads and Offsite Ads evidence without any budget mutation path. */
export function analyzeEtsyAdvertising(rows = [], policy = {}) {
  const targetAcosPct = policy.targetAcosPct ?? 35;
  const minOrders = policy.minOrders ?? 8;
  const currentRows = rows.filter((row) => row.period !== "previous");
  const previousRows = rows.filter((row) => row.period === "previous");
  const normalizeChannel = (value) => {
    const key = String(value || "").toLowerCase().replace(/[ _-]/g, "");
    if (key === "etsyads" || key === "onsite") return "etsy_ads";
    if (key === "offsiteads" || key === "offsite") return "offsite_ads";
    return "unknown";
  };
  const channels = Object.fromEntries(["etsy_ads", "offsite_ads"].map((channel) => {
    const current = metricTotals(currentRows.filter((row) => normalizeChannel(row.channel) === channel));
    const previous = metricTotals(previousRows.filter((row) => normalizeChannel(row.channel) === channel));
    return [channel, { metrics: current, previousMetrics: previous, recommendation: recommendation(channel, current, previous, targetAcosPct, minOrders) }];
  }));
  return { policy: { targetAcosPct, minOrders }, channels, constraints: { noAutomaticBudgetMutation: true, offsiteAds: "report_and_review_only", attributionCaveat: "归因收入是渠道报告归因，并不等于增量利润或因果提升。" } };
}

/** Keeps the prototype trend queue as an explicit evidence-gated decision aid. */
export function analyzeEtsyTrendCandidates(candidates = [], { now = new Date() } = {}) {
  const clamp = (value, min = 0, max = 100) => Math.min(max, Math.max(min, value));
  return candidates.map((candidate) => {
    const signals = candidate.signals || {};
    const evidence = evidenceStatus(candidate.evidence || [], now);
    const missing = ["searchGrowthPct", "salesGrowthPct", "saveRatePct", "competitionCount", "grossMarginPct"]
      .filter((key) => !finiteNonNegative(signals[key]));
    const demandVelocity = clamp((signals.searchGrowthPct || 0) * 0.55 + (signals.salesGrowthPct || 0) * 0.45);
    const demandQuality = clamp((signals.saveRatePct || 0) * 8 + (signals.repeatPurchasePct || 0) * 1.5);
    const competitionAdvantage = clamp(100 - Math.log10((signals.competitionCount || 1) + 1) * 25);
    const marginSafety = clamp((signals.grossMarginPct || 0) * 1.25);
    const opportunityScore = Math.round(demandVelocity * 0.31 + demandQuality * 0.19 + competitionAdvantage * 0.18 + marginSafety * 0.22 + evidence.coverage * 10);
    const status = evidence.status === "ready" && !missing.length && opportunityScore >= 65
      ? "test_ready"
      : evidence.status === "missing" || missing.length >= 3 ? "evidence_needed" : "watch";
    return {
      id: candidate.id, title: candidate.title, taxonomy: candidate.taxonomy || null, opportunityScore,
      components: { demandVelocity, demandQuality, competitionAdvantage, marginSafety, evidenceCoverage: evidence.coverage },
      evidence, missing, status,
      nextAction: status === "test_ready"
        ? "Run a bounded listing or creative test with a margin floor and explicit success metric."
        : status === "watch"
          ? "Collect another comparable period and validate price, margin, and competition before spending."
          : "Fill the listed evidence gaps; do not infer a launch decision from the composite score.",
    };
  }).sort((a, b) => b.opportunityScore - a.opportunityScore);
}

/** Creative segmentation is a hypothesis lane, never demographic inference. */
export function analyzeCreativeHypothesisSignals({ listing = {}, signals = [], evidence = [] } = {}, { now = new Date() } = {}) {
  const evidenceSummary = evidenceStatus(evidence, now);
  const normalized = new Set(signals.map((signal) => String(signal).toLowerCase()));
  const strengths = [];
  if (normalized.has("personalization")) strengths.push("Personalization can support identity- and gift-led creative tests.");
  if (normalized.has("giftable")) strengths.push("Giftability supports occasion-led hooks and short-form creator briefs.");
  if (normalized.has("visual_process")) strengths.push("A visible making/customization process supports process-first media sequencing.");
  if (normalized.has("small_batch") || normalized.has("handmade")) strengths.push("Small-batch or handmade proof can support provenance messaging if substantiated.");
  const gaps = [];
  if (!normalized.has("mobile_creative_test")) gaps.push("No observed mobile-first creative test result.");
  if (!normalized.has("price_value_test")) gaps.push("No observed price/value-message comparison.");
  if (!normalized.has("review_theme")) gaps.push("No review-theme evidence explaining why customers buy or hesitate.");
  return {
    listingId: listing.id || null, label: "creative_hypothesis_not_demographic_fact", evidence: evidenceSummary, strengths, gaps,
    recommendations: evidenceSummary.status === "ready" && strengths.length >= 2
      ? ["Test one mobile-first creative hook against a control.", "Test a substantiated personalization or provenance claim.", "Measure listing conversion and contribution margin, not demographic assumptions."]
      : ["Collect approved creative, review-theme, and conversion evidence before making audience-specific claims."],
    prohibitedClaims: ["Do not infer a buyer age from Etsy behavior.", "Do not report demographic ROAS or conversion without an authorized, explicit demographic source."],
  };
}

function cleanTextList(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((item) => String(item || "").trim()).filter(Boolean))];
}

function cleanMedia(values) {
  return cleanTextList(values).filter((value) => /^https:\/\//i.test(value) || value.startsWith("asset://"));
}

/**
 * Creates a provider-neutral handoff. It excludes all credentials, browser
 * sessions, AdsPower endpoints, screenshots/data URLs and mutation commands.
 */
export function buildEtsyOutreachHandoff({ tenantId, shop = {}, listing = {}, campaign = {}, claims = {}, media = {}, approval = {}, evidence = {}, authority = {}, now = new Date() } = {}) {
  const issuedAt = now.toISOString();
  const expiresAt = approval.expiresAt || campaign.expiresAt || "";
  if (!tenantId) throw new Error("tenantId is required for an outreach handoff.");
  if (!listing.id || !listing.url || !listing.title) throw new Error("listing.id, listing.url, and listing.title are required.");
  if (!/^https:\/\/www\.etsy\.com\//.test(listing.url)) throw new Error("listing.url must be a public https://www.etsy.com/ URL.");
  if (!campaign.id || !campaign.objective) throw new Error("campaign.id and campaign.objective are required.");
  if (authority.contractVersion !== "marqel-campaign-authority.v1"
    || authority.sourceSystem !== "marqel-control-center"
    || authority.canonical !== true
    || !authority.operationId
    || authority.campaignId !== campaign.id
    || !authority.approvalId
    || !authority.targetRef
    || !authority.expectedUpdatedAt
    || !String(authority.readbackRef || "").startsWith("marqel://")) {
    throw new Error("A canonical Control Center Campaign approval readback is required; local Growth Agent approval is not authoritative.");
  }
  if (approval.status !== "approved") throw new Error("Only explicitly approved campaigns may be handed to outreach.");
  if (!approval.approvedBy || !approval.approvedAt || !expiresAt) throw new Error("approval.approvedBy, approval.approvedAt, and expiresAt are required.");
  if (approval.revoked === true) throw new Error("A revoked campaign cannot be handed to outreach.");
  if (Number.isNaN(Date.parse(expiresAt)) || new Date(expiresAt) <= now) throw new Error("The campaign approval is expired or has an invalid expiresAt.");
  const approvedFacts = cleanTextList(claims.approvedFacts);
  if (approvedFacts.length === 0) throw new Error("At least one approved product fact is required for outreach.");
  const doNotClaim = cleanTextList(claims.doNotClaim);
  const mustDisclose = cleanTextList(claims.mustDisclose);
  const images = cleanMedia(media.images);
  return {
    schema_version: HANDOFF_VERSION, handoff_id: `etsy-outreach-${campaign.id}-${listing.id}-${Date.now()}`, issued_at: issuedAt,
    source: { system: "etsy-growth-agent", tenant_id: String(tenantId), shop_id: String(shop.id || ""), shop_name: String(shop.name || ""), listing_id: String(listing.id), campaign_id: String(campaign.id), operation_id: String(authority.operationId) },
    object: { object_id: `etsy-listing-${listing.id}`, object_type: "product", source_url: listing.url, title: listing.title, summary: String(listing.summary || ""), language: String(listing.language || "en"), target_audiences: cleanTextList(campaign.targetAudiences), tags: cleanTextList(listing.tags) },
    claim_policy: { approved_facts: approvedFacts, do_not_claim: doNotClaim, must_disclose: mustDisclose },
    media: { images, asset_manifest_refs: cleanTextList(media.assetManifestRefs), usage_rights: String(media.usageRights || "operator_confirmed") },
    campaign: { id: String(campaign.id), objective: String(campaign.objective), target_regions: cleanTextList(campaign.targetRegions), allowed_channels: cleanTextList(campaign.allowedChannels), utm_campaign: String(campaign.utmCampaign || ""), status: "approved", expires_at: expiresAt, etsy_ads_recommendation: evidence.adsRecommendation || null },
    approval: { status: "approved", approved_by: String(approval.approvedBy), approved_at: String(approval.approvedAt), expires_at: expiresAt, revoked: false, authority: { contract_version: authority.contractVersion, source_system: authority.sourceSystem, campaign_id: authority.campaignId, approval_id: authority.approvalId, target_ref: authority.targetRef, expected_updated_at: authority.expectedUpdatedAt, readback_ref: authority.readbackRef } },
    evidence: { listing_evidence_refs: cleanTextList(evidence.listingEvidenceRefs), report_ids: cleanTextList(evidence.reportIds), freshness_at: String(evidence.freshnessAt || issuedAt), provenance: "Control Center canonical Campaign approval plus Etsy Growth Agent local evidence" },
    security_boundary: { public_submit_automation: "disabled", contains_credentials: false, contains_browser_session: false, cloud_authorization_verified: false, note: "Downstream services must verify the tenant session and entitlement with the cloud authorization center before creating a live run." },
  };
}

export const ETSY_OUTREACH_HANDOFF_VERSION = HANDOFF_VERSION;
