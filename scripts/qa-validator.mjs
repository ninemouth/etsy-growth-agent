// scripts/qa-validator.mjs — Automated Quality Assurance Validator for Etsy Assistant

import fs from 'fs';
import path from 'path';

console.log("🔍 Running Etsy AI Assistant QA Validation Suite...");

// Mock outputs to test the validator itself
const mockValidReport = {
  type: "final",
  output: {
    overview: "本报告评估了 Etsy 平台上的个性化婚礼手拿包，目标销售市场为 Etsy 主要欧美礼品与婚礼配饰市场。",
    analysis: "消费者反馈良好，前台售价为 49 $ 美元。拿样时需注意材质、色差、包装、个性化拼写确认和 IP/商标表达风险。物流成本按 Etsy 自发货小包重量 0.4kg 计费。",
    summary: "本款婚礼手拿包具备小批量测试价值，建议启动图片匹配寻源并向供应商确认材质、尺寸、包装和定制工艺。",
    data: [
      {
        title: "Personalized Satin Wedding Clutch",
        product_link: "https://detail.1688.com/offer/65489012.html",
        target_profile: {
          visual_descriptors: "缎面云朵包造型，金属链条，可刺绣名字",
          refined_query: "个性化婚礼手拿包 缎面 晚宴包",
          routing_decision: "非标品(图片检索)"
        },
        spec_audit: {
          target_spec: "缎面材质，金属链条，可定制名字，婚礼包装",
          sourced_spec: "缎面材质，金属链条，支持刺绣定制，普通包装",
          status: "完全一致"
        },
        financial_ledger: {
          sourcing_cost: "25",
          shipping_cost: "350",
          target_price: "1290",
          margin_rate: "32"
        },
        trend_evidence: "在 Etsy 上月销量超过 1500 件，欧美买家对清洁模式非常满意。"
      }
    ]
  }
};

const mockInvalidReport = {
  type: "final",
  output: {
    overview: "测试报告（缺少市场和货币信息）",
    analysis: "使用 DOM 抓取工具提取到了 $25 的价格，决定使用 1688 关键词查找货源。",
    summary: "可以做，没有写 CE/CPC/FDA/IP 认证说明。",
    data: [
      {
        title: "电动牙刷",
        product_link: "https://s.1688.com/search?q=electric_toothbrush", // Search lists links not allowed!
        target_profile: {}, // Empty target profile
        spec_audit: {
          status: "材质缩水" // Rejected status should block!
        },
        financial_ledger: {
          sourcing_cost: "25",
          shipping_cost: "350",
          target_price: "25", // Rubles vs USD mismatch or low margin
          margin_rate: "0"
        },
        trend_evidence: "太短"
      }
    ]
  }
};

const mockValidShopOptimizerReport = {
  type: "final",
  output: {
    overview: "## Etsy 店铺诊断\n目标市场为Etsy 主要欧美礼品市场，本轮判定为 B 级系统化整改。",
    analysis: "以 Etsy 页面文本、店铺截图、Seller API 流量、Etsy 站内高排名竞品店铺、Google Search US 与 Google Trends US 真实搜索证据为基础，输出 ABC 分级优化候选方案，所有金额均以 $ / USD 表示。配送时效需要按目的地和承运商做实时搜索确认。",
    summary: "第一优先级执行 B-1 主图英文卖点改版；如需更新配送文案，必须先完成国际物流实时研究和承运商确认。",
    data: [
      {
        plan_id: "B-1",
        title: "主图与画廊英文卖点改版",
        diagnosis_level: "B",
        direction: "补齐首图英文卖点、尺寸对比和包装承诺，提高点击后的信任转化。",
        evidence: "当前页面截图显示首图信息密度不足，Etsy API 加购率低于预期，趋势来源已标记为待验证。",
        evidence_ledger: [
          {
            source_type: "page_dom",
            source_ref: "当前 Etsy 商品页",
            observed_value: "标题和详情存在英文卖点表达不足",
            used_for: "判断 B 级视觉与 SEO 整改",
            confidence: "medium",
            limitation: "仅基于当前页面上下文"
          },
          {
            source_type: "screenshot_visual",
            source_ref: "当前店铺首屏截图",
            observed_value: "首图缺少英文卖点层级，视觉调性与礼品场景不够统一",
            used_for: "判断 B 级视觉整改",
            confidence: "medium",
            limitation: "截图只能判断视觉格调，不能替代页面文本和竞品搜索"
          },
          {
            source_type: "etsy_search",
            source_ref: "Etsy search: personalized gift top shops",
            observed_value: "同类高排名店铺普遍使用统一礼品场景主图、清晰标题词和评价背书",
            used_for: "支撑竞品店铺反向学习和主图改版方向",
            confidence: "medium",
            limitation: "仅覆盖搜索结果第一页和 2-3 个头部样本"
          },
          {
            source_type: "google_search",
            source_ref: "Google Search US: Etsy international shipping delivery time US handmade gifts",
            observed_value: "国际配送承诺随发货地、目的地、承运商和清关变化，不能用固定 7-12 工作日承诺",
            used_for: "约束配送文案必须先做目的地/承运商确认",
            confidence: "medium",
            limitation: "需要结合店铺实际发货地和 Etsy shipping profile 二次确认"
          },
          {
            source_type: "google_trends",
            source_ref: "Google Trends US: personalized gift",
            observed_value: "站外需求方向已通过 Google Trends US 页面验证",
            used_for: "支撑站外需求与季节性窗口判断",
            confidence: "medium",
            limitation: "趋势图需人工复核具体数值，不输出 YoY/QoQ"
          }
        ],
        expected_impact: "提升点击后的加购率和详情页停留信任。",
        first_actions: ["重做首图", "补充英文规格图", "7 天后对账 API 加购率"],
        stage_fit: "该方案适合低评价成长店先补齐信任资产，再观察加购率变化。",
        buyer_scenario: "欧美婚礼礼品买家与伴娘礼品场景",
        risk_guard: "不得伪造趋势和订单数据。"
      }
    ]
  }
};

const mockInvalidShopOptimizerReport = {
  type: "final",
  output: {
    overview: "## Etsy 店铺诊断\n目标市场为Etsy 主要欧美礼品市场。",
    analysis: "建议直接推荐对齐货源，并输出采购直达链接。",
    summary: "货源 #1 可以立刻采购。",
    data: [
      {
        title: "1688 对齐货源",
        product_link: "https://detail.1688.com/offer/123.html",
        evidence: "看起来相似"
      }
    ]
  }
};

function runValidation(report, userInstruction, isEtsySpecific = true) {
  const errors = [];
  const out = report.output;

  if (!out || !out.overview || !out.analysis || !out.summary || !Array.isArray(out.data)) {
    return ["报告结构不完整，必须包含 overview, analysis, summary 和 data 数组！"];
  }

  const overviewText = out.overview || "";
  const analysisText = out.analysis || "";
  const combinedText = overviewText + analysisText + (out.summary || "");

  // 1. Technical Jargon Check
  const jargonRegex = /read_current_page|open_new_tab|click_by_text|DOM|xpath|自愈程序|爬虫/i;
  if (jargonRegex.test(combinedText)) {
    errors.push("报告正文中包含内部技术黑话或函数名（如 DOM, xpath, click 等），应当过滤翻译为通俗的商业术语！");
  }

  // 2. Etsy Specific checks
  if (isEtsySpecific) {
    // Target Market Check
    if (!combinedText.includes("欧美") && !combinedText.includes("欧美礼品市场")) {
      errors.push("未在全局概述或分析中明确判定目标销售目的地市场为“Etsy 主要欧美礼品市场”！");
    }

    // Ruble Currency Sign Check
    const hasRubSign = combinedText.includes("$") || combinedText.includes("USD") || combinedText.includes("美元");
    if (!hasRubSign) {
      errors.push("评估报告正文中未检测到美元 (USD/$) 计价单位！");
    }
  }

  // 3. Data array items check
  out.data.forEach((item, idx) => {
    const title = item.title || `商品 #${idx + 1}`;
    
    // Sourcing details check
    const link = item.product_link || item.link || "";
    if (!link) {
      errors.push(`第 ${idx + 1} 项商品 (${title}) 没有提供采购直达链接！`);
    } else if (link.includes("s.1688.com") || link.includes("search?")) {
      errors.push(`第 ${idx + 1} 项商品 (${title}) 提供的链接是搜索列表页，必须是 detail.1688.com/offer/ 具体的详情单页！`);
    }

    // Profile check
    const profile = item.target_profile || {};
    if (!profile.visual_descriptors || !profile.refined_query || !profile.routing_decision) {
      errors.push(`第 ${idx + 1} 项商品 (${title}) 的 target_profile 分类特征对象不完整，缺少外观描述或分流决策！`);
    }

    // Spec Audit check
    const spec = item.spec_audit || {};
    if (spec.status === "材质缩水" || spec.status === "一票否决淘汰") {
      errors.push(`第 ${idx + 1} 项商品 (${title}) 的规格对比状态为一票否决/材质缩水，绝对禁止推荐为采购货源！`);
    }

    // Financial check
    const ledger = item.financial_ledger || {};
    if (isEtsySpecific) {
      const priceVal = parseFloat(ledger.target_price);
      if (priceVal && priceVal < 100) {
        errors.push(`第 ${idx + 1} 项商品 (${title}) 的售价为 ${priceVal}，怀疑是人民币/美元错乱，Etsy 美元售价不应该低于 100$！`);
      }
    }

    const margin = parseFloat(ledger.margin_rate);
    if (Number.isNaN(margin) || margin < 20) {
      errors.push(`第 ${idx + 1} 项商品 (${title}) 的利润率低于 20% 限值，不符合高毛利跨境套利策略！`);
    }

    // Evidence check
    const evidence = item.trend_evidence || item.selection_rationale || "";
    if (!evidence || evidence.trim().length < 20) {
      errors.push(`第 ${idx + 1} 项商品 (${title}) 的选品证据 (trend_evidence) 过短，必须提供至少 20 字的数据或差评支撑逻辑！`);
    }
  });

  // 4. CE/CPC/FDA/IP Certification warning check for specific goods
  if (isEtsySpecific) {
    const isToothbrush = userInstruction.includes("牙刷") || combinedText.includes("牙刷") || combinedText.includes("电器");
    if (isToothbrush && !/ce|cpc|fda|ip|合规/i.test(combinedText)) {
      errors.push("⚠️ 警告：该商品属于个护/通电类目，应在报告中发出“需取得欧美 CE/CPC/FDA 等合规文件”的合规性预警！");
    }
  }

  return errors;
}

function runShopOptimizerValidation(report) {
  const errors = [];
  const out = report.output || {};
  const combinedText = `${out.overview || ""}\n${out.analysis || ""}\n${out.summary || ""}`;
  if (/货源\s*#|推荐对齐货源|采购直达|detail\.1688\.com|s\.1688\.com/i.test(combinedText)) {
    errors.push("店铺优化报告不得输出货源编号、采购直达链接或 1688 推荐清单。");
  }
  if (!Array.isArray(out.data) || out.data.length === 0) {
    errors.push("店铺优化报告必须输出 A/B/C 分级优化方案。");
    return errors;
  }
  out.data.forEach((item, idx) => {
    const title = item.title || item.plan_id || `方案 #${idx + 1}`;
    const planText = `${item.plan_id || ""} ${item.diagnosis_level || ""} ${item.direction || ""} ${title}`;
    if (!/\b[ABC]-?\d*\b|A级|B级|C级|方案|优化|整改|诊断/i.test(planText)) {
      errors.push(`第 ${idx + 1} 项 (${title}) 不是 A/B/C 优化方案。`);
    }
    if (!item.stage_fit) {
      errors.push(`第 ${idx + 1} 项 (${title}) 缺少 stage_fit。`);
    }
    if (!item.buyer_scenario) {
      errors.push(`第 ${idx + 1} 项 (${title}) 缺少 buyer_scenario。`);
    }
    if (/1688\.com/i.test(String(item.product_link || item.link || ""))) {
      errors.push(`第 ${idx + 1} 项 (${title}) 包含 1688 采购链接。`);
    }
    const ledger = item.evidence_ledger;
    if (!Array.isArray(ledger) || ledger.length === 0) {
      errors.push(`第 ${idx + 1} 项 (${title}) 缺少 evidence_ledger。`);
    }
  });
  const ledgers = out.data.flatMap((item) => Array.isArray(item.evidence_ledger) ? item.evidence_ledger : []);
  const hasType = (type) => ledgers.some((entry) => String(entry.source_type || "").toLowerCase() === type);
  const hasTopic = (type, regex) => ledgers.some((entry) => {
    if (String(entry.source_type || "").toLowerCase() !== type) return false;
    return regex.test(`${entry.source_ref || ""} ${entry.observed_value || ""} ${entry.used_for || ""} ${entry.limitation || ""}`);
  });
  if (!hasType("page_dom")) errors.push("店铺优化报告必须包含 page_dom 页面文本证据，不能只凭截图。");
  if (!hasType("screenshot_visual")) errors.push("店铺优化报告必须包含 screenshot_visual 视觉截图证据。");
  if (!hasType("etsy_search")) errors.push("店铺优化报告必须包含真实 Etsy 站内搜索/热卖榜/高排名竞品证据，不能降级为 assumption。");
  if (!hasType("google_search") && !hasType("google_trends")) errors.push("店铺优化报告必须包含真实 Google Search US 或 Google Trends US 证据，不能降级为 assumption。");
  if (/配送|物流|时效|工作日|shipping|delivery/i.test(combinedText) && !hasTopic("google_search", /配送|物流|时效|shipping|delivery|transit|fulfillment|承运商/i)) {
    errors.push("涉及配送/物流/时效的店铺优化报告必须包含物流主题 google_search 实时证据。");
  }
  if (/(无法直接访问|未直接访问).*(etsy|trends|Google Trends)|行业报告摘要|Google 搜索摘要/i.test(combinedText)) {
    errors.push("店铺优化报告不得用未直接访问或摘要替代 Etsy/Google 必做取证。");
  }
  const fullText = `${combinedText}\n${JSON.stringify(out.data || [])}`;
  if (/选品机会书|选品机会深度分析|扩品机会书/i.test(combinedText)) {
    errors.push("店铺优化报告不得写成选品机会书。");
  }
  if (/获取\s*\d+\s*[-–—到至]\s*\d+\s*个评价|补充评价积累/i.test(fullText) && !/合规|真实订单|不得诱导|如实评价|发货后礼貌提醒/i.test(fullText)) {
    errors.push("店铺优化报告不能把获取评价写成孤立目标，必须约束为合规真实订单后的信任建设。");
  }
  return errors;
}

// ── Execute QA Tests ──
console.log("\n🧪 Test Case 1: Validating a perfectly formatted Etsy Sourcing Report...");
const errors1 = runValidation(mockValidReport, "审计该电动牙刷的选品可行性与CE/CPC/FDA/IP认证风险");
if (errors1.length === 0) {
  console.log("  ✅ Test Case 1 PASSED: Perfect report validation succeeded!");
} else {
  console.error("  ❌ Test Case 1 FAILED:", errors1);
}

console.log("\n🧪 Test Case 2: Validating a broken/jargon-filled report...");
const errors2 = runValidation(mockInvalidReport, "审计该电动牙刷的选品可行性与CE/CPC/FDA/IP认证风险");
if (errors2.length > 0) {
  console.log(`  ✅ Test Case 2 PASSED: Successfully detected ${errors2.length} issues:`);
  errors2.forEach((err, idx) => console.log(`     ${idx + 1}. ${err}`));
} else {
  console.error("  ❌ Test Case 2 FAILED: Failed to detect critical issues in broken report!");
}

console.log("\n🧪 Test Case 3: Validating a properly structured Etsy Shop Optimizer report...");
const errors3 = runShopOptimizerValidation(mockValidShopOptimizerReport);
if (errors3.length === 0) {
  console.log("  ✅ Test Case 3 PASSED: Shop optimizer report validation succeeded!");
} else {
  console.error("  ❌ Test Case 3 FAILED:", errors3);
}

console.log("\n🧪 Test Case 4: Validating a shop optimizer report polluted by sourcing output...");
const errors4 = runShopOptimizerValidation(mockInvalidShopOptimizerReport);
if (errors4.length > 0) {
  console.log(`  ✅ Test Case 4 PASSED: Successfully detected ${errors4.length} shop optimizer issues:`);
  errors4.forEach((err, idx) => console.log(`     ${idx + 1}. ${err}`));
} else {
  console.error("  ❌ Test Case 4 FAILED: Failed to detect sourcing contamination in shop optimizer report!");
}

console.log("\n=========================================");
console.log("🎉 QA Validator Suite completed.");
