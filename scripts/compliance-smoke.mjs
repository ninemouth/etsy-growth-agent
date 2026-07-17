import assert from "node:assert/strict";
import fs from "node:fs";
import {
  isComplianceSkill,
  validateReport,
} from "../modules/agentLoop.js";

const skillId = "skills/etsy_compliance_auditor.skill.md";
assert.equal(isComplianceSkill(skillId), true, "compliance skill must be recognized by runtime");
assert.equal(isComplianceSkill("skills/etsy_global_shop_optimizer.skill.md"), false);

const pageContext = {
  url: "https://www.etsy.com/listing/123/wedding-clutch",
  title: "Personalized Wedding Clutch",
  h1: "Personalized Wedding Clutch",
  visibleText: "Handmade satin clutch for wedding guests. Material: polyester. Adult accessory.",
  productCards: [],
  images: [{ src: "https://i.etsystatic.com/example.jpg", alt: "wedding clutch" }],
};
const toolHistory = [
  {
    tool: "read_current_page",
    result: { ok: true, pageData: pageContext },
  },
  {
    tool: "search_in_browser",
    arguments: { engine: "google", query: "site:etsy.com/help prohibited items Etsy" },
    result: { ok: true, finalUrl: "https://help.etsy.com/hc/en-us/articles/360000336307", pageData: { url: "https://help.etsy.com/hc/en-us/articles/360000336307", visibleText: "Etsy policy" } },
  },
  {
    tool: "search_in_browser",
    arguments: { engine: "google", query: "official textile labeling regulation" },
    result: { ok: true, finalUrl: "https://www.ftc.gov/legal-library/browse/rules/textile-labeling", pageData: { url: "https://www.ftc.gov/legal-library/browse/rules/textile-labeling", visibleText: "Textile labeling" } },
  },
];

const validReport = {
  type: "final",
  output: {
    overview: "商品发布前合规风险审查，目标市场为美国和欧洲，目标客群为成人婚礼配饰买家。",
    analysis: "当前页面支持成人婚礼配饰和材质标签方向判断；IP 和目的地标签仍需保留证据。",
    summary: "可继续准备 Listing，但先确认材质与标签信息，不把 CE/CPC/FDA 当成普通手拿包的通用要求。",
    data: [{
      risk_id: "C-1",
      risk_level: "medium",
      category: "labeling",
      finding: "页面显示为成人婚礼手拿包，未发现儿童、电子或食品接触用途；材质和护理标签仍需确认。",
      evidence: "来自 Etsy 商品详情页文本、商品图片和官方纺织标签规则页面；当前仅能确认公开声明，不能替代实物检测。",
      required_evidence: ["最终纤维成分", "护理标签照片"],
      first_action: "补齐商品详情中的材质和护理说明，并核对目标目的地标签要求。",
      publish_decision: "proceed_after_evidence",
      evidence_ledger: [
        { source_type: "page_dom", source_ref: pageContext.url, observed_value: "成人婚礼手拿包，页面写明 polyester", used_for: "判断商品用途和当前材质声明", confidence: "high", limitation: "仅覆盖公开详情页文本，不能证明实际材质检测结果" },
        { source_type: "official_policy", source_ref: "https://help.etsy.com/hc/en-us/articles/360000336307", observed_value: "Etsy 官方政策页面已访问", used_for: "核对平台商品发布边界", confidence: "high", limitation: "政策页面不替代目标市场法规判断" },
        { source_type: "official_regulation", source_ref: "https://www.ftc.gov/legal-library/browse/rules/textile-labeling", observed_value: "官方纺织品标签规则页面已访问", used_for: "核对纤维成分和标签补证据方向", confidence: "high", limitation: "尚未验证商品实物标签" },
      ],
    }],
  },
};
assert.deepEqual(validateReport(validReport, "审查商品合规", skillId, toolHistory, pageContext), [], "evidence-backed compliance report should pass");

const invalidReport = {
  type: "final",
  output: {
    overview: "商品合规报告，目标市场为美国和欧洲，目标客群为成人婚礼配饰买家。",
    analysis: "这款婚礼手拿包符合 FDA、CE 和 CPC，且没有 IP 风险。",
    summary: "可以直接发布。",
    data: [{
      risk_id: "C-1",
      risk_level: "low",
      category: "product_safety",
      finding: "普通手拿包符合 FDA、CE 和 CPC，已合规且无风险。",
      evidence: "仅有模型常识，没有商品详情页、截图或官方法规证据。",
      required_evidence: [],
      first_action: "直接发布",
      publish_decision: "proceed",
      evidence_ledger: [{ source_type: "assumption", source_ref: "model knowledge", observed_value: "未取得官方法规和商品检测资料", used_for: "证明已合规", confidence: "low", limitation: "待验证" }],
    }],
  },
};
assert.ok(validateReport(invalidReport, "审查商品合规", skillId, [], pageContext).length >= 3, "unsupported certification and certainty claims must fail hard validation");

const source = fs.readFileSync("modules/agentLoop.js", "utf8");
assert.match(source, /COMPLIANCE_ALLOWED_TOOLS/, "compliance tool whitelist must remain executable");
assert.match(source, /compliance_tool_whitelist_guard/, "runtime must reject disallowed compliance tools");
const backgroundSource = fs.readFileSync("background.js", "utf8");
assert.match(backgroundSource, /COMPLIANCE_DECISIONS_KEY/, "compliance decisions must be persisted as a lightweight state index");
assert.match(backgroundSource, /COMPLIANCE_DECISION_TTL_MS/, "compliance decisions must expire and be rechecked");
assert.match(backgroundSource, /COMPLIANCE_AUDIT_REQUIRED/, "sensitive Listing and sourcing actions must require a prior compliance audit");
assert.match(backgroundSource, /buildComplianceAutopilotInstruction/, "missing compliance decisions must be converted into an automatic compliance audit instruction");
assert.match(backgroundSource, /type:\s*"compliance_autopilot"/, "workflow progress must expose automatic compliance audit insertion");
const missingDecisionBlock = backgroundSource.match(/if \(!complianceDecision\) \{([\s\S]*?)\n            \}/)?.[1] || "";
assert.match(missingDecisionBlock, /matchedSkills = \[COMPLIANCE_SKILL_PATH\]/, "missing compliance decisions must route the run to the compliance auditor skill");
assert.doesNotMatch(missingDecisionBlock, /throw\s+error/, "missing compliance decisions should not terminate the workflow before audit");
assert.match(backgroundSource, /COMPLIANCE_ACTION_BLOCKED/, "high-risk compliance decisions must block downstream actions");
assert.match(backgroundSource, /errorCode:\s*err\.code/, "compliance gate failures must expose machine-readable error codes to the UI");
console.log("compliance smoke passed");
