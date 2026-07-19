import assert from "node:assert/strict";
import fs from "node:fs";
import {
  classifyGoogleTrendsEvidence,
  collectGoogleTrendsAttempts,
  getTrendQueryGuardError,
  getTrendQueryRefinementState,
  hasUsableGoogleTrendsAttempt,
  normalizeTrendQuery,
} from "../modules/trendQueryPlanner.js";

const invalidResult = (query) => ({
  ok: false,
  evidenceOk: false,
  queryUsed: query,
  screenshotCaptured: true,
  screenshotRef: `artifact://trend/${encodeURIComponent(query)}`,
  trendsEvidenceState: {
    readiness: "loaded_but_not_enough_data",
    explicitNoData: true,
  },
  pageData: {
    title: "Google Trends",
    visibleText: "Google Trends Explore Hmm, your search doesn't have enough data to show here",
  },
});

const validResult = (query) => ({
  ok: true,
  evidenceOk: true,
  queryUsed: query,
  screenshotCaptured: true,
  trendsEvidenceState: { readiness: "core_modules_visible" },
  pageData: {
    title: "Google Trends",
    visibleText: "Interest over time Related queries Related topics",
  },
});

const entry = (query, result) => ({
  tool: "search_in_browser",
  arguments: { engine: "google_trends", query },
  result,
});

assert.equal(normalizeTrendQuery("  \"Personalized   Wedding Clutch\"  "), "personalized wedding clutch");
assert.deepEqual(classifyGoogleTrendsEvidence(invalidResult("personalized wedding clutch")), {
  insufficient: true,
  loaded: true,
  reason: "loaded_but_not_enough_data",
});

const firstHistory = [entry("personalized wedding clutch for bride", invalidResult("personalized wedding clutch for bride"))];
const firstRefinement = getTrendQueryRefinementState("skills/etsy_platform_trends.skill.md", firstHistory);
assert.equal(firstRefinement.required, true);
assert.equal(firstRefinement.nextAttempt, 2);
assert.match(firstRefinement.message, /退宽一个语义层级/);

const duplicateGuard = getTrendQueryGuardError({
  skillId: "skills/etsy_platform_trends.skill.md",
  toolName: "search_in_browser",
  toolArgs: { engine: "google_trends", query: "PERSONALIZED WEDDING CLUTCH FOR BRIDE" },
  toolHistory: firstHistory,
});
assert.ok(duplicateGuard);
assert.match(duplicateGuard.error, /已经查询过/);

const secondHistory = [
  ...firstHistory,
  entry("wedding clutch", invalidResult("wedding clutch")),
];
const secondRefinement = getTrendQueryRefinementState("skills/etsy_platform_trends.skill.md", secondHistory);
assert.equal(secondRefinement.required, true);
assert.equal(secondRefinement.nextAttempt, 3);
assert.match(secondRefinement.message, /同义词族/);

const exhaustedHistory = [
  ...secondHistory,
  entry("bridal purse", invalidResult("bridal purse")),
];
const exhausted = getTrendQueryRefinementState("skills/etsy_platform_trends.skill.md", exhaustedHistory);
assert.equal(exhausted.required, false);
assert.equal(exhausted.exhausted, true);
assert.equal(collectGoogleTrendsAttempts(exhaustedHistory).length, 3);

const recoveredHistory = [
  ...firstHistory,
  entry("bridal clutch bag", validResult("bridal clutch bag")),
];
assert.equal(hasUsableGoogleTrendsAttempt(recoveredHistory), true);
assert.deepEqual(getTrendQueryRefinementState("skills/etsy_platform_trends.skill.md", recoveredHistory).required, false);

const toolRegistrySource = fs.readFileSync(new URL("../modules/toolRegistry.js", import.meta.url), "utf8");
const agentLoopSource = fs.readFileSync(new URL("../modules/agentLoop.js", import.meta.url), "utf8");
const trendSkillSource = fs.readFileSync(new URL("../skills/etsy_platform_trends.skill.md", import.meta.url), "utf8");

assert.match(toolRegistrySource, /explicitNoData[\s\S]*loaded_but_not_enough_data/, "loaded Google Trends pages with explicit no-data warnings should be classified separately");
assert.match(agentLoopSource, /trend_query_refinement[\s\S]*Google Trends 查询恢复提示/, "agent loop should force query refinement before final validation");
assert.match(agentLoopSource, /trend_query_exhausted[\s\S]*Google Trends 查询已耗尽/, "agent loop should downgrade exhausted trend evidence before final validation");
assert.match(trendSkillSource, /query_funnel/, "trend skill should define query_funnel schema");
assert.match(trendSkillSource, /退宽一个语义层级/, "trend skill should instruct parent_proxy broadening");
assert.match(trendSkillSource, /第三次仍无数据/, "trend skill should define 3-attempt Google Trends exhaustion limit");

console.log("trend-query-planner-smoke: ok");
