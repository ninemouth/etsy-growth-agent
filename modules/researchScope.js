// Shared research-scope detection for Etsy growth workflows.
// This is intentionally deterministic: page role must be known before an LLM
// decides which evidence path or business framing to use.

const BROAD_KEYWORDS = new Set([
  "etsy",
  "gift",
  "gifts",
  "handmade",
  "jewelry",
  "wedding",
  "decor",
  "home",
  "bag",
  "bags",
  "clothing",
  "accessories",
]);

function normalizeText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeUrl(value = "") {
  try {
    return new URL(String(value || "")).toString();
  } catch (_) {
    return String(value || "");
  }
}

function parseUrl(value = "") {
  try {
    return new URL(String(value || ""));
  } catch (_) {
    return null;
  }
}

function compactKeyword(value = "") {
  return normalizeText(value)
    .replace(/[|•·–—]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^etsy\s+/i, "")
    .trim();
}

function unique(values = []) {
  const seen = new Set();
  return values
    .map((value) => compactKeyword(value))
    .filter(Boolean)
    .filter((value) => {
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function extractSearchQuery(parsedUrl, pageContext = {}) {
  if (!parsedUrl) return "";
  const candidates = [
    parsedUrl.searchParams.get("q"),
    parsedUrl.searchParams.get("search_query"),
    parsedUrl.searchParams.get("query"),
    pageContext.searchQuery,
    pageContext.query,
  ];
  return compactKeyword(candidates.find(Boolean) || "");
}

function extractShopSlugFromUrl(url = "") {
  const parsed = parseUrl(url);
  const match = parsed?.pathname?.match(/\/shop\/([^/?#]+)/i);
  return match ? decodeURIComponent(match[1]) : "";
}

function extractListingIdFromUrl(url = "") {
  const parsed = parseUrl(url);
  const match = parsed?.pathname?.match(/\/listing\/(\d+)/i);
  return match ? match[1] : "";
}

function normalizeShopIdentity(shop = {}) {
  return unique([
    shop.name,
    shop.shopName,
    shop.shop_name,
    shop.shopId,
    shop.shop_id,
    shop.clientId,
    shop.id,
  ]).map((value) => value.toLowerCase());
}

function isOwnShopByStorage({ url = "", title = "", pageContext = {}, activeShopId = "", shops = [] } = {}) {
  const slug = extractShopSlugFromUrl(url).toLowerCase();
  const haystack = unique([
    slug,
    title,
    pageContext.shopName,
    pageContext.h1,
    pageContext.etsyShopProductContext?.shopName,
    pageContext.etsyShopProductContext?.shopId,
    pageContext.shopId,
  ]).map((value) => value.toLowerCase());
  const candidates = (Array.isArray(shops) ? shops : []).filter(Boolean);
  const activeShop = candidates.find((shop) => String(shop.id || shop.shopId || shop.clientId || "") === String(activeShopId || ""));
  const relevantShops = activeShop ? [activeShop, ...candidates.filter((shop) => shop !== activeShop)] : candidates;
  return relevantShops.some((shop) => {
    const ids = normalizeShopIdentity(shop);
    return ids.some((id) => id && haystack.some((value) => value === id || value.includes(id) || id.includes(value)));
  });
}

function extractInstructionKeywords(userInstruction = "") {
  const text = normalizeText(userInstruction);
  if (!text) return [];
  const quoted = Array.from(text.matchAll(/["“']([^"”']{2,80})["”']/g)).map((match) => match[1]);
  const afterMarkers = Array.from(text.matchAll(/(?:关键词|类目|品类|产品|商品|keyword|category|niche|for|about|around)[:： ]+([^。；;\n]{2,80})/gi))
    .map((match) => match[1]);
  const englishPhrases = Array.from(text.matchAll(/\b([a-z][a-z0-9]+(?:\s+[a-z][a-z0-9]+){1,5})\b/gi))
    .map((match) => match[1])
    .filter((phrase) => !/please|analyze|trend|etsy|shop|store|growth|report|current|page|based on/i.test(phrase));
  return unique([...quoted, ...afterMarkers, ...englishPhrases]).slice(0, 6);
}

function inferSeedKeywords(pageContext = {}, userInstruction = "", parsedUrl = null) {
  const searchQuery = extractSearchQuery(parsedUrl, pageContext);
  const instructionKeywords = extractInstructionKeywords(userInstruction);
  const cardKeywords = Array.isArray(pageContext.productCards)
    ? pageContext.productCards
      .slice(0, 6)
      .map((card) => card.title || card.text || card.name)
      .filter(Boolean)
    : [];
  const titleParts = normalizeText(pageContext.h1 || pageContext.title || "")
    .split(/[-|,]/)
    .map((part) => compactKeyword(part))
    .filter((part) => part && part.length <= 80);
  return unique([searchQuery, ...instructionKeywords, ...titleParts, ...cardKeywords]).slice(0, 8);
}

function hasSpecificKeyword(seedKeywords = []) {
  return seedKeywords.some((keyword) => {
    const value = keyword.toLowerCase();
    if (BROAD_KEYWORDS.has(value)) return false;
    if (value.split(/\s+/).length >= 2) return true;
    return value.length >= 12 && !BROAD_KEYWORDS.has(value);
  });
}

function inferMarketLocale(pageContext = {}, userInstruction = "") {
  const text = `${pageContext.url || ""} ${pageContext.visibleText || ""} ${userInstruction || ""}`;
  if (/\bUS\b|United States|美国|美元|\$/i.test(text)) return "US";
  if (/\bUK\b|United Kingdom|英国|£/i.test(text)) return "UK";
  if (/\bEU\b|European Union|欧盟|€|Germany|France|Spain|Italy/i.test(text)) return "EU";
  return "unknown";
}

export function buildResearchScope({
  pageContext = {},
  userInstruction = "",
  activeShopId = "",
  shops = [],
  selectedSkillPath = "",
  growthActionId = "",
} = {}) {
  const url = normalizeUrl(pageContext.url || pageContext.currentPageUrl || "");
  const parsedUrl = parseUrl(url);
  const host = parsedUrl?.hostname?.toLowerCase() || "";
  const path = parsedUrl?.pathname || "";
  const title = normalizeText(pageContext.title || "");
  const seedKeywords = inferSeedKeywords(pageContext, userInstruction, parsedUrl);
  const explicitInstructionKeywords = extractInstructionKeywords(userInstruction);
  const listingId = extractListingIdFromUrl(url);
  const shopSlug = extractShopSlugFromUrl(url);
  const isEtsy = /(^|\.)etsy\.com$/i.test(host);
  const isShop = isEtsy && /\/shop\//i.test(path);
  const isListing = isEtsy && /\/listing\//i.test(path);
  const isSearch = isEtsy && (/\/search/i.test(path) || /\/market/i.test(path));
  const isHome = isEtsy && (path === "/" || path === "");
  const ownShop = isOwnShopByStorage({ url, title, pageContext, activeShopId, shops });
  const wantsOwnShop = /我的|自营|本店|当前店铺|our shop|my shop|own shop|自己店铺/i.test(userInstruction);
  const wantsCompetitor = /竞品|对手|benchmark|competitor|top shop|头部店铺|高排名/i.test(userInstruction);
  const wantsTrend = /趋势|trend|season|需求|market|平台|机会|opportunit/i.test(userInstruction) || growthActionId === "explore_platform_trends" || /etsy_platform_trends/.test(selectedSkillPath);

  let entryPageType = "unknown";
  let sourcePageRole = "unknown";
  let targetType = "unknown";
  let targetName = seedKeywords[0] || "";
  let targetUrl = url;
  let isSelf = false;
  let confidence = "low";
  const missingInputs = [];

  if (isShop) {
    entryPageType = ownShop ? "own_shop" : "competitor_shop";
    sourcePageRole = ownShop ? "self_reference" : "competitor_reference";
    targetType = "shop";
    targetName = pageContext.shopName || pageContext.h1 || shopSlug || title;
    isSelf = ownShop;
    confidence = ownShop || shopSlug ? "high" : "medium";
  } else if (isListing) {
    entryPageType = ownShop ? "own_listing" : "competitor_listing";
    sourcePageRole = ownShop ? "self_reference" : wantsOwnShop ? "mixed" : "competitor_reference";
    targetType = "listing";
    targetName = pageContext.h1 || title || listingId;
    isSelf = ownShop;
    confidence = listingId ? "high" : "medium";
  } else if (isSearch) {
    entryPageType = "etsy_search";
    sourcePageRole = "platform_discovery";
    targetType = "keyword";
    targetName = extractSearchQuery(parsedUrl, pageContext) || seedKeywords[0] || "";
    confidence = targetName ? "high" : "medium";
    if (!targetName) missingInputs.push("search_keyword");
  } else if (isHome) {
    entryPageType = "etsy_home";
    sourcePageRole = hasSpecificKeyword(seedKeywords) ? "user_keyword_only" : "platform_discovery";
    targetType = hasSpecificKeyword(seedKeywords) ? "keyword" : "unknown";
    targetName = hasSpecificKeyword(seedKeywords) ? seedKeywords[0] : "";
    confidence = targetName ? "medium" : "low";
    if (!targetName) missingInputs.push("keyword_or_category");
  } else if (url) {
    entryPageType = "external_page";
    sourcePageRole = hasSpecificKeyword(explicitInstructionKeywords) ? "user_keyword_only" : "unknown";
    targetType = hasSpecificKeyword(explicitInstructionKeywords) ? "keyword" : "unknown";
    targetName = hasSpecificKeyword(explicitInstructionKeywords) ? explicitInstructionKeywords[0] : "";
    confidence = targetName ? "medium" : "low";
    if (!targetName) missingInputs.push("etsy_keyword_or_category");
  } else {
    if (hasSpecificKeyword(seedKeywords)) {
      entryPageType = "unknown";
      sourcePageRole = "user_keyword_only";
      targetType = "keyword";
      targetName = seedKeywords[0];
      confidence = "medium";
    } else {
      missingInputs.push("page_or_keyword");
    }
  }

  if (wantsOwnShop && ["competitor_shop", "competitor_listing"].includes(entryPageType)) {
    sourcePageRole = "mixed";
    missingInputs.push("own_shop_context");
  }
  if (wantsCompetitor && ["own_shop", "own_listing"].includes(entryPageType)) {
    sourcePageRole = "mixed";
  }

  const weakEntry = ["etsy_home", "external_page", "unknown"].includes(entryPageType);
  const weakContextKeywords = entryPageType === "external_page" ? explicitInstructionKeywords : seedKeywords;
  const needsUserClarification = Boolean(
    wantsTrend &&
    weakEntry &&
    !hasSpecificKeyword(weakContextKeywords)
  );
  const recommendedNextAction = needsUserClarification
    ? activeShopId
      ? "select_keyword_or_use_bound_shop"
      : "select_keyword"
    : "run";

  return {
    entry_page_type: entryPageType,
    source_page_role: sourcePageRole,
    target_entity: {
      type: targetType,
      name: targetName,
      url: targetUrl,
      is_self: isSelf,
      confidence,
    },
    seed_keywords: seedKeywords,
    seed_category: pageContext.category || pageContext.etsyCategory || "",
    seed_product_type: pageContext.productType || pageContext.h1 || "",
    market_locale: inferMarketLocale(pageContext, userInstruction),
    scope_confidence: confidence,
    missing_inputs: Array.from(new Set(missingInputs)),
    needs_user_clarification: needsUserClarification,
    recommended_next_action: recommendedNextAction,
    selected_skill_path: selectedSkillPath || "",
    growth_action_id: growthActionId || "",
    page_role_notice: buildPageRoleNotice(entryPageType, sourcePageRole, targetName),
  };
}

export function buildPageRoleNotice(entryPageType = "unknown", sourcePageRole = "unknown", targetName = "") {
  const name = targetName ? `（${targetName}）` : "";
  if (entryPageType === "own_shop") return `当前页面识别为自营 Etsy 店铺${name}，报告应服务于当前店铺增长。`;
  if (entryPageType === "own_listing") return `当前页面识别为自营 Etsy 商品${name}，报告应服务于该商品或相邻 listing 的增长。`;
  if (entryPageType === "competitor_shop") return `当前页面识别为竞品 Etsy 店铺${name}，只能作为公开对标样本，不能写成自营店铺事实。`;
  if (entryPageType === "competitor_listing") return `当前页面识别为竞品 Etsy 商品${name}，只能作为公开对标样本，不能直接复制或写成自营商品事实。`;
  if (entryPageType === "etsy_search") return `当前页面识别为 Etsy 搜索/market 页面${name}，搜索网格只能作为本轮可见样本。`;
  if (entryPageType === "etsy_home") return "当前页面识别为 Etsy 首页，页面上下文较弱；没有明确关键词或类目时不应直接生成深度趋势结论。";
  if (entryPageType === "external_page") return "当前页面不是 Etsy 业务页面，只能作为弱上下文；需要明确 Etsy 关键词、类目或绑定店铺。";
  return `当前页面角色不明确（${sourcePageRole}），需要补充研究对象或关键词后再进入深度分析。`;
}

export function shouldClarifyResearchScope(scope = {}) {
  return Boolean(scope?.needs_user_clarification);
}

export function buildResearchScopeClarification(scope = {}) {
  const keywords = Array.isArray(scope.seed_keywords) && scope.seed_keywords.length
    ? `已识别线索：${scope.seed_keywords.slice(0, 4).join("、")}。`
    : "当前页面没有足够明确的 Etsy 关键词或类目。";
  return {
    ok: false,
    type: "clarification_required",
    result: `需要先明确趋势研究范围。${keywords} 请选择“基于当前绑定店铺主营类目”或直接输入一个关键词/类目后再启动趋势分析。`,
    research_scope: scope,
    options: [
      "基于当前绑定店铺主营类目",
      "输入关键词/类目",
      "基于当前页面可见内容生成候选方向",
    ],
  };
}

export const __testInternals = {
  extractInstructionKeywords,
  extractSearchQuery,
  extractShopSlugFromUrl,
  hasSpecificKeyword,
  isOwnShopByStorage,
};
