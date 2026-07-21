/* SPDX-License-Identifier: MIT | Copyright (c) 2026 Yang Cao <cao.x.yang@gmail.com> */

import assert from "node:assert/strict";
import { getUpcomingSeasonalContext } from "../modules/seasonalCalendar.js";
import { buildResearchScope } from "../modules/researchScope.js";
import { __testInternals } from "../modules/agentLoop.js";

// Mock global chrome for imports
global.chrome = {
  storage: {
    local: {
      get: (keys, cb) => cb({}),
      set: (data, cb) => cb && cb()
    }
  }
};

// 1. Verify Seasonal Calendar
console.log("Testing seasonalCalendar...");
const julyContext = getUpcomingSeasonalContext(6); // July (0-indexed, Jan=0, Dec=11)
assert.equal(julyContext.seasonName, "Autumn & Back to School");
assert.ok(julyContext.seedKeywords.includes("fall home decor"));

const decContext = getUpcomingSeasonalContext(11); // Dec
assert.equal(decContext.seasonName, "Valentine's Day & Spring");

// 2. Verify buildResearchScope with Predictive Intent
console.log("Testing researchScope predictive logic...");
const scope1 = buildResearchScope({
  pageContext: { url: "https://www.etsy.com/", title: "Etsy Home" },
  userInstruction: "预测下半年的秋季大卖趋势",
  selectedSkillPath: "skills/etsy_platform_trends.skill.md",
  currentDate: new Date("2026-07-21T00:00:00Z")
});

assert.equal(scope1.is_predictive, true);
assert.equal(scope1.target_season, "Autumn & Back to School");
assert.ok(scope1.seed_keywords.length > 0);
assert.ok(scope1.seed_keywords.includes("fall home decor"));
assert.ok(scope1.discovery_sources.includes("pinterest_trends"));
assert.ok(scope1.discovery_sources.includes("google_news"));

// 3. Verify allowedTypes validation in agentLoop
console.log("Testing evidence validation for social media...");
const mockToolHistory = [
  {
    tool: "search_in_browser",
    arguments: { engine: "pinterest", query: "fall home decor" },
    result: { ok: true, pageData: { visibleText: "pins..." } }
  }
];
const hasPinterest = __testInternals.hasEvidenceSource(mockToolHistory, {}, "pinterest_social");
assert.equal(hasPinterest, true, "pinterest_social evidence must be verified by search_in_browser(engine='pinterest')");

console.log("predictive-trends-smoke: ok");
