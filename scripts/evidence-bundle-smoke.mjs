import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildEvidenceBundle,
  collectPageEvidenceFromToolHistory,
  collectScreenshotRefsFromToolHistory,
} from "../modules/evidenceBundle.js";
import { summarizeEvidenceQuality } from "../modules/evidenceQuality.js";

const toolHistory = [
  {
    tool: "search_in_browser",
    arguments: { engine: "etsy", query: "personalized wedding clutch" },
    result: {
      ok: true,
      evidenceOk: true,
      screenshotRef: "artifact://etsy/search-1",
      pageData: {
        url: "https://www.etsy.com/search?q=personalized%20wedding%20clutch",
        title: "Etsy search",
        visibleText: "A".repeat(1500),
        productCards: [
          { title: "Personalized wedding clutch", price: "$42", href: "https://www.etsy.com/listing/1", imageSrc: "https://img/1.jpg" },
        ],
        pageEvidence: { visibleTextLength: 1500, productCardCount: 1 },
      },
    },
  },
  {
    tool: "collect_etsy_shop_pages",
    arguments: { url: "https://www.etsy.com/shop/ExampleShop" },
    result: {
      ok: true,
      screenshotRefs: ["artifact://etsy/shop-summary"],
      pages: [
        {
          ok: true,
          url: "https://www.etsy.com/shop/ExampleShop",
          title: "ExampleShop",
          screenshotRef: "artifact://etsy/shop-page-1",
          productCardsVisible: 24,
          visibleTextSnippet: "shop page",
          productCards: [{ title: "Beaded clutch", price: "$55", href: "https://www.etsy.com/listing/2" }],
        },
      ],
    },
  },
];

const screenshotRefs = collectScreenshotRefsFromToolHistory(toolHistory);
assert.deepEqual(
  screenshotRefs.sort(),
  ["artifact://etsy/search-1", "artifact://etsy/shop-page-1", "artifact://etsy/shop-summary"].sort(),
  "evidence bundle should recursively collect Etsy screenshot artifact refs",
);

const pageEvidence = collectPageEvidenceFromToolHistory(toolHistory, {
  url: "https://www.etsy.com/shop/SourceShop",
  title: "SourceShop - Etsy",
  productCards: [{ title: "Source card" }],
});
assert.ok(pageEvidence.some((item) => item.tool === "initial_page_context"), "initial page context should be included");
assert.ok(pageEvidence.some((item) => item.tool === "search_in_browser" && item.pageData.productCardCount === 1), "search pageData should be compacted");
assert.ok(pageEvidence.some((item) => item.tool === "collect_etsy_shop_pages" && item.url.includes("/shop/ExampleShop")), "crawled pages should be included");

const output = {
  report_status: "completed",
  case_title: "Etsy 店铺体检",
  blocking_gaps: [],
  follow_up_tasks: [{ task_id: "TASK-1" }],
  data: [{
    title: "趋势机会",
    evidence_ledger: [
      { source_type: "etsy_search", source_ref: "Etsy search", observed_value: "可见商品卡片", used_for: "价格带", confidence: "medium" },
      { source_type: "screenshot_visual", source_ref: "artifact://etsy/search-1", observed_value: "截图可见搜索结果", used_for: "视觉校验", confidence: "medium" },
    ],
  }],
};
const evidenceQuality = summarizeEvidenceQuality({
  output,
  pageContext: { url: "https://www.etsy.com/shop/SourceShop" },
  researchScope: { active_shop_id: "SourceShop", scope_confidence: "high" },
});
assert.equal(evidenceQuality.grade, "B");
assert.equal(evidenceQuality.has_search_evidence, true);
assert.match(evidenceQuality.personal_api_boundary, /authorized seller account/);

const bundle = buildEvidenceBundle({
  savedEntry: {
    id: 123,
    skillId: "skills/etsy_global_shop_optimizer.skill.md",
    skillName: "Etsy 店铺体检",
    pageUrl: "https://www.etsy.com/shop/SourceShop",
    pageTitle: "SourceShop - Etsy",
  },
  output,
  pageContext: { url: "https://www.etsy.com/shop/SourceShop", title: "SourceShop - Etsy" },
  researchScope: { active_shop_id: "SourceShop", scope_confidence: "high" },
  evidenceQuality,
  toolHistory,
  workflowId: "workflow:source",
});

assert.equal(bundle.schema_version, "1.0");
assert.equal(bundle.workflowId, "workflow:source");
assert.equal(bundle.reportId, 123);
assert.equal(bundle.evidence_quality.grade, "B");
assert.equal(bundle.reportSummary.followUpTaskCount, 1);
assert.ok(bundle.screenshotRefs.includes("artifact://etsy/shop-page-1"));
assert.ok(bundle.toolTimeline.some((entry) => entry.tool === "collect_etsy_shop_pages" && entry.result.pages.length === 1));
assert.ok(JSON.stringify(bundle).length < 30000, "bundle should stay compact enough for chrome.storage.local report records");

const background = readFileSync(new URL("../background.js", import.meta.url), "utf8");
const dashboard = readFileSync(new URL("../dashboard.js", import.meta.url), "utf8");
const agentLoop = readFileSync(new URL("../modules/agentLoop.js", import.meta.url), "utf8");
assert.match(background, /buildEvidenceBundle/, "successful runs should persist evidence_bundle");
assert.match(background, /evidence_bundle/, "savedResults entries should include evidence_bundle");
assert.match(background, /EXPORT_EVIDENCE_BUNDLE/, "background should expose evidence bundle export endpoint");
assert.match(background, /getArtifactDataUrl/, "evidence bundle export should check artifact availability");
assert.match(background, /artifact_manifest/, "exported evidence bundle should include artifact availability manifest");
assert.match(dashboard, /report-evidence-btn|downloadEvidenceBundle/, "report center should expose evidence bundle downloads");
assert.match(agentLoop, /toolHistory,\n\s*};/, "agent loop success returns should expose toolHistory to background save path");

console.log("Evidence bundle smoke passed.");
