// Browser automation capability contract for Etsy product workflows.
// This is intentionally conservative: it describes what the runtime can attempt,
// what it guarantees, and where a report must degrade or block.

export const BROWSER_AUTOMATION_CAPABILITIES = [
  {
    id: "address_navigation",
    label: "地址打开与页面跳转",
    tools: ["open_url", "open_new_tab", "navigate_to", "search_in_browser"],
    robustness: "strong",
    guarantees: [
      "新开标签页进入 workflow-owned tab 管理",
      "等待页面加载、DOM 证据稳定和截图可采集后返回",
      "保护来源 Etsy tab，避免店铺首页被覆盖或关闭",
    ],
    limitations: [
      "登录墙、验证码、人机验证会返回阻断或待人工状态",
      "站点强跳转时只能记录最终 URL、页面健康状态和证据质量",
    ],
  },
  {
    id: "keyboard_input_search",
    label: "模拟键盘输入与站内搜索",
    tools: ["input_text_and_search"],
    robustness: "medium_high",
    guarantees: [
      "模拟清空、逐字输入、input/change/keyup 事件",
      "优先点击可见搜索按钮，找不到按钮时回退 Enter",
      "轮询结果页，直到商品卡片、商品链接或阻断状态出现",
    ],
    limitations: [
      "复杂 Shadow DOM、强登录态或验证码可能需要人工介入",
      "复杂筛选应配合页面 DOM、截图和显式 filter/sort 证据",
    ],
  },
  {
    id: "filter_sort_pagination",
    label: "筛选、排序与翻页",
    tools: ["collect_etsy_shop_pages", "collect_etsy_competitor_shops", "scroll_page", "read_current_page", "click_by_text", "click_by_coordinate"],
    robustness: "medium_high",
    guarantees: [
      "店铺商品页会按 Etsy 分页机制采集可见商品",
      "竞品采集会记录排序、分页、商品卡片和页面签名",
      "坐标点击会屏蔽上传、相机和文件选择类危险区域",
    ],
    limitations: [
      "Etsy 个性化、地区化和虚拟加载会影响排序样本",
      "公开页面只能代表本轮可见样本，不能推断全平台完整商品数或竞品后台数据",
    ],
  },
  {
    id: "dom_collection_cleaning",
    label: "DOM 采集、清洗与压缩",
    tools: ["read_current_page", "collect_etsy_shop_pages", "collect_etsy_competitor_shops"],
    robustness: "strong",
    guarantees: [
      "优先读取 content script 结构化结果",
      "content script 薄弱时回退 scripting.executeScript 多 frame DOM snapshot",
      "返回页面健康状态、商品卡片、商品链接、图片、可见文本摘要和 pageEvidence",
    ],
    limitations: [
      "DOM 文本只代表当前可访问公开页面或授权自营页面",
      "Etsy 个人卖家 API 不支持读取其他店铺后台、竞品订单、竞品转化率或平台搜索量",
    ],
  },
  {
    id: "multimodal_screenshot",
    label: "多模态截图与视觉识别",
    tools: ["collect_etsy_shop_pages", "analyze_etsy_shop_crawl_screenshots", "search_in_browser", "click_by_coordinate"],
    robustness: "medium_high",
    guarantees: [
      "优先使用 Chrome debugger full-page screenshot，失败回退 visible viewport",
      "店铺、竞品、Google Trends 截图进入 artifactStore 并带 capture mode",
      "截图视觉分析必须与 DOM 和搜索证据双轨校验",
    ],
    limitations: [
      "截图不得替代 DOM 文本审计",
      "Google Trends 动态模块必须等待稳定；只加载壳页时必须阻断或降级为待验证",
    ],
  },
  {
    id: "review_collection",
    label: "评论与买家原声采集",
    tools: ["read_current_page", "open_new_tab", "collect_etsy_competitor_shops"],
    robustness: "medium",
    guarantees: [
      "支持从当前 DOM 抽取可见评论、评分、review count 和买家表达",
      "支持打开公开 listing / shop 页面读取评论线索",
      "评论区受阻时必须写入 blocking_gaps 或 assumption",
    ],
    limitations: [
      "公开评论样本代表本轮可见 DOM，不代表全量评论分布",
      "竞品评论、销量、转化率不能通过 Etsy 个人 API 获取",
    ],
  },
  {
    id: "tab_lifecycle",
    label: "网页关闭与生命周期保护",
    tools: ["close_tab", "search_in_browser", "open_new_tab", "navigate_to", "collect_etsy_shop_pages"],
    robustness: "strong",
    guarantees: [
      "workflow 创建的标签页登记为 owned tab",
      "来源 Etsy tab 被保护，cleanup 不会关闭原始店铺页",
      "工具超时会清理本轮新增临时页并保存 checkpoint",
    ],
    limitations: [
      "用户手动关闭来源页时只能保存断点并提示刷新后恢复",
      "未由 workflow 创建的旧标签页只在明确 tabId 且非保护页时关闭",
    ],
  },
  {
    id: "seller_api_and_archive",
    label: "Etsy 个人卖家 API 与本地归档",
    tools: ["etsy_api_get_store_snapshot", "etsy_api_get_product_list", "etsy_api_get_product_info", "get_saved_results", "save_result"],
    robustness: "medium_high",
    guarantees: [
      "Etsy API 仅用于授权自营店铺、listing、订单/发货资料等个人访问范围",
      "成功报告写入 savedResults，并附带 evidence_bundle 与 evidence_quality",
      "workflow checkpoint 保留断点、工具历史和 research_scope",
    ],
    limitations: [
      "缺少授权或字段不足时必须进入 blocking_gaps 或 assumption",
      "平台大盘、竞品后台、竞品订单、竞品转化率不得用个人卖家 API 冒充",
    ],
  },
];

export function summarizeBrowserAutomationCapabilities() {
  return BROWSER_AUTOMATION_CAPABILITIES.map((item) => ({
    id: item.id,
    label: item.label,
    tools: item.tools,
    robustness: item.robustness,
    guarantees: item.guarantees,
    limitations: item.limitations,
  }));
}

export function formatBrowserAutomationCapabilityPrompt() {
  return BROWSER_AUTOMATION_CAPABILITIES.map((item) => (
    `- ${item.label} (${item.robustness}): tools=${item.tools.join(", ")}; ` +
    `guarantees=${item.guarantees.join(" / ")}; limitations=${item.limitations.join(" / ")}`
  )).join("\n");
}
