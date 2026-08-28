export const LOCAL_BUSINESS_AUTHORITY_CONTRACT = "marqel-local-business-authority.v1";

const DOMAIN_RULES = Object.freeze([
  { pattern: /etsy_listing_generator|rewrite_listing/i, domain: "listing", canonicalOwners: ["etsy-listing-ops", "marqel-control-center"] },
  { pattern: /review_experiment_result|campaign|advertising|etsy_operations_tracker/i, domain: "campaign", canonicalOwners: ["etsy-campaign-operator", "marqel-control-center"] },
  { pattern: /etsy_global_shop_optimizer|diagnose_store_growth/i, domain: "store_positioning", canonicalOwners: ["cross-border-store-assortment-architect", "cross-border-positioning-analyst", "marqel-control-center"] },
  { pattern: /etsy_product_opportunity_explorer|etsy_platform_trends|etsy_event_driven_trend_radar|find_expansion_opportunities/i, domain: "positioning", canonicalOwners: ["cross-border-positioning-analyst", "marqel-control-center"] },
  { pattern: /sourcing|supplier/i, domain: "sourcing", canonicalOwners: ["cross-border-sourcing-orchestrator", "supply-discover-core", "marqel-control-center"] },
]);

function normalizedOperationId(value = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.length > 180 || !/^[a-z0-9][a-z0-9._:-]*$/i.test(text)) throw new Error("Control Center operation_id is invalid.");
  return text;
}

export function classifyLocalBusinessDomain({ skillId = "", growthActionId = "" } = {}) {
  const source = `${skillId} ${growthActionId}`;
  const rule = DOMAIN_RULES.find((candidate) => candidate.pattern.test(source));
  return rule || { domain: "browser_evidence", canonicalOwners: ["marqel-control-center"] };
}

export function buildLocalBusinessAuthority({ skillId = "", growthActionId = "", operationId = "" } = {}) {
  const binding = normalizedOperationId(operationId);
  const { domain, canonicalOwners } = classifyLocalBusinessDomain({ skillId, growthActionId });
  return {
    contractVersion: LOCAL_BUSINESS_AUTHORITY_CONTRACT,
    sourceComponent: "etsy-growth-agent",
    domain,
    role: "browser_evidence_and_non_canonical_preview",
    canonical: false,
    classification: binding ? "bound_evidence" : "unbound_non_canonical",
    operationId: binding,
    canonicalOwners: [...canonicalOwners],
    promotionRule: "Only the canonical owner may persist or approve the formal business object.",
    prohibitedTerminalClaims: ["approved", "canonical", "published", "campaign_executed", "budget_changed"],
  };
}

export function attachLocalBusinessAuthority(result, authority) {
  if (!authority || authority.contractVersion !== LOCAL_BUSINESS_AUTHORITY_CONTRACT || authority.canonical !== false) {
    throw new Error("A valid non-canonical Etsy Growth Agent authority envelope is required.");
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  return { ...result, _marqelAuthority: globalThis.structuredClone(authority) };
}

export function authorityForSavedResult(entry = {}) {
  const authority = entry.authority || entry.result?._marqelAuthority || null;
  if (!authority || authority.contractVersion !== LOCAL_BUSINESS_AUTHORITY_CONTRACT || authority.canonical !== false) {
    return buildLocalBusinessAuthority({ skillId: entry.skillId || "", growthActionId: entry.growthActionId || "" });
  }
  return authority;
}
