import assert from "node:assert/strict";
import { buildResearchScope, shouldClarifyResearchScope } from "../modules/researchScope.js";

const shops = [{ id: "active-shop", name: "MidnightReveriee", shopId: "MidnightReveriee" }];
const activeShopId = "active-shop";

const cases = [
  {
    name: "own shop trend entry",
    pageContext: { url: "https://www.etsy.com/shop/MidnightReveriee", title: "MidnightReveriee - Etsy", h1: "MidnightReveriee" },
    instruction: "分析当前店铺趋势",
    action: "explore_platform_trends",
    expectedType: "own_shop",
    expectedRole: "self_reference",
    clarify: false,
    autoDiscovery: false,
  },
  {
    name: "own listing keyword entry",
    pageContext: { url: "https://www.etsy.com/listing/123/personalized-clutch?ref=shop", title: "Personalized Clutch - Etsy", h1: "Personalized Wedding Clutch", shopName: "MidnightReveriee" },
    instruction: "分析这个商品关键词",
    action: "analyze_keywords",
    expectedType: "own_listing",
    expectedRole: "self_reference",
    clarify: false,
    autoDiscovery: false,
  },
  {
    name: "etsy home weak trend entry",
    pageContext: { url: "https://www.etsy.com/", title: "Etsy" },
    instruction: "分析平台趋势",
    action: "explore_platform_trends",
    expectedType: "etsy_home",
    expectedRole: "platform_discovery",
    clarify: false,
    autoDiscovery: true,
  },
  {
    name: "etsy home with user keyword",
    pageContext: { url: "https://www.etsy.com/", title: "Etsy" },
    instruction: "分析 wedding clutch 趋势",
    action: "explore_platform_trends",
    expectedType: "etsy_home",
    expectedRole: "user_keyword_only",
    clarify: false,
    autoDiscovery: false,
  },
  {
    name: "etsy search page",
    pageContext: { url: "https://www.etsy.com/search?q=bridesmaid%20gift", title: "Bridesmaid gift - Etsy" },
    instruction: "分析这个搜索词机会",
    action: "explore_platform_trends",
    expectedType: "etsy_search",
    expectedRole: "platform_discovery",
    expectedKeyword: "bridesmaid gift",
    clarify: false,
    autoDiscovery: false,
  },
  {
    name: "competitor shop page",
    pageContext: { url: "https://www.etsy.com/shop/TopWeddingStudio", title: "TopWeddingStudio - Etsy", h1: "TopWeddingStudio" },
    instruction: "学习这个竞品店铺",
    action: "scan_competitor_changes",
    expectedType: "competitor_shop",
    expectedRole: "competitor_reference",
    clarify: false,
    autoDiscovery: false,
  },
  {
    name: "competitor listing page",
    pageContext: { url: "https://www.etsy.com/listing/999/beaded-evening-bag", title: "Beaded Evening Bag - Etsy", h1: "Beaded Evening Bag", shopName: "OtherShop" },
    instruction: "分析这个竞品商品",
    action: "analyze_keywords",
    expectedType: "competitor_listing",
    expectedRole: "competitor_reference",
    clarify: false,
    autoDiscovery: false,
  },
  {
    name: "external page without keyword",
    pageContext: { url: "https://example.com/article", title: "Market Article" },
    instruction: "分析 Etsy 趋势",
    action: "explore_platform_trends",
    expectedType: "external_page",
    expectedRole: "platform_discovery",
    clarify: false,
    autoDiscovery: true,
  },
];

const results = cases.map((item) => {
  const scope = buildResearchScope({
    pageContext: item.pageContext,
    userInstruction: item.instruction,
    activeShopId,
    shops,
    growthActionId: item.action,
  });
  assert.equal(scope.entry_page_type, item.expectedType, `${item.name}: entry_page_type`);
  assert.equal(scope.source_page_role, item.expectedRole, `${item.name}: source_page_role`);
  assert.equal(shouldClarifyResearchScope(scope), item.clarify, `${item.name}: clarify flag`);
  assert.equal(Boolean(scope.auto_discovery_required), item.autoDiscovery, `${item.name}: auto_discovery_required`);
  if (item.expectedKeyword) {
    assert.equal(scope.target_entity.name, item.expectedKeyword, `${item.name}: extracted keyword`);
  }
  return {
    case: item.name,
    entry_page_type: scope.entry_page_type,
    source_page_role: scope.source_page_role,
    target: scope.target_entity.name,
    clarify: shouldClarifyResearchScope(scope),
    autoDiscovery: Boolean(scope.auto_discovery_required),
  };
});

console.log(JSON.stringify({ ok: true, cases: results.length, results }, null, 2));
