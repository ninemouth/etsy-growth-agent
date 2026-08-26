import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  analyzeEtsyAdvertising,
  analyzeEtsyTrendCandidates,
  analyzeCreativeHypothesisSignals,
  buildEtsyOutreachHandoff,
  normalizeVisibleAdsCapture,
} from "../modules/etsyCampaignAdapter.js";

const capture = {
  schemaVersion: "etsy.shop-manager.visible-capture.v1",
  capturedAt: "2026-08-16T00:00:00.000Z",
  pageTitle: "Etsy Ads",
  pageHeading: "Etsy Ads performance",
  pageUrl: "https://www.etsy.com/your/shops/me/marketing/etsy-ads",
  tables: [{ rows: [{ Listing: "123", Spend: "$20", Revenue: "$120", Orders: "9", Clicks: "40", Impressions: "1000" }] }],
};

const normalized = normalizeVisibleAdsCapture(capture);
assert.equal(normalized.channel, "etsy_ads");
assert.equal(normalized.rows[0].listingId, "123");
const advertising = analyzeEtsyAdvertising(normalized.rows, { targetAcosPct: 30, minOrders: 8 });
assert.equal(advertising.channels.etsy_ads.metrics.acos, 16.67);
assert.equal(advertising.channels.etsy_ads.recommendation.mode, "approval_required");
assert.equal(advertising.constraints.noAutomaticBudgetMutation, true);
assert.equal(analyzeEtsyTrendCandidates([{ id: "trend-1", title: "Gift", signals: { searchGrowthPct: 80 } }], { now: new Date("2026-08-16T01:00:00.000Z") })[0].status, "evidence_needed");
const creative = analyzeCreativeHypothesisSignals({ listing: { id: "123" }, signals: ["personalization", "giftable", "mobile_creative_test", "price_value_test", "review_theme"], evidence: [{ kind: "observed", observedAt: "2026-08-16T00:00:00.000Z" }] }, { now: new Date("2026-08-16T01:00:00.000Z") });
assert.equal(creative.label, "creative_hypothesis_not_demographic_fact");
assert.equal(creative.prohibitedClaims.length, 2);

const handoff = buildEtsyOutreachHandoff({
  tenantId: "tenant-demo",
  shop: { id: "shop-1", name: "Demo shop" },
  listing: { id: "123", url: "https://www.etsy.com/listing/123/demo-product", title: "Demo product", summary: "A verified handmade product." },
  campaign: { id: "campaign-1", objective: "Validate creator-led demand", targetRegions: ["US"], allowedChannels: ["reddit"], utmCampaign: "etsy-demo" },
  claims: { approvedFacts: ["Handmade from linen."], doNotClaim: ["Do not claim medical benefits."], mustDisclose: ["I work with this shop."] },
  media: { images: ["https://i.etsystatic.com/example.jpg", "data:image/png;base64,blocked"], assetManifestRefs: ["asset://sellerpilot/demo"] },
  approval: { status: "approved", approvedBy: "operator@example.test", approvedAt: "2026-08-16T00:00:00.000Z", expiresAt: "2026-09-16T00:00:00.000Z" },
  evidence: { listingEvidenceRefs: ["artifact://listing/123"], adsRecommendation: advertising.channels.etsy_ads.recommendation },
  authority: { contractVersion: "marqel-campaign-authority.v1", sourceSystem: "marqel-control-center", canonical: true, operationId: "operation-1", campaignId: "campaign-1", approvalId: "approval-1", targetRef: "recommendation-1", expectedUpdatedAt: "2026-08-16T00:00:00.000Z", readbackRef: "marqel://campaign-approvals/approval-1" },
  now: new Date("2026-08-16T01:00:00.000Z"),
});
assert.equal(handoff.schema_version, "promotion-object-handoff.v1");
assert.equal(handoff.object.object_type, "product");
assert.deepEqual(handoff.media.images, ["https://i.etsystatic.com/example.jpg"]);
assert.equal(handoff.security_boundary.contains_credentials, false);
assert.equal(handoff.source.operation_id, "operation-1");
assert.equal(handoff.approval.authority.source_system, "marqel-control-center");
assert.throws(() => buildEtsyOutreachHandoff({
  tenantId: "tenant-demo", listing: { id: "1", url: "https://www.etsy.com/listing/1/a", title: "A" }, campaign: { id: "c", objective: "test" }, claims: { approvedFacts: ["fact"] }, approval: { status: "draft" }, now: new Date("2026-08-16T01:00:00.000Z"),
}), /canonical Control Center Campaign approval readback/);

const background = readFileSync(new URL("../background.js", import.meta.url), "utf8");
assert.doesNotMatch(background, /BUILD_ETSY_OUTREACH_HANDOFF/);
assert.doesNotMatch(background, /LIST_ETSY_OUTREACH_HANDOFFS/);
const dashboard = readFileSync(new URL("../dashboard.js", import.meta.url), "utf8");
assert.match(dashboard, /openCanonicalCampaignWorkflow/);
assert.match(dashboard, /Campaign Operator/);
console.log("etsy campaign adapter smoke passed");
