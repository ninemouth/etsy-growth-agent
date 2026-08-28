import assert from "node:assert/strict";
import fs from "node:fs";
import {
  attachLocalBusinessAuthority,
  authorityForSavedResult,
  buildLocalBusinessAuthority,
  classifyLocalBusinessDomain,
} from "../modules/businessAuthority.js";

assert.equal(classifyLocalBusinessDomain({ skillId: "skills/etsy_listing_generator.skill.md" }).domain, "listing");
assert.equal(classifyLocalBusinessDomain({ growthActionId: "review_experiment_result" }).domain, "campaign");
assert.equal(classifyLocalBusinessDomain({ skillId: "etsy_global_shop_optimizer" }).domain, "store_positioning");

const unbound = buildLocalBusinessAuthority({ skillId: "etsy_listing_generator" });
assert.equal(unbound.classification, "unbound_non_canonical");
assert.equal(unbound.canonical, false);
assert.deepEqual(unbound.canonicalOwners, ["etsy-listing-ops", "marqel-control-center"]);

const bound = buildLocalBusinessAuthority({ skillId: "etsy_product_opportunity_explorer", operationId: "operation-123" });
assert.equal(bound.classification, "bound_evidence");
assert.equal(bound.operationId, "operation-123");
assert.equal(bound.canonical, false);
assert.throws(() => buildLocalBusinessAuthority({ operationId: "not allowed/operation" }), /operation_id is invalid/);

const decorated = attachLocalBusinessAuthority({ overview: "Local preview" }, bound);
assert.equal(decorated._marqelAuthority.classification, "bound_evidence");
assert.equal(authorityForSavedResult({ result: decorated }).canonical, false);
assert.equal(authorityForSavedResult({ skillId: "etsy_listing_generator" }).classification, "unbound_non_canonical");

const background = fs.readFileSync(new URL("../background.js", import.meta.url), "utf8");
const dashboard = fs.readFileSync(new URL("../dashboard.js", import.meta.url), "utf8");
assert.match(background, /buildLocalBusinessAuthority/);
assert.match(background, /attachLocalBusinessAuthority/);
assert.doesNotMatch(dashboard, /growthCaseId\s*\|\|\s*parentReport\?\.raw\?\.growthCaseId/);
assert.match(dashboard, /bound_evidence/);

console.log("business-authority-smoke: ok");
