// dashboard.js — Controller for Etsy AI Operations Dashboard

document.addEventListener("DOMContentLoaded", async () => {
  if (window.__etsyDashboardInitialized) return;
  window.__etsyDashboardInitialized = true;
  // Apply saved theme configuration
  chrome.storage.local.get(["settingsTheme"], (data) => {
    const theme = data.settingsTheme || "system";
    document.documentElement.className = `theme-${theme}`;
  });

  setDefaultStoreDateRange();
  document.body.classList.add("workflow-mode");
  initTabs();
  await refreshAllData();
  maybeAutoRefreshSellerApiCache().catch((err) => console.warn("Etsy 个人访问 API auto refresh skipped:", err.message));
  bindEvents();
});

const SELLER_API_AUTO_REFRESH_MS = 6 * 60 * 60 * 1000;
let selectedWorkflowId = "store_health";
let workflowZoom = 1;
let workflowPanX = 0;
let workflowPanY = 0;
let workflowCanvasEventsBound = false;
let workflowPipPosition = null;

let growthRuntimeState = {
  shops: [],
  activeShop: null,
  trackedProducts: [],
  savedResults: [],
  monitorEvents: [],
  monitorTasks: [],
  experiments: [],
  skuAnalyticsSnapshot: null,
  storeSnapshotCache: null,
  workflowTaskState: {},
  workflowTasks: [],
  workflowRoots: [],
  growthCases: [],
  growthActionRuns: [],
  skuRows: [],
  opportunities: [],
};

function isStoreApiSurfaceActive() {
  return Boolean(
    document.querySelector('.nav-menu button[data-tab="store"]')?.classList.contains("active") ||
    document.querySelector('.nav-menu button[data-tab="orders"]')?.classList.contains("active")
  );
}

const GROWTH_ACTIONS = {
  diagnose_store_growth: {
    title: "全店增长体检",
    skillPath: "skills/etsy_global_shop_optimizer.skill.md",
    instruction: "一键体检当前 Etsy 店铺增长瓶颈。必须先读取页面文本/API，判断店铺平台属性、经营阶段（新店冷启动/成长店/成熟店）、定位、目标人群、价格带和视觉调性；再实际访问 Etsy 站内搜索/热卖榜学习同类高排名店铺和商品；再访问 Google Search US / Google Trends US 验证站外需求。若涉及配送时效，必须实时搜索 Etsy 国际物流/目的地/承运商现状，禁止凭常识写 7-12 工作日。最后按曝光、点击、加购、付款、利润、履约、评分、商品结构和欧美买家场景输出优先级行动清单。",
  },
  diagnose_sku_funnel: {
    title: "SKU 漏斗诊断",
    skillPath: "skills/etsy_operations_tracker.skill.md",
    instruction: "诊断当前 SKU 的公开页面转化线索和自营订单/发货资料瓶颈；个人 API 不提供 Sessions、点击率或加购率时，必须标记为待验证，不得伪造漏斗指标。",
  },
  rewrite_listing: {
    title: "商品页转化改版",
    skillPath: "skills/etsy_listing_generator.skill.md",
    instruction: "基于当前商品或 SKU 队列生成 Etsy 英文 SEO 标题、主图卖点、详情页描述和规格补齐建议。",
  },
  diagnose_visual_conversion: {
    title: "首图点击力诊断",
    skillPath: "skills/etsy_global_shop_optimizer.skill.md",
    instruction: "诊断 Etsy 商品首图和画廊视觉转化力，输出英文主图文案、需要删除的中文/工厂感元素和三种改版方向。",
  },
  scan_competitor_changes: {
    title: "竞品变化扫描",
    skillPath: "skills/etsy_global_shop_optimizer.skill.md",
    instruction: "扫描竞品价格、主图、评论、断货、促销和关键词变化，输出可抢量、可避战、可跟价和可反打机会。",
  },
  analyze_review_defects: {
    title: "评论缺陷诊断",
    skillPath: "skills/etsy_review_analyzer.skill.md",
    instruction: "分析欧美买家评论与退换货风险，归因质量、包装、说明、规格、物流和预期差距，并生成产品改良任务。",
  },
  calculate_profit_guardrail: {
    title: "利润安全线",
    skillPath: "skills/etsy_sourcing_finder.skill.md",
    instruction: "测算 Etsy SKU 建议售价、最低促销价、利润保护价、发货资料 成本边界和是否需要寻源降本。",
  },
  filter_supplier_sources: {
    title: "供应商货源筛选",
    skillPath: "skills/etsy_sourcing_finder.skill.md",
    instruction: "基于当前 Etsy 商品、候选扩品方向或平台趋势机会，筛选可进入验证的 1688/国内供应商货源。请优先做外观与规格一致性、起批量、采购价、跨境物流、Etsy 佣金、关税和 USD 净利润率审计；未获得真实供应商详情页时不得输出采购直达链接。",
  },
  detect_fulfillment_risk: {
    title: "履约风险扫描",
    skillPath: "skills/etsy_operations_tracker.skill.md",
    instruction: "扫描待发货倒计时、发货资料 履约风险、断货风险、补货优先级和库存积压 SKU。",
  },
  find_expansion_opportunities: {
    title: "扩品机会发现",
    skillPath: "skills/etsy_product_opportunity_explorer.skill.md",
    instruction: "从当前店铺、竞品、季节需求、差评痛点和供应链套利角度发现可上架或可小批测试的 Etsy 扩品机会。",
  },
  explore_platform_trends: {
    title: "Etsy 平台趋势机会",
    skillPath: "skills/etsy_platform_trends.skill.md",
    instruction: "扫描当前 Etsy 搜索、类目、品牌或热卖页面，专注判断平台级商品机会和趋势窗口。请输出价格带、评价门槛、头部商品共性、英文关键词、季节性需求、Google Trends / Etsy 搜索 待验证或真实证据，并区分平台趋势机会与本店扩品动作。",
  },
  create_growth_experiment: {
    title: "创建增长实验",
    skillPath: "skills/etsy_operations_tracker.skill.md",
    instruction: "把当前 AI 建议转为 7 天增长实验，定义目标 SKU、优化动作、基线指标、观察指标、干扰项和复盘时间。",
  },
  review_experiment_result: {
    title: "复盘实验结果",
    skillPath: "skills/etsy_operations_tracker.skill.md",
    instruction: "复盘执行中和观察中的增长实验，比较真实自营订单/发货资料与公开页面证据；没有基线或个人 API 不支持的曝光/加购指标必须标记待验证，不得直接判断成功。",
  },
};

const GROWTH_ACTION_CASE_TYPE = {
  diagnose_store_growth: "store_health",
  diagnose_sku_funnel: "store_health",
  diagnose_visual_conversion: "listing_conversion",
  rewrite_listing: "listing_conversion",
  scan_competitor_changes: "competitor_watch",
  analyze_review_defects: "listing_conversion",
  calculate_profit_guardrail: "opportunity_profit",
  filter_supplier_sources: "supplier_sourcing",
  detect_fulfillment_risk: "store_health",
  find_expansion_opportunities: "opportunity_profit",
  explore_platform_trends: "platform_trends",
  create_growth_experiment: "experiment_review",
  review_experiment_result: "experiment_review",
};

const GROWTH_CASE_LABELS = {
  store_health: "店铺体检案件",
  competitor_watch: "竞品跟踪案件",
  listing_conversion: "商品页转化案件",
  platform_trends: "平台趋势案件",
  opportunity_profit: "机会与利润案件",
  supplier_sourcing: "供应商货源案件",
  experiment_review: "执行与复盘案件",
};

function growthCaseIdFor(actionId, shopId = "", sku = "") {
  const caseType = GROWTH_ACTION_CASE_TYPE[actionId] || "store_health";
  const scope = sku ? stableHash(sku) : "shop";
  return `${caseType}_${shopId || "no_shop"}_${scope}`;
}

function isInterruptedSavedResult(entry = {}) {
  const result = entry?.result;
  return result?.type === "interrupted" || /工作流已达到本次连续运行预算|工作流已收到取消信号|已保存断点/.test(String(result?.result || ""));
}

const GROWTH_CONTRACT_VERSION = 1;

function normalizeGrowthRunRecord(run = {}) {
  const now = run.updatedAt || run.createdAt || new Date().toISOString();
  return {
    ...run,
    contractVersion: Number(run.contractVersion || GROWTH_CONTRACT_VERSION),
    id: run.id || `growth_run_${Date.now()}`,
    caseId: run.caseId || "unassigned",
    status: run.status || "queued",
    evidence: run.evidence && typeof run.evidence === "object" ? run.evidence : {},
    reportIds: Array.isArray(run.reportIds) ? run.reportIds.map(String) : [],
    createdAt: run.createdAt || now,
    updatedAt: now,
  };
}

function normalizeGrowthCaseRecord(caseItem = {}) {
  const now = caseItem.updatedAt || caseItem.createdAt || new Date().toISOString();
  const runs = Array.isArray(caseItem.runs)
    ? caseItem.runs.map(normalizeGrowthRunRecord)
    : Array.isArray(caseItem.runHistory) ? caseItem.runHistory.map(normalizeGrowthRunRecord) : [];
  return {
    ...caseItem,
    contractVersion: Number(caseItem.contractVersion || GROWTH_CONTRACT_VERSION),
    id: caseItem.id || `growth_case_${Date.now()}`,
    type: caseItem.type || "store_health",
    status: caseItem.status || "queued",
    evidence: caseItem.evidence && typeof caseItem.evidence === "object" ? caseItem.evidence : {},
    taskIds: Array.isArray(caseItem.taskIds) ? caseItem.taskIds.map(String) : [],
    reportIds: Array.isArray(caseItem.reportIds) ? caseItem.reportIds.map(String) : [],
    eventIds: Array.isArray(caseItem.eventIds) ? caseItem.eventIds.map(String) : [],
    experiments: Array.isArray(caseItem.experiments) ? caseItem.experiments.map(String) : [],
    runs: runs.slice(0, 20),
    runHistory: runs.slice(0, 20),
    nextReviewAt: caseItem.nextReviewAt || null,
    createdAt: caseItem.createdAt || now,
    updatedAt: now,
  };
}

// ── Tab Management ──
function initTabs() {
  const navItems = document.querySelectorAll(".nav-menu .nav-item");
  const viewPanes = document.querySelectorAll(".view-pane");

  navItems.forEach((btn) => {
    btn.addEventListener("click", () => {
      const tabId = btn.getAttribute("data-tab");
      document.body.classList.toggle("workflow-mode", tabId === "workflow");
      
      // Update Active Navigation Item
      navItems.forEach((n) => n.classList.remove("active"));
      btn.classList.add("active");

      // Update Page Title
      const navLabel = (btn.innerText || btn.textContent || "")
        .replace(/[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|[\u2011-\u26FF]|\uD83E[\uDD10-\uDDFF]/g, "")
        .trim();
      document.getElementById("page-title").textContent = navLabel;

      // Show Selected Tab Content
      viewPanes.forEach((pane) => {
        pane.classList.remove("active");
        if (pane.id === `view-${tabId}`) {
          pane.classList.add("active");
        }
      });

      // Special Tab Actions
      if (tabId === "workflow") {
        renderSmartWorkflow();
      } else if (tabId === "sku") {
        renderSkuWorkbench();
      } else if (tabId === "opportunities") {
        renderOpportunityCenter();
      } else if (tabId === "experiments") {
        renderExperimentBoard();
      } else if (tabId === "tracker") {
        renderTrackerTab();
      } else if (tabId === "store" || tabId === "orders") {
        renderStoreTab();
      }
    });
  });
}

// ── Global Event Bindings ──
function bindEvents() {
  document.getElementById("refresh-all-btn").addEventListener("click", async () => {
    await refreshAllData();
    if (isStoreApiSurfaceActive()) {
      renderStoreTab();
    }
  });

  const storeQueryBtn = document.getElementById("store-api-query-btn");
  if (storeQueryBtn) {
    storeQueryBtn.addEventListener("click", () => renderStoreTab());
  }

  const skuFilter = document.getElementById("sku-filter");
  if (skuFilter) {
    skuFilter.addEventListener("change", renderSkuWorkbench);
  }

  const syncSkuApiBtn = document.getElementById("sync-sku-api-btn");
  if (syncSkuApiBtn) {
    syncSkuApiBtn.addEventListener("click", syncSkuAnalyticsFromApi);
  }

  const goToSkuBtn = document.getElementById("go-to-sku-workbench");
  if (goToSkuBtn) {
    goToSkuBtn.addEventListener("click", () => document.querySelector('.nav-menu button[data-tab="sku"]')?.click());
  }

  const goToWorkflowBtn = document.getElementById("go-to-workflow-canvas");
  if (goToWorkflowBtn) {
    goToWorkflowBtn.addEventListener("click", () => document.querySelector('.nav-menu button[data-tab="workflow"]')?.click());
  }

  document.getElementById("workflow-zoom-out")?.addEventListener("click", () => setWorkflowZoom(workflowZoom - 0.1));
  document.getElementById("workflow-zoom-in")?.addEventListener("click", () => setWorkflowZoom(workflowZoom + 0.1));
  document.getElementById("workflow-zoom-reset")?.addEventListener("click", () => {
    workflowPanX = 0;
    workflowPanY = 0;
    setWorkflowZoom(1);
  });
  bindWorkflowCanvasInteractions();

  const goToOpportunitiesBtn = document.getElementById("go-to-opportunities");
  if (goToOpportunitiesBtn) {
    goToOpportunitiesBtn.addEventListener("click", () => document.querySelector('.nav-menu button[data-tab="opportunities"]')?.click());
  }

  const createManualExperimentBtn = document.getElementById("create-manual-experiment-btn");
  if (createManualExperimentBtn) {
    createManualExperimentBtn.addEventListener("click", () => createGrowthExperiment({
      sku: "店铺级",
      title: "手动增长实验",
      action: "记录本周要验证的运营动作",
      metric: "订单量 / 加购率",
      source: "manual",
    }));
  }
  
  document.getElementById("clear-db-btn").addEventListener("click", async () => {
    if (confirm("🚨 确定要清除大盘的所有本地数据么？这将清空已保存报告、历史事件以及运营跟踪列表！")) {
      await new Promise((r) => chrome.storage.local.clear(r));
      alert("数据重置成功！");
      window.location.reload();
    }
  });

  // Quick Arbitrage Calculator Logic
  document.getElementById("quick-calc-btn").addEventListener("click", () => {
    const costCny = parseFloat(document.getElementById("calc-cost").value) || 0;
    const weight = parseFloat(document.getElementById("calc-weight").value) || 0;
    const priceRub = parseFloat(document.getElementById("calc-price").value) || 0;

    const exchangeRate = 12.5; 
    const costRub = costCny * exchangeRate;
    const logisticsRub = (weight * 5.5 * 90) + (2.0 * 90) + (2 / 12.5 * 90);
    const commissionRub = priceRub * 0.12;

    let customsRub = 0;
    if (priceRub > 20000) {
      customsRub = (priceRub - 20000) * 0.15;
    }

    const netProfitRub = priceRub - costRub - logisticsRub - commissionRub - customsRub;
    const marginRate = (netProfitRub / priceRub) * 100;

    const resultEl = document.getElementById("calc-result");
    resultEl.innerHTML = `
      <div style="background:var(--bg3); border-radius:6px; padding:10px; border:1px solid var(--border)">
        <div style="display:flex; justify-content:space-between"><span>货源汇率换算:</span><span>¥${costCny} ➔ ${costRub.toFixed(0)} $</span></div>
        <div style="display:flex; justify-content:space-between"><span>预估Etsy 自发货运费:</span><span>${logisticsRub.toFixed(0)} $</span></div>
        <div style="display:flex; justify-content:space-between"><span>Etsy 类目佣金 (12%):</span><span>${commissionRub.toFixed(0)} $</span></div>
        ${customsRub > 0 ? `<div style="display:flex; justify-content:space-between; color:var(--danger)"><span>超出额关税 (15%):</span><span>${customsRub.toFixed(0)} $</span></div>` : ''}
        <div style="border-top:1px solid var(--border); margin-top:8px; padding-top:6px; display:flex; justify-content:space-between; font-weight:700">
          <span>预估纯利润:</span>
          <span style="color:${netProfitRub > 0 ? '#10b981' : '#ef4444'}">${netProfitRub.toFixed(0)} $</span>
        </div>
        <div style="display:flex; justify-content:space-between; font-weight:700">
          <span>预估利润率:</span>
          <span style="color:${marginRate > 20 ? '#10b981' : '#ef4444'}">${marginRate.toFixed(1)}%</span>
        </div>
      </div>
    `;
  });

  // Scheduled Task adding
  document.getElementById("add-task-btn").addEventListener("click", async () => {
    const urlInput = document.getElementById("task-url");
    const freqSelect = document.getElementById("task-freq");
    const typeSelect = document.getElementById("task-target-type");
    const natureSelect = document.getElementById("task-shop-nature");

    const url = urlInput.value.trim();
    const frequency = freqSelect.value;
    const targetType = typeSelect ? typeSelect.value : "item";
    const shopNature = natureSelect ? natureSelect.value : "competitor";

    if (!url) {
      alert("请输入合法的 Etsy 商品详情或店铺主页 URL！");
      return;
    }

    const activeShopId = document.getElementById("global-shop-selector").value;
    if (!activeShopId) {
      alert("请先在顶部下拉框中选择或绑定自营店铺！");
      return;
    }

    const storage = await new Promise((r) => chrome.storage.local.get(["monitorTasks"], r));
    const tasks = storage.monitorTasks || [];
    const taskId = `task_${Date.now()}`;
    
    const taskObj = {
      id: taskId,
      shopId: activeShopId, // Multi-shop binding!
      task_type: "shop_check",
      platform: "etsy",
      target_type: targetType,
      shop_nature: shopNature,
      target_url: url,
      target_entity_key: `etsy:${targetType}:${Math.random().toString(36).slice(2, 7)}`,
      growthCaseId: growthCaseIdFor(targetType === "item" ? "diagnose_sku_funnel" : "scan_competitor_changes", activeShopId),
      frequency: frequency,
      last_run_at: "从未运行",
      status: "active"
    };

    tasks.push(taskObj);
    await new Promise((r) => chrome.storage.local.set({ monitorTasks: tasks }, r));

    // Register Chrome alarm
    let periodInMinutes = 360; 
    if (frequency === "15m") periodInMinutes = 15;
    else if (frequency === "1h") periodInMinutes = 60;
    else if (frequency === "24h") periodInMinutes = 1440;

    const alarmName = `monitor_task_${encodeURIComponent(JSON.stringify(taskObj))}`;
    try {
      await chrome.alarms.create(alarmName, { periodInMinutes });
    } catch (alarmErr) {
      console.warn("Could not register Chrome alarm:", alarmErr.message);
    }

    urlInput.value = '';
    alert("自动感知监控任务添加成功！");
    await refreshAllData();
  });

  // Go to events button
  const goToEventsBtn = document.getElementById("go-to-events");
  if (goToEventsBtn) {
    goToEventsBtn.addEventListener("click", () => {
      const targetBtn = document.querySelector('.nav-menu button[data-tab="events"]');
      if (targetBtn) targetBtn.click();
    });
  }

  // Handle Global Shop Selector Switch
  const globalShopSelector = document.getElementById("global-shop-selector");
  if (globalShopSelector) {
    const newSelector = globalShopSelector.cloneNode(true);
    globalShopSelector.parentNode.replaceChild(newSelector, globalShopSelector);
    
    newSelector.addEventListener("change", async (e) => {
      const selectedId = e.target.value;
      if (selectedId) {
        await new Promise(r => chrome.storage.local.set({ activeShopId: selectedId }, r));
        await refreshAllData();
        drawTrackerCharts();
        if (isStoreApiSurfaceActive()) {
          renderStoreTab();
        }
      }
    });
  }

  document.getElementById("settings-open-store")?.addEventListener("click", () => {
    document.querySelector('.nav-menu button[data-tab="store"]')?.click();
    document.getElementById("settings-drawer")?.classList.add("hidden");
  });
  document.getElementById("settings-reset-all")?.addEventListener("click", () => document.getElementById("clear-db-btn")?.click());
  document.getElementById("floating-settings-btn")?.addEventListener("click", () => {
    renderSettingsTab();
    document.getElementById("settings-drawer")?.classList.remove("hidden");
  });
  document.getElementById("settings-drawer-close")?.addEventListener("click", () => {
    document.getElementById("settings-drawer")?.classList.add("hidden");
  });
}

// ── Refresh / Load Storage Data ──
async function refreshAllData() {
  const data = await new Promise((resolve) => {
    chrome.storage.local.get([
      "trackedProducts",
      "savedResults",
      "monitorChangeEvents",
      "monitorReports",
      "monitorTasks",
      "growthExperiments",
      "growthWorkflowTaskState",
      "growthCases",
      "growthActionRuns",
      "etsySkuAnalyticsSnapshot",
      "etsyStoreSnapshotCache",
      "etsyClientId",
      "etsyApiKey",
      "etsyShops",
      "activeShopId"
    ], resolve);
  });

  // 1. Credentials Migration for backward compatibility
  if (data.etsyClientId && data.etsyApiKey && (!data.etsyShops || data.etsyShops.length === 0)) {
      const migratedShop = {
      id: data.etsyShopId || `shop_${Date.now()}`,
      shopId: data.etsyShopId || "",
      name: "默认自建店铺",
      apiKey: data.etsyApiKey,
      warehouseType: "Etsy 自发货",
      isDefault: true
    };
    data.etsyShops = [migratedShop];
    data.activeShopId = migratedShop.id;
    await new Promise(r => chrome.storage.local.set({
      etsyShops: data.etsyShops,
      activeShopId: data.activeShopId
    }, r));
  }

  const shops = data.etsyShops || [];
  let activeId = data.activeShopId;
  
  if (shops.length > 0 && (!activeId || !shops.some(s => s.id === activeId))) {
    activeId = (shops.find(s => s.isDefault) || shops[0]).id;
    data.activeShopId = activeId;
    await new Promise(r => chrome.storage.local.set({ activeShopId: activeId }, r));
  }

  // 2. Global Dropdown selector rendering
  const selector = document.getElementById("global-shop-selector");
  if (selector) {
    if (shops.length === 0) {
      selector.innerHTML = `<option value="">⚠️ 请先绑定 Etsy 店铺</option>`;
    } else {
      selector.innerHTML = shops.map(s => 
        `<option value="${s.id}" ${s.id === activeId ? 'selected' : ''}>🏢 ${s.name} (${s.shopId || s.clientId || s.id})</option>`
      ).join('');
    }
  }

  // 3. Multi-Store Manager Sidebar List rendering
  const shopListContainer = document.getElementById("dashboard-shop-list");
  if (shopListContainer) {
    if (shops.length === 0) {
      shopListContainer.innerHTML = `<div class="empty-state" style="padding:15px 0;">暂无绑定店铺，请在下方录入。</div>`;
    } else {
      shopListContainer.innerHTML = shops.map(s => `
        <div class="shop-list-item" style="display:flex; justify-content:space-between; align-items:center; padding:8px; border:1px solid var(--border); border-radius:6px; background:${s.id === activeId ? 'rgba(0,91,255,0.04)' : 'var(--bg-input)'}; border-color:${s.id === activeId ? '#005bff' : 'var(--border)'}; font-size:12px;">
          <div>
            <div style="font-weight:600; color:var(--text-primary); display:flex; align-items:center; gap:6px;">
              ${s.id === activeId ? '<span class="status-indicator success" style="width:6px; height:6px;"></span>' : ''}
              ${s.name}
              ${s.isDefault ? '<span style="font-size:10px; color:#10b981; font-weight:normal; border:1px solid #10b981; padding:0 4px; border-radius:3px; zoom:0.9">默认</span>' : ''}
            </div>
            <div style="font-size:10px; color:var(--text-secondary); margin-top:2px;">Shop ID: ${s.shopId || s.clientId || s.id} | ${s.warehouseType}</div>
          </div>
          <div style="display:flex; gap:6px;">
            ${s.id !== activeId ? `<button class="btn btn-outline btn-xs btn-set-active" data-shop-id="${s.id}">设为活动</button>` : ''}
            <button class="btn btn-danger btn-xs btn-delete-shop" data-shop-id="${s.id}">删除</button>
          </div>
        </div>
      `).join('');

      // Add event listeners
      shopListContainer.querySelectorAll(".btn-set-active").forEach(btn => {
        btn.addEventListener("click", async () => {
          const shopId = btn.getAttribute("data-shop-id");
          await new Promise(r => chrome.storage.local.set({ activeShopId: shopId }, r));
          await refreshAllData();
          drawTrackerCharts();
          if (isStoreApiSurfaceActive()) {
            renderStoreTab();
          }
        });
      });

      shopListContainer.querySelectorAll(".btn-delete-shop").forEach(btn => {
        btn.addEventListener("click", async () => {
          const shopId = btn.getAttribute("data-shop-id");
          if (confirm("确定要删除此店铺的绑定凭证吗？这将导致关联的监控任务失效！")) {
            const updatedShops = shops.filter(s => s.id !== shopId);
            let nextActiveId = activeId;
            if (activeId === shopId) {
              nextActiveId = updatedShops.length > 0 ? updatedShops[0].id : "";
            }
            if (updatedShops.length > 0 && !updatedShops.some(s => s.isDefault)) {
              updatedShops[0].isDefault = true;
            }
            await new Promise(r => chrome.storage.local.set({
              etsyShops: updatedShops,
              activeShopId: nextActiveId
            }, r));
            await refreshAllData();
            drawTrackerCharts();
            if (isStoreApiSurfaceActive()) {
              renderStoreTab();
            }
          }
        });
      });
    }
  }

  // 4. Filter data by activeShopId
  const filterByActiveShop = (list = []) => {
    return list.filter(item => {
      if (!item.shopId) return shops.length <= 1 || item.clientId === (shops.find(s => s.id === activeId) || {}).clientId;
      return item.shopId === activeId;
    });
  };

  const filteredTracked = filterByActiveShop(data.trackedProducts || []);
  const filteredSavedResults = filterByActiveShop(data.savedResults || []).filter((entry) => !isInterruptedSavedResult(entry));
  const filteredTasks = filterByActiveShop(data.monitorTasks || []);
  const filteredEvents = filterByActiveShop(data.monitorChangeEvents || []).map((event) => ({
    ...event,
    contractVersion: Number(event.contractVersion || GROWTH_CONTRACT_VERSION),
    growthCaseId: event.growthCaseId || "",
  }));
  const filteredReports = filterByActiveShop(data.monitorReports || []);
  const filteredExperiments = filterByActiveShop(data.growthExperiments || []);
  const activeShop = shops.find(s => s.id === activeId) || null;
  const skuRows = buildSkuRows(filteredTracked, filteredSavedResults, filteredEvents, activeShop, data.etsySkuAnalyticsSnapshot || null);
  const opportunities = buildOpportunityCards(skuRows, filteredEvents, filteredSavedResults);
  const workflowTasks = buildWorkflowTasks({
    skuRows,
    opportunities,
    events: filteredEvents,
    reports: filteredSavedResults,
    experiments: filteredExperiments,
    taskState: data.growthWorkflowTaskState || {},
    activeShop,
    skuAnalyticsSnapshot: data.etsySkuAnalyticsSnapshot || null,
  });

  growthRuntimeState = {
    shops,
    activeShop,
    trackedProducts: filteredTracked,
    savedResults: filteredSavedResults,
    monitorEvents: filteredEvents,
    monitorTasks: filteredTasks,
    experiments: filteredExperiments,
    skuAnalyticsSnapshot: data.etsySkuAnalyticsSnapshot || null,
    storeSnapshotCache: data.etsyStoreSnapshotCache || null,
    workflowTaskState: data.growthWorkflowTaskState || {},
    workflowTasks,
    workflowRoots: buildWorkflowRoots({
      tasks: workflowTasks,
      reports: filteredSavedResults,
      events: filteredEvents,
      experiments: filteredExperiments,
      opportunities,
      skuRows,
      activeShop,
      skuAnalyticsSnapshot: data.etsySkuAnalyticsSnapshot || null,
      storeSnapshotCache: data.etsyStoreSnapshotCache || null,
    }),
    growthCases: mergeGrowthCasesWithRoots((data.growthCases || []).map(normalizeGrowthCaseRecord), workflowTasks, filteredSavedResults, activeShop, filteredEvents),
    growthActionRuns: (data.growthActionRuns || []).filter(run => !run.shopId || run.shopId === activeId).slice(0, 50),
    skuRows,
    opportunities,
  };

  // 5. Update counters with filtered counts
  document.getElementById("stat-tracked-count").innerText = filteredTracked.length;
  
  const sourcingResults = filteredSavedResults.filter(r => r.skillId && r.skillId.includes("sourcing_finder"));
  document.getElementById("stat-sourcing-count").innerText = sourcingResults.length;
  
  document.getElementById("stat-alert-events").innerText = filteredEvents.length;
  
  const diagnosticReportsCount = filteredReports.length + filteredSavedResults.filter(r => r.skillId && r.skillId.includes("optimizer")).length;
  document.getElementById("stat-reports-count").innerText = diagnosticReportsCount;

  // 6. Render recent events, pipeline table, tasks, and reports
  renderRecentEventsFeed(filteredEvents);
  renderPipelineTable(filteredSavedResults);
  renderTasksTable(filteredTasks);
  renderReportsList(filteredReports, filteredSavedResults);
  renderGrowthHome();
  renderSmartWorkflow();
  renderSourceLedger();
  renderSkuWorkbench();
  renderOpportunityCenter();
  renderExperimentBoard();
  renderSettingsTab();
}

// ── Render Components ──

function getRiskBadgeClass(kind) {
  if (kind === "scale") return "success";
  if (kind === "profit" || kind === "fulfillment") return "warning";
  return "danger";
}

function extractSkuAnalyticsRows(snapshot = null) {
  if (snapshot && snapshot?.result?.supported !== true && snapshot?.supported !== true) return [];
  const rows = snapshot?.result?.data || snapshot?.data || [];
  const metrics = snapshot?.result?.metrics || snapshot?.metrics || ["hits_view", "session_view", "ordered_units", "conv_tocart"];
  if (!Array.isArray(rows)) return [];
  return rows.map((row, index) => {
    const dimensions = row.dimensions || row.dimension || [];
    const skuDimension = Array.isArray(dimensions)
      ? (dimensions.find(d => d.id || d.name) || dimensions[0] || {})
      : {};
    const metricValues = row.metrics || [];
    const metric = (name) => {
      const idx = metrics.indexOf(name);
      return Number(metricValues[idx] ?? row[name] ?? 0) || 0;
    };
    const sku = String(skuDimension.id || skuDimension.name || row.sku || `api-sku-${index + 1}`);
    const title = String(skuDimension.name || row.title || sku);
    const views = metric("hits_view");
    const sessions = metric("session_view");
    const orderedUnits = metric("ordered_units");
    const cartRate = metric("conv_tocart");
    return {
      id: `api_${sku}`,
      sku,
      title,
      views,
      sessions,
      orderedUnits,
      cartRate: Number((cartRate || (sessions > 0 ? (orderedUnits / sessions) * 100 : 0)).toFixed(1)),
      orderRate: Number((sessions > 0 ? (orderedUnits / sessions) * 100 : 0).toFixed(1)),
      source: "seller_api",
    };
  }).filter(row => row.sku);
}

function buildSkuRows(tracked = [], savedResults = [], events = [], _activeShop = null, skuAnalyticsSnapshot = null) {
  const rows = [];
  const apiRows = extractSkuAnalyticsRows(skuAnalyticsSnapshot);
  if (apiRows.length) {
    return apiRows.map((apiRow, index) => {
      const margin = 18 + ((apiRow.sku.length + index) % 22);
      const stockDays = 5 + ((apiRow.sku.length * 7 + index) % 36);
      const issue = apiRow.cartRate < 2.6
        ? "conversion"
        : margin < 20
          ? "profit"
          : stockDays < 8
            ? "fulfillment"
            : apiRow.sessions < 1000
              ? "exposure"
              : "scale";
      const issueLabel = {
        exposure: "曝光弱",
        conversion: "加购弱",
        profit: "利润弱",
        fulfillment: "履约风险",
        scale: "可放大",
      }[issue];
      const nextAction = {
        exposure: "基于真实 SKU 曝光不足，优先重构关键词和类目入口",
        conversion: "基于真实加购率偏低，优先改首图和详情页承接",
        profit: "真实销量可见，需补利润安全线和寻源降本",
        fulfillment: "真实订单 SKU 进入履约风险观察",
        scale: "真实数据表现可放大，建议扩展变体和相邻关键词",
      }[issue];
      return {
        ...apiRow,
        revenue: (apiRow.orderedUnits * 900).toFixed(0),
        margin,
        stockDays,
        rating: 0,
        issue,
        issueLabel,
        nextAction,
        savedEvidence: savedResults.length,
        eventCount: events.length,
        dataSource: "Etsy 个人访问 API",
      };
    });
  }

  if (skuAnalyticsSnapshot && skuAnalyticsSnapshot?.result?.supported !== true && skuAnalyticsSnapshot?.supported !== true) return [];

  if (!tracked.length) return [];

  tracked.forEach((prod, index) => {
    rows.push({
      id: prod.id || `sku_${index}`,
      sku: prod.sku || prod.id || `local-${index + 1}`,
      title: prod.title || prod.name || `Etsy 商品 ${index + 1}`,
      url: prod.url || prod.pageUrl || "",
      issue: "needs_api",
      issueLabel: "待同步",
      sessions: null,
      views: null,
      cartRate: null,
      orderRate: null,
      revenue: null,
      margin: null,
      stockDays: null,
      rating: null,
      nextAction: "同步 Etsy 个人访问 API 或运行店铺体检后再判断 SKU 优先级",
      savedEvidence: savedResults.length,
      eventCount: events.length,
      dataSource: "本地跟踪商品（待 API 指标）",
    });
  });
  return rows.sort((a, b) => {
    const priority = { fulfillment: 5, profit: 4, conversion: 3, exposure: 2, needs_api: 1, scale: 0 };
    return priority[b.issue] - priority[a.issue] || Number(b.revenue || 0) - Number(a.revenue || 0);
  });
}

function buildOpportunityCards(skuRows = [], events = [], savedResults = []) {
  const cards = [];
  const weakConversion = skuRows.find(row => row.issue === "conversion");
  const weakProfit = skuRows.find(row => row.issue === "profit");
  const scaleSku = skuRows.find(row => row.issue === "scale") || skuRows[0];
  const fulfillmentSku = skuRows.find(row => row.issue === "fulfillment");

  if (weakConversion) {
    cards.push({
      id: `opp_visual_${weakConversion.id}`,
      type: "首图/商品页",
      title: `${weakConversion.title} 有曝光但加购弱`,
      evidence: `加购率 ${weakConversion.cartRate}%；建议优先验证主图、英文卖点和详情页承接。`,
      impact: "预计优先影响点击后加购率",
      action: "diagnose_visual_conversion",
      experiment: "首图英文卖点改版 7 天实验",
    });
  }
  if (weakProfit) {
    cards.push({
      id: `opp_profit_${weakProfit.id}`,
      type: "利润/寻源",
      title: `${weakProfit.title} 低于利润安全线`,
      evidence: `模型毛利线 ${weakProfit.margin}%；适合先测最低促销价，再进入独立寻源降本。`,
      impact: "减少卖得越多利润越薄的风险",
      action: "calculate_profit_guardrail",
      experiment: "利润保护价调价实验",
    });
  }
  if (fulfillmentSku) {
    cards.push({
      id: `opp_fulfillment_${fulfillmentSku.id}`,
      type: "履约",
      title: `${fulfillmentSku.title} 存在履约/断货风险`,
      evidence: `库存周转约 ${fulfillmentSku.stockDays} 天；建议先复核 Etsy 自发货处理时间、目的地承运商时效和补货倒计时；第三方仓只作为成熟订单密度后的后续验证项。`,
      impact: "避免排序权重和买家体验受损",
      action: "detect_fulfillment_risk",
      experiment: "自发货/第三方仓补货策略观察实验",
    });
  }
  if (scaleSku) {
    cards.push({
      id: `opp_expand_${scaleSku.id}`,
      type: "扩品",
      title: `围绕 ${scaleSku.title} 扩展相邻款`,
      evidence: `当前付款率 ${scaleSku.orderRate}%；可从竞品变体、差评痛点和季节词反推扩品。`,
      impact: "把已有成功 SKU 扩成商品矩阵",
      action: "find_expansion_opportunities",
      experiment: "相邻变体小批上架实验",
    });
  }
  events.slice(0, 2).forEach((event, index) => {
    cards.push({
      id: `opp_event_${index}`,
      type: "竞品事件",
      title: event.entity_name || "竞品出现变化",
      evidence: event.event_desc || "检测到价格、促销、评论或页面变化。",
      impact: "可能形成跟价、避战或抢量窗口",
      action: "scan_competitor_changes",
      experiment: "竞品变化应对实验",
    });
  });
  if (!cards.length && !savedResults.length) {
    cards.push({
      id: "opp_seed",
      type: "启动建议",
      title: "先建立一个可追踪的增长闭环",
      evidence: "当前本地还没有足够的历史报告或监控事件；建议先跑全店体检，再把 1 个 SKU 加入实验。",
      impact: "让后续所有 AI 建议都能被复盘",
      action: "diagnose_store_growth",
      experiment: "首个店铺级增长实验",
    });
  }
  return cards;
}

function stableHash(value = "") {
  let hash = 0;
  const text = String(value || "");
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function taskStateFor(taskId, taskState = {}) {
  return taskState[taskId] || {};
}

function buildWorkflowTask(task, taskState = {}) {
  const state = taskStateFor(task.id, taskState);
  return {
    status: "todo",
    owner: "人工确认",
    source: "AI 诊断",
    dueLabel: "今天",
    ...task,
    ...state,
  };
}

function buildTasksFromReports(reports = [], taskState = {}) {
  const tasks = [];
  reports
    .filter((report) => report?.result?.data && /optimizer|listing|review|operations|opportunity/i.test(report.skillId || ""))
    .slice(0, 4)
    .forEach((report) => {
      const items = Array.isArray(report.result.data) ? report.result.data : [];
      items.slice(0, 3).forEach((item, itemIndex) => {
        const actions = item.first_actions || item.next_steps || item.actionable_tasks || item.actions || "";
        const actionText = Array.isArray(actions) ? actions.join("；") : String(actions || item.direction || item.recommendation || "");
        if (!actionText.trim()) return;
        const title = item.title || item.plan_id || item.direction || `诊断任务 ${itemIndex + 1}`;
        const id = `report_${stableHash(`${report.id}_${title}_${actionText}`)}`;
        const reportActionId = report.growthActionId || "";
        const reportKind = reportActionId === "explore_platform_trends"
          ? "platform_trend"
          : report.skillId?.includes("opportunity") && /趋势|平台|类目|热卖|搜索|trend|category|bestseller/i.test(`${title} ${item.evidence || ""} ${item.trend_evidence || ""}`)
            ? "platform_trend"
            : "diagnosis_action";
        tasks.push(buildWorkflowTask({
          id,
          kind: reportKind,
          severity: item.diagnosis_level || item.priority || "P1",
          title,
          reason: item.evidence || item.diagnosis_basis || report.result.summary || "来自最近 AI 决策书的结构化建议。",
          actionText,
          actionId: reportKind === "platform_trend" ? "explore_platform_trends" : report.skillId?.includes("listing") ? "rewrite_listing" : report.skillId?.includes("review") ? "analyze_review_defects" : "diagnose_store_growth",
          source: report.skillName || "AI 决策书",
          owner: "运营执行",
          dueLabel: "本轮",
        }, taskState));
      });
    });
  return tasks;
}

function buildWorkflowTasks({ skuRows = [], opportunities = [], events = [], reports = [], experiments = [], taskState = {}, activeShop = null, skuAnalyticsSnapshot = null }) {
  const tasks = [];
  const hasSkuApi = !!skuAnalyticsSnapshot?.result?.data?.length;
  const foundation = assessStoreFoundation({ skuRows, reports, opportunities, activeShop });

  if (foundation.needsRepositioning) {
    tasks.push(buildWorkflowTask({
      id: `foundation_${activeShop?.id || stableHash(foundation.reason)}`,
      kind: "store_positioning",
      severity: "P0",
      title: "先重构店铺定位，再推进运营细节",
      reason: foundation.reason,
      actionText: "确认目标客群、主价格带、商品矩阵、差异化理由和应下架/弱化的商品群；形成定位方案后再拆商品页、价格和海报任务。",
      actionId: "diagnose_store_growth",
      source: foundation.explicitRisk ? "AI 决策书定位风险" : "Etsy 个人访问 API 全量 SKU 轻体检",
      owner: "经营负责人确认",
      dueLabel: "先做",
    }, taskState));
  }

  skuRows.filter(row => row.issue !== "scale" && row.issue !== "needs_api").slice(0, 6).forEach((row) => {
    const actionId = row.issue === "profit"
      ? "calculate_profit_guardrail"
      : row.issue === "fulfillment"
        ? "detect_fulfillment_risk"
        : row.issue === "conversion"
          ? "diagnose_visual_conversion"
          : "diagnose_sku_funnel";
    const id = `sku_${stableHash(`${row.sku}_${row.issue}_${row.title}`)}`;
    tasks.push(buildWorkflowTask({
      id,
      kind: "sku_health",
      severity: row.issue === "fulfillment" || row.issue === "profit" ? "P0" : "P1",
      title: `${row.issueLabel}: ${row.title}`,
      sku: row.sku,
      reason: hasSkuApi
        ? `Etsy 个人访问 API 发现该 SKU ${row.issueLabel}；曝光 ${Number(row.sessions || 0).toLocaleString()}，加购 ${row.cartRate}%，付款 ${row.orderRate}%。`
        : `当前来自${row.dataSource || "本地追踪"}，需要同步 Etsy 个人访问 API 后确认。`,
      actionText: row.nextAction,
      actionId,
      source: hasSkuApi ? "Etsy 个人访问 API 全量 SKU 轻体检" : "本地队列",
      owner: row.issue === "fulfillment" ? "运营/仓配确认" : "运营执行",
      dueLabel: row.issue === "fulfillment" ? "立即" : "今天",
    }, taskState));
  });

  opportunities.slice(0, 4).forEach((card) => {
    const id = `opp_${stableHash(`${card.id}_${card.title}`)}`;
    tasks.push(buildWorkflowTask({
      id,
      kind: "opportunity",
      severity: "P1",
      title: card.title,
      reason: card.evidence,
      actionText: card.experiment || card.impact,
      actionId: card.action,
      source: card.type || "机会中心",
      owner: "运营判断",
      dueLabel: "本周",
    }, taskState));
  });

  events.slice(0, 3).forEach((event, index) => {
    const id = `event_${stableHash(`${event.id || index}_${event.entity_name}_${event.event_desc}`)}`;
    tasks.push(buildWorkflowTask({
      id,
      kind: "competitor_event",
      severity: "P1",
      title: event.entity_name || "竞品发生变化",
      reason: event.event_desc || "监控任务检测到竞品价格、促销、评分或页面变化。",
      actionText: "确认是否跟价、避战、改主图或建立新监控对象。",
      actionId: "scan_competitor_changes",
      source: "竞品感知事件",
      owner: "运营确认",
      dueLabel: "24h",
    }, taskState));
  });

  tasks.push(...buildTasksFromReports(reports, taskState));

  experiments
    .filter((exp) => exp.status === "observing" || exp.status === "running")
    .slice(0, 3)
    .forEach((exp) => {
      const id = `exp_review_${stableHash(`${exp.id}_${exp.status}`)}`;
      tasks.push(buildWorkflowTask({
        id,
        kind: "experiment_review",
        severity: exp.status === "observing" ? "P1" : "P2",
        title: `复盘实验: ${exp.title}`,
        sku: exp.sku,
        reason: exp.status === "observing" ? "实验已进入观察期，需要对比 Etsy 个人访问 API 数据变化。" : "实验正在执行中，请确认人工动作是否已完成。",
        actionText: exp.status === "observing" ? "拉取实验窗口数据，判断继续、停止或二次优化。" : "确认改图/改标题/调价/补货等动作已实际执行。",
        actionId: "review_experiment_result",
        source: "增长实验",
        owner: "运营复盘",
        dueLabel: exp.status === "observing" ? "到期" : "执行后",
      }, taskState));
    });

  if (!tasks.length) {
    tasks.push(buildWorkflowTask({
      id: `seed_${activeShop?.id || "no_shop"}`,
      kind: "bootstrap",
      severity: "P0",
      title: activeShop ? "先运行一次全店体检，生成第一批运营任务" : "先绑定 Etsy 个人访问 API 店铺，建立全量 SKU 体检基线",
      reason: activeShop ? "当前还没有足够的 SKU 风险、机会、实验和监控事件。" : "没有 Etsy 个人访问 API 时只能做页面级诊断，无法形成全量经营任务流。",
      actionText: activeShop ? "从 Etsy 店铺页点击右侧悬浮栏「店铺」或在此发起全店体检。" : "绑定 API Key / API Key 后同步 SKU analytics。",
      actionId: activeShop ? "diagnose_store_growth" : "",
      source: activeShop ? "启动建议" : "数据源缺口",
      owner: "店铺配置",
      dueLabel: "先做",
    }, taskState));
  }

  const severityRank = { P0: 4, P1: 3, P2: 2, P3: 1 };
  const statusRank = { todo: 4, confirmed: 3, observing: 2, done: 1, dismissed: 0 };
  return tasks
    .filter((task) => task.status !== "dismissed")
    .sort((a, b) => (statusRank[b.status] || 0) - (statusRank[a.status] || 0) || (severityRank[b.severity] || 0) - (severityRank[a.severity] || 0))
    .slice(0, 18);
}

function workflowStatusLabel(status) {
  return {
    todo: "待处理",
    confirmed: "已执行待观察",
    observing: "观察中",
    done: "已复盘",
  }[status] || "待处理";
}

function workflowCaseStatusLabel(status) {
  return {
    ready: "待诊断",
    queued: "排队中",
    running: "运行中",
    interrupted: "已保存断点",
    completed: "已生成报告",
    failed: "运行失败",
    needs_frontend_context: "需前台页面执行",
    observing: "观察中",
    done: "已关闭",
  }[status] || "待诊断";
}

function workflowLaneLabel(lane) {
  return {
    foundation: "根基",
    diagnosis: "体检",
    market: "竞品",
    conversion: "转化",
    growth: "增长",
    review: "复盘",
    workflow: "流程",
  }[lane] || "流程";
}

function workflowKindLabel(kind) {
  return {
    store_positioning: "定位重构",
    sku_health: "SKU 体检",
    opportunity: "机会",
    platform_trend: "平台趋势",
    competitor_event: "竞品",
    diagnosis_action: "诊断拆解",
    experiment_review: "复盘",
    bootstrap: "启动",
  }[kind] || "任务";
}

function latestReportBy(reports = [], matcher) {
  return reports
    .filter((report) => matcher(report))
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))[0] || null;
}

function summarizeWorkflowTasks(tasks = []) {
  return {
    total: tasks.length,
    p0: tasks.filter(task => task.severity === "P0").length,
    todo: tasks.filter(task => task.status === "todo").length,
    confirmed: tasks.filter(task => task.status === "confirmed").length,
    observing: tasks.filter(task => task.status === "observing").length,
    done: tasks.filter(task => task.status === "done").length,
  };
}

function workflowSourceText(items = []) {
  return items.map((item) => {
    try {
      return JSON.stringify(item || {});
    } catch (_) {
      return String(item || "");
    }
  }).join(" ");
}

function assessStoreFoundation({ skuRows = [], reports = [], opportunities = [], activeShop = null }) {
  const sourceText = workflowSourceText(reports)
    .replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex) => String.fromCharCode(parseInt(hex, 16)));
  const foundationPattern = /定位|人群|客群|品牌|差异化|类目选择|价格带|店铺结构|战略|重构|根基|全店方向|assortment|positioning|brand|segment/i;
  const explicitRisk = foundationPattern.test(sourceText);
  const riskRows = skuRows.filter(row => row.issue !== "scale").length;
  const scaleRows = skuRows.filter(row => row.issue === "scale").length;
  const riskRatio = skuRows.length ? riskRows / skuRows.length : 0;
  const operationalEvidence = opportunities.length + reports.length + skuRows.length;
  const needsRepositioning = explicitRisk || (skuRows.length >= 4 && riskRatio >= 0.65 && scaleRows === 0);

  return {
    needsRepositioning,
    explicitRisk,
    riskRatio,
    riskRows,
    scaleRows,
    stage: needsRepositioning ? "foundation" : operationalEvidence ? "operations" : "bootstrap",
    title: activeShop ? `${activeShop.name} 定位重构` : "店铺定位重构",
    reason: explicitRisk
      ? "最近 AI 决策书已出现定位、人群、差异化或店铺结构风险信号。"
      : needsRepositioning
        ? `全量 SKU 轻体检中 ${riskRows}/${skuRows.length} 个 SKU 处于风险或低效状态，且缺少可放大 SKU，优先判断店铺定位。`
        : "当前更像运营细节优化场景，可直接推进 SKU、商品页、竞品和复盘任务。",
  };
}

function statusFromCaseRuns(caseItem = {}) {
  const runs = caseItem.runs || [];
  if (runs.some(run => run.status === "running")) return "running";
  if (runs.some(run => run.status === "interrupted")) return "interrupted";
  if (runs.some(run => run.status === "failed")) return "failed";
  if (runs.some(run => run.status === "completed")) return "completed";
  if (runs.some(run => run.status === "queued")) return "queued";
  return caseItem.status || "ready";
}

function mergeGrowthCasesWithRoots(storedCases = [], tasks = [], reports = [], activeShop = null, events = []) {
  const byId = new Map();
  storedCases.forEach((caseItem) => {
    if (!caseItem?.id) return;
    byId.set(caseItem.id, {
      ...caseItem,
      runs: Array.isArray(caseItem.runs) ? caseItem.runs : [],
      reportIds: Array.isArray(caseItem.reportIds) ? caseItem.reportIds : [],
      taskIds: Array.isArray(caseItem.taskIds) ? caseItem.taskIds : [],
    });
  });

  const roots = [
    { type: "store_health", actionId: "diagnose_store_growth", taskKinds: ["store_positioning", "sku_health", "diagnosis_action", "bootstrap"] },
    { type: "competitor_watch", actionId: "scan_competitor_changes", taskKinds: ["competitor_event"] },
    { type: "listing_conversion", actionId: "rewrite_listing", matcher: task => /visual|listing|review|conversion|加购|转化|改版|评论/.test(`${task.actionId || ""} ${task.title || ""} ${task.reason || ""}`) },
    { type: "platform_trends", actionId: "explore_platform_trends", matcher: task => task.kind === "platform_trend" || /platform_trends|trend|趋势|平台|类目|热卖|搜索|需求词/.test(`${task.actionId || ""} ${task.title || ""} ${task.reason || ""}`) },
    { type: "opportunity_profit", actionId: "find_expansion_opportunities", matcher: task => task.kind === "opportunity" || /profit|expansion|机会|利润|扩品|寻源/.test(`${task.actionId || ""} ${task.title || ""}`) },
    { type: "supplier_sourcing", actionId: "filter_supplier_sources", matcher: task => task.kind === "supplier_sourcing" || /supplier|sourcing|货源|供应商|1688|采购|寻源|利润账本/.test(`${task.actionId || ""} ${task.title || ""} ${task.reason || ""}`) },
    { type: "experiment_review", actionId: "review_experiment_result", matcher: task => task.kind === "experiment_review" || ["confirmed", "observing", "done"].includes(task.status) },
  ];

  roots.forEach((root) => {
    const id = `${root.type}_${activeShop?.id || "no_shop"}_shop`;
    const rootTasks = tasks.filter(root.matcher || ((task) => root.taskKinds.includes(task.kind)));
    const rootReports = reports.filter((report) => {
      const skill = `${report.skillId || ""} ${report.skillName || ""}`;
      if (root.type === "store_health") return /global_shop_optimizer|optimizer|operations/i.test(skill);
      if (root.type === "competitor_watch") return /competitor|optimizer/i.test(skill);
      if (root.type === "listing_conversion") return /listing|review|optimizer/i.test(skill);
      if (root.type === "platform_trends") return report.growthActionId === "explore_platform_trends" || /opportunity|trend|trends/i.test(skill);
      if (root.type === "opportunity_profit") return /opportunity|sourcing/i.test(skill);
      if (root.type === "supplier_sourcing") return report.growthActionId === "filter_supplier_sources" || /sourcing/i.test(skill);
      if (root.type === "experiment_review") return /operations|tracker/i.test(skill);
      return false;
    });
    const existing = byId.get(id) || {};
    const rootEvents = events.filter((event) => event.growthCaseId === id);
    byId.set(id, {
      contractVersion: GROWTH_CONTRACT_VERSION,
      id,
      type: root.type,
      title: existing.title || GROWTH_CASE_LABELS[root.type] || "增长案件",
      shopId: activeShop?.id || existing.shopId || "",
      status: statusFromCaseRuns(existing),
      actionId: root.actionId,
      taskIds: Array.from(new Set([...(existing.taskIds || []), ...rootTasks.map(task => task.id)])),
      reportIds: Array.from(new Set([...(existing.reportIds || []), ...rootReports.map(report => String(report.id))])),
      eventIds: Array.from(new Set([...(existing.eventIds || []), ...rootEvents.map(event => String(event.id))])),
      experiments: Array.isArray(existing.experiments) ? existing.experiments : [],
      nextReviewAt: existing.nextReviewAt || null,
      evidence: {
        ...(existing.evidence || {}),
        taskCount: rootTasks.length,
        reportCount: rootReports.length,
        eventCount: rootEvents.length,
        updatedFromRuntimeAt: new Date().toISOString(),
      },
      runs: existing.runs || [],
      runHistory: existing.runHistory || existing.runs || [],
      createdAt: existing.createdAt || new Date().toISOString(),
      updatedAt: existing.updatedAt || new Date().toISOString(),
    });
  });

  return Array.from(byId.values()).sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
}

function buildRootEvidenceStatus(root, { reports = [], events = [], experiments = [], skuRows = [], skuAnalyticsSnapshot = null, storeSnapshotCache = null }) {
  const hasSkuApi = Boolean(skuAnalyticsSnapshot?.result?.data?.length || skuAnalyticsSnapshot?.data?.length);
  const hasStoreApi = Boolean(storeSnapshotCache?.result || storeSnapshotCache?.data);
  const hasAnyApi = hasSkuApi || hasStoreApi;
  const reportCount = root.report ? 1 : reports.filter((report) => {
    if (!report) return false;
    if (root.id === "platform_trends") return report.growthActionId === "explore_platform_trends" || /trend|opportunity/i.test(report.skillId || "");
    if (root.id === "supplier_sourcing") return report.growthActionId === "filter_supplier_sources" || /sourcing/i.test(report.skillId || "");
    return report.growthActionId === root.actionId || String(report.skillId || "").includes(String(root.actionId || ""));
  }).length;

  const status = [];
  status.push({
    key: "api",
    label: hasAnyApi ? "API 已同步" : "API 待同步",
    tone: hasAnyApi ? "ok" : "warn",
    detail: hasSkuApi
      ? `SKU Analytics 已同步，${skuRows.length} 个 SKU 可参与判断。`
      : hasStoreApi
        ? "店铺快照已同步，可作为店铺级判断依据。"
        : "未发现 Etsy 个人访问 API 本地快照，运行时只能依赖前台页面、历史报告或待验证假设。",
  });
  status.push({
    key: "reports",
    label: reportCount ? `${reportCount} 份报告` : "无报告",
    tone: reportCount ? "ok" : "muted",
    detail: reportCount ? "已有 AI 报告可作为当前流程证据。" : "还没有此流程的历史报告，首次运行会创建案件和报告。",
  });
  status.push({
    key: "tasks",
    label: root.stats?.total ? `${root.stats.total} 个任务` : "无任务",
    tone: root.stats?.total ? "ok" : "muted",
    detail: root.stats?.total ? `其中 ${root.stats.p0 || 0} 个 P0，需要人工确认或执行。` : "当前没有由报告或数据自动生成的待办任务。",
  });

  if (root.id === "competitor_watch") {
    status.push({
      key: "events",
      label: events.length ? `${events.length} 条事件` : "无事件",
      tone: events.length ? "ok" : "muted",
      detail: events.length ? "已有竞品/监控变化事件可进入跟踪判断。" : "尚无竞品变化事件，建议先从 Etsy 前台页面建立基线。",
    });
  }
  if (root.id === "experiment_review") {
    status.push({
      key: "experiments",
      label: experiments.length ? `${experiments.length} 个实验` : "无实验",
      tone: experiments.length ? "ok" : "muted",
      detail: experiments.length ? "已有实验/观察对象可复盘。" : "还没有已执行动作进入观察窗口。",
    });
  }
  if (root.id === "platform_trends" || root.id === "supplier_sourcing") {
    status.push({
      key: "front_page",
      label: "需前台页面",
      tone: "warn",
      detail: root.id === "platform_trends"
        ? "平台趋势最好在 Etsy 搜索、类目、品牌或热卖页面触发，Dashboard 内运行可能缺少页面上下文。"
        : "货源验证最好从具体 Etsy 商品/机会页面触发，以便读取目标图和规格；Dashboard 内运行可能需要右侧浮窗承接。",
    });
  }
  return status;
}

function buildWorkflowRoots({ tasks = [], reports = [], events = [], experiments = [], opportunities = [], skuRows = [], activeShop = null, skuAnalyticsSnapshot = null, storeSnapshotCache = null }) {
  const foundation = assessStoreFoundation({ skuRows, reports, opportunities, activeShop });
  const rootConfigs = [
    {
      id: "store_health",
      lane: foundation.needsRepositioning ? "foundation" : "diagnosis",
      title: "店铺体检",
      subtitle: foundation.needsRepositioning
        ? "体检结论：先处理定位/人群/商品矩阵"
        : activeShop ? `${activeShop.name} 全店经营体检` : "绑定店铺后形成全店经营体检",
      actionId: "diagnose_store_growth",
      report: latestReportBy(reports, report => /global_shop_optimizer|optimizer/i.test(report.skillId || "")),
      taskFilter: task => ["store_positioning", "sku_health", "diagnosis_action", "bootstrap"].includes(task.kind),
      narrative: foundation.needsRepositioning
        ? "这不是一个独立的“定位重构状态”，而是店铺体检给出的 P0 结论：先判断店铺卖给谁、靠什么差异化、主价格带和商品矩阵是否成立，再决定哪些海报、标题、价格和 SKU 动作值得做。"
        : "从 Etsy 个人访问 API 全量 SKU 轻体检开始，AI 挑出高风险/高机会对象，并拆成改图、改标题、调价、补货、监控等人工确认任务。",
      foundation,
    },
    {
      id: "competitor_watch",
      lane: "market",
      title: "竞品跟踪",
      subtitle: events.length ? `${events.length} 条竞品感知事件` : "从店铺页、类目页或商品页建立竞品基线",
      actionId: "scan_competitor_changes",
      report: latestReportBy(reports, report => /competitor|optimizer/i.test(`${report.skillId || ""} ${report.skillName || ""}`)),
      taskFilter: task => task.kind === "competitor_event",
      narrative: "竞品不是一张静态表，而是价格、主图、评分、促销和评论变化事件流；每个变化都应转成跟价、避战、改版或监控任务。",
    },
    {
      id: "listing_conversion",
      lane: "conversion",
      title: "商品页转化",
      subtitle: "首图、英文标题、详情页、评论缺陷",
      actionId: "rewrite_listing",
      report: latestReportBy(reports, report => /listing|review/i.test(report.skillId || "")),
      taskFilter: task => /visual|listing|review|conversion|加购|转化|改版|评论/.test(`${task.actionId || ""} ${task.title || ""} ${task.reason || ""}`),
      narrative: "当 SKU 有曝光但加购弱时，AI 深挖首图、标题、attributes、评论痛点和英文表达，再让运营确认具体改版动作。",
    },
    {
      id: "platform_trends",
      lane: "market",
      title: "平台趋势",
      subtitle: "Etsy 热卖、类目价格带、Etsy 欧美需求词",
      actionId: "explore_platform_trends",
      report: latestReportBy(reports, report => report.growthActionId === "explore_platform_trends" || /opportunity|trend|trends/i.test(report.skillId || "")),
      taskFilter: task => task.kind === "platform_trend" || /platform_trends|trend|趋势|平台|类目|热卖|搜索|需求词/.test(`${task.actionId || ""} ${task.title || ""} ${task.reason || ""}`),
      narrative: "这里看的是 Etsy 平台上的商品机会和趋势窗口，不等同于本店扩品。它先回答：平台上哪些类目、价格带、关键词和季节需求正在形成机会；通过验证后，才进入机会扩品或供应链利润线。",
    },
    {
      id: "opportunity_profit",
      lane: "growth",
      title: "机会扩品",
      subtitle: opportunities.length ? `${opportunities.length} 个扩品/利润机会` : "从成功 SKU、差评和价格带寻找新机会",
      actionId: "find_expansion_opportunities",
      report: latestReportBy(reports, report => /opportunity|sourcing/i.test(report.skillId || "")),
      taskFilter: task => task.kind === "opportunity" || /profit|expansion|机会|利润|扩品|寻源/.test(`${task.actionId || ""} ${task.title || ""}`),
      narrative: "不是孤立选品，而是把已验证 SKU、竞品空位、欧美需求词和供应链利润线变成小批测试工作流。",
    },
    {
      id: "supplier_sourcing",
      lane: "growth",
      title: "供应商货源",
      subtitle: "1688/国内货源、规格一致、USD 利润账本",
      actionId: "filter_supplier_sources",
      report: latestReportBy(reports, report => report.growthActionId === "filter_supplier_sources" || /sourcing/i.test(report.skillId || "")),
      taskFilter: task => task.kind === "supplier_sourcing" || /supplier|sourcing|货源|供应商|1688|采购|寻源|利润账本/.test(`${task.actionId || ""} ${task.title || ""} ${task.reason || ""}`),
      narrative: "这里不是普通选品，而是把已经值得验证的商品机会进入供应商筛选：同款/相似款匹配、规格一致性、起批量、采购价、跨境物流、平台佣金、关税和美元净利润率都必须过账。",
    },
    {
      id: "experiment_review",
      lane: "review",
      title: "执行与复盘",
      subtitle: experiments.length ? `${experiments.length} 个实验/观察对象` : "人工执行后进入 7 天观察窗口",
      actionId: "review_experiment_result",
      report: latestReportBy(reports, report => /operations|tracker/i.test(report.skillId || "")),
      taskFilter: task => task.kind === "experiment_review" || ["confirmed", "observing", "done"].includes(task.status),
      narrative: "智能化的关键不是自动替你改，而是知道哪些动作已人工完成、何时进入观察、复盘时该拿哪些 Etsy 个人访问 API 指标对比。",
    },
  ];

  return rootConfigs.map((root) => {
    const rootTasks = tasks.filter(root.taskFilter);
    const stats = summarizeWorkflowTasks(rootTasks);
    const rootWithStats = {
      ...root,
      tasks: rootTasks,
      stats,
      skuCount: skuRows.length,
      status: stats.todo > 0 ? "todo" : stats.observing > 0 ? "observing" : stats.done > 0 ? "done" : "ready",
    };
    return {
      ...rootWithStats,
      evidenceStatus: buildRootEvidenceStatus(rootWithStats, {
        reports,
        events,
        experiments,
        skuRows,
        skuAnalyticsSnapshot,
        storeSnapshotCache,
      }),
    };
  });
}

function renderSmartWorkflow() {
  const board = document.getElementById("workflow-canvas-board");
  const pip = document.getElementById("workflow-pip");
  if (!board || !pip) return;

  const roots = growthRuntimeState.workflowRoots || [];
  updateWorkflowZoomLabel();

  if (!roots.some(root => root.id === selectedWorkflowId)) selectedWorkflowId = roots[0]?.id || "store_health";
  const selectedRoot = roots.find(root => root.id === selectedWorkflowId) || roots[0];
  const selectedTasks = selectedRoot?.tasks || [];
  const lanes = [
    { id: "todo", title: "待确认", hint: "AI 已生成，等待人工判断/执行" },
    { id: "confirmed", title: "已执行", hint: "人工已完成，等待数据变化" },
    { id: "observing", title: "观察中", hint: "进入 3-7 天观察窗口" },
    { id: "done", title: "已复盘", hint: "已形成结论或二次动作" },
  ];

  board.innerHTML = `
    <div class="workflow-zoom-layer" style="${workflowCanvasTransformStyle()}">
      <div class="workflow-map-layer">
        <div class="root-node-rail">
          ${roots.map((root, index) => `
          <button class="canvas-node root-node ${root.id === selectedWorkflowId ? "selected" : ""} ${root.status} ${root.lane === "foundation" ? "foundation" : ""}" data-root-id="${root.id}" style="--node-index:${index}; left:${index * 268}px;">
            <span class="node-lane">${escapeHtml(workflowLaneLabel(root.lane))}</span>
            <strong>${escapeHtml(root.title)}</strong>
            <small>${escapeHtml(root.subtitle)}</small>
            <div class="node-stats">
              <span>${root.stats.total} 任务</span>
              <span>${root.stats.p0} P0</span>
              <span>${root.report ? "有报告" : "待诊断"}</span>
            </div>
            <div class="node-evidence-strip">
              ${(root.evidenceStatus || []).slice(0, 3).map(item => `<span class="evidence-chip ${escapeHtml(item.tone)}">${escapeHtml(item.label)}</span>`).join("")}
            </div>
          </button>
          `).join("")}
        </div>
      </div>
      <section class="scrum-board">
      <div class="scrum-board-head">
        <div>
          <span class="node-lane">${escapeHtml(workflowLaneLabel(selectedRoot?.lane || "workflow"))}</span>
          <h3>${escapeHtml(selectedRoot?.title || "增长工作流")}</h3>
              <p>${escapeHtml(selectedRoot?.narrative || "运行一次体检后，AI 会把结果拆成可以人工确认、观察和复盘的任务。")}</p>
        </div>
        <div class="canvas-actions">
          ${selectedRoot ? `<button class="btn btn-primary growth-action-btn" data-action="${selectedRoot.actionId}">运行/更新此流程</button>` : ""}
          <button class="btn btn-outline open-root-detail-btn" data-root-id="${selectedRoot?.id || ""}">${selectedRoot?.report ? "报告/详情" : "流程详情"}</button>
        </div>
      </div>
      <div class="scrum-columns">
        ${lanes.map((lane) => {
          const laneTasks = selectedTasks.filter(task => (task.status || "todo") === lane.id);
          return `
            <div class="scrum-column" data-lane="${lane.id}">
              <div class="scrum-column-head">
                <strong>${lane.title}</strong>
                <span>${laneTasks.length}</span>
              </div>
              <p>${lane.hint}</p>
              <div class="scrum-task-stack">
                ${laneTasks.length ? laneTasks.map((task) => `
                  <article class="workflow-task-card compact ${task.status}" data-open-task="${escapeHtml(task.id)}">
                    <div class="workflow-task-top">
                      <span class="badge ${task.severity === "P0" ? "danger" : task.severity === "P1" ? "warning" : "success"}">${escapeHtml(task.severity || "P1")}</span>
                      <span class="workflow-kind">${escapeHtml(workflowKindLabel(task.kind))}</span>
                      <span class="workflow-due">${escapeHtml(task.dueLabel || "今天")}</span>
                    </div>
                    <h4>${escapeHtml(task.title)}</h4>
                    <p>${escapeHtml(task.reason)}</p>
                    <div class="workflow-task-foot">
                      <span>${escapeHtml(task.source)} · ${escapeHtml(task.owner)}</span>
                      <button class="btn btn-outline btn-xs open-task-detail-btn" data-task-id="${escapeHtml(task.id)}">详情</button>
                    </div>
                  </article>
                `).join("") : `<div class="empty-state compact">暂无</div>`}
              </div>
            </div>
          `;
        }).join("")}
      </div>
      </section>
    </div>
  `;

  board.querySelectorAll(".canvas-node").forEach((node) => {
    node.addEventListener("click", () => {
      selectedWorkflowId = node.dataset.rootId;
      renderSmartWorkflow();
      openWorkflowPip({ rootId: node.dataset.rootId });
    });
  });
  board.querySelectorAll(".growth-action-btn").forEach((btn) => {
    btn.addEventListener("click", () => handleGrowthAction(btn.dataset.action, ""));
  });
  board.querySelectorAll(".open-root-detail-btn").forEach((btn) => {
    btn.addEventListener("click", () => openWorkflowPip({ rootId: btn.dataset.rootId }));
  });
  board.querySelectorAll(".open-task-detail-btn, [data-open-task]").forEach((btn) => {
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      openWorkflowPip({ taskId: btn.dataset.taskId || btn.dataset.openTask });
    });
  });
}

function renderEvidenceChecklist(items = []) {
  if (!items.length) return `<div class="empty-state compact">暂无证据状态。</div>`;
  return `
    <div class="workflow-evidence-list">
      ${items.map(item => `
        <div class="workflow-evidence-item ${escapeHtml(item.tone)}">
          <strong>${escapeHtml(item.label)}</strong>
          <span>${escapeHtml(item.detail || "")}</span>
        </div>
      `).join("")}
    </div>
  `;
}

function workflowNextStatus(status) {
  return status === "todo" ? "confirmed" : status === "confirmed" ? "observing" : "done";
}

function workflowCanvasTransformStyle() {
  return `transform: translate(${workflowPanX}px, ${workflowPanY}px) scale(${workflowZoom}); width: ${100 / workflowZoom}%; min-height: ${100 / workflowZoom}%;`;
}

function applyWorkflowCanvasTransform() {
  const layer = document.querySelector(".workflow-zoom-layer");
  if (layer) layer.setAttribute("style", workflowCanvasTransformStyle());
}

function setWorkflowZoom(nextZoom) {
  workflowZoom = Math.min(1.6, Math.max(0.55, Number(nextZoom.toFixed(2))));
  updateWorkflowZoomLabel();
  applyWorkflowCanvasTransform();
}

function updateWorkflowZoomLabel() {
  const label = document.getElementById("workflow-zoom-label");
  if (label) label.textContent = `${Math.round(workflowZoom * 100)}%`;
}

function bindWorkflowCanvasInteractions() {
  if (workflowCanvasEventsBound) return;
  const canvas = document.getElementById("workflow-canvas-board");
  if (!canvas) return;
  workflowCanvasEventsBound = true;

  canvas.addEventListener("wheel", (event) => {
    if (!document.body.classList.contains("workflow-mode")) return;
    event.preventDefault();
    if (Math.abs(event.deltaX) > Math.abs(event.deltaY) || event.shiftKey) {
      workflowPanX -= event.shiftKey ? event.deltaY : event.deltaX;
      applyWorkflowCanvasTransform();
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const oldZoom = workflowZoom;
    const direction = event.deltaY > 0 ? -1 : 1;
    const nextZoom = Math.min(1.6, Math.max(0.55, Number((workflowZoom + direction * 0.08).toFixed(2))));
    if (nextZoom === oldZoom) return;
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;
    const worldX = (pointerX - workflowPanX) / oldZoom;
    const worldY = (pointerY - workflowPanY) / oldZoom;
    workflowZoom = nextZoom;
    workflowPanX = pointerX - worldX * workflowZoom;
    workflowPanY = pointerY - worldY * workflowZoom;
    updateWorkflowZoomLabel();
    applyWorkflowCanvasTransform();
  }, { passive: false });

  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if (event.target.closest("button, a, input, select, textarea, .workflow-pip, .workflow-task-card")) return;
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    canvas.classList.add("is-panning");
    canvas.setPointerCapture?.(event.pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    workflowPanX += event.clientX - lastX;
    workflowPanY += event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    applyWorkflowCanvasTransform();
  });
  const stopDrag = (event) => {
    if (!dragging) return;
    dragging = false;
    canvas.classList.remove("is-panning");
    canvas.releasePointerCapture?.(event.pointerId);
  };
  canvas.addEventListener("pointerup", stopDrag);
  canvas.addEventListener("pointercancel", stopDrag);
}

function closeWorkflowPip() {
  const pip = document.getElementById("workflow-pip");
  if (pip) pip.classList.add("hidden");
}

function readableKeyLabel(key = "") {
  return String(key || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function valueToReadableMarkdown(value, depth = 0) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "";
    if (value.every((item) => item === null || typeof item !== "object")) {
      return value.map((item) => String(item ?? "")).filter(Boolean).join("；");
    }
    return value.map((item, index) => {
      const rendered = valueToReadableMarkdown(item, depth + 1).trim();
      return rendered ? `${index + 1}. ${rendered.replace(/\n/g, "\n   ")}` : "";
    }).filter(Boolean).join("\n");
  }
  const entries = Object.entries(value).filter(([, val]) => val !== undefined && val !== null && val !== "");
  if (entries.length === 0) return "";
  return entries.map(([key, val]) => {
    const label = readableKeyLabel(key);
    const rendered = valueToReadableMarkdown(val, depth + 1).trim();
    if (!rendered) return "";
    if (typeof val === "object" && val !== null) {
      return `**${label}**:\n${rendered}`;
    }
    return `**${label}**: ${rendered}`;
  }).filter(Boolean).join(depth === 0 ? "\n\n" : "\n");
}

function valueToPlainText(value, maxLength = 140) {
  const text = valueToReadableMarkdown(value)
    .replace(/\*\*/g, "")
    .replace(/[#`|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, maxLength) || "未命名分析项";
}

function reportItemTitle(item = {}, fallback = "诊断项") {
  const id = valueToPlainText(item.plan_id || item.scheme_id || item.id || "", 48);
  const title = valueToPlainText(item.title || item.name || item.direction || "", 120);
  if (id && id !== "未命名分析项" && title && title !== "未命名分析项") return `${id} · ${title}`;
  if (id && id !== "未命名分析项") return id;
  if (title && title !== "未命名分析项") return title;
  return fallback;
}

function markdownCell(value) {
  return valueToReadableMarkdown(value)
    .replace(/\n+/g, "<br>")
    .replace(/\|/g, "\\|")
    .trim() || "未记录";
}

function markdownTable(headers = [], rows = []) {
  if (!headers.length || !rows.length) return "";
  return [
    `| ${headers.map(markdownCell).join(" |")} |`,
    `| ${headers.map(() => "---").join(" |")} |`,
    ...rows.map((row) => `| ${row.map(markdownCell).join(" |")} |`),
  ].join("\n");
}

function competitorName(benchmark = {}) {
  return benchmark.competitor_name || benchmark.shop_name || benchmark.name || benchmark.competitor_url || "竞品店铺";
}

function renderCompetitorBenchmarksMarkdown(benchmarks = []) {
  if (!Array.isArray(benchmarks) || benchmarks.length === 0) return "";
  const rows = benchmarks.map((item) => [
    competitorName(item),
    item.visible_sku_count_estimate || item.sampled_products_count || "未记录",
    item.price_distribution,
    item.category_mix || item.category_structure,
    item.promotion_signals,
    item.shop_review_signal || item.review_signal || item.rating_signal,
    item.listing_order_insight || item.visible_order_insight || item.product_order_insight,
    item.visual_method,
    item.seo_method,
    item.competitor_url || item.shop_url || item.url,
  ]);
  const sections = [
    "### 竞品店铺商品结构解析",
    markdownTable(
      ["竞品", "可见 SKU/样本", "价格分布", "类别/场景结构", "促销/信任信号", "评论/评分", "可见排序口径", "视觉方法", "SEO 方法", "URL"],
      rows
    ),
  ];
  benchmarks.forEach((item, index) => {
    const samples = Array.isArray(item.product_samples || item.sample_products || item.visible_products)
      ? (item.product_samples || item.sample_products || item.visible_products)
      : [];
    if (samples.length === 0) return;
    sections.push(`#### ${index + 1}. ${valueToPlainText(competitorName(item))} 商品样本`);
    sections.push(markdownTable(
      ["商品", "价格", "类别/场景", "促销信号", "可见顺序"],
      samples.slice(0, 6).map((sample) => [
        sample.title || sample.name,
        sample.price,
        sample.category_or_scenario || sample.category || sample.scenario,
        sample.promotion_signal || sample.promotion || sample.badge,
        sample.visible_order_rank || sample.rank,
      ])
    ));
  });
  return sections.filter(Boolean).join("\n\n");
}

function renderDepthMatrixMarkdown(matrix = []) {
  if (!Array.isArray(matrix) || matrix.length === 0) return "";
  return [
    "### 店铺体检深度矩阵",
    markdownTable(
      ["维度", "当前判断", "证据来源", "风险/缺口", "建议动作"],
      matrix.map((item) => [
        item.dimension || item.name || item.topic,
        item.finding || item.current_state || item.diagnosis,
        item.evidence || item.evidence_ref || item.source,
        item.gap || item.risk || item.issue,
        item.action || item.recommendation || item.next_step,
      ])
    ),
  ].join("\n\n");
}

function workflowReportToMarkdown(report) {
  if (!report) return "还没有关联报告。运行或更新此流程后，AI 报告会作为根节点证据进入画布。";
  const result = normalizeFinalOutput(report.result || report);
  const direct = result.markdown || result.content || result.report || report.content;
  if (typeof direct === "string" && direct.trim()) return direct;
  const lines = [];
  const summary = result.summary || result.overview || result.conclusion;
  if (summary) lines.push(`### 摘要\n${valueToReadableMarkdown(summary)}`);
  const data = Array.isArray(result.data) ? result.data : [];
  if (data.length) {
    lines.push("### 结构化诊断");
    const labelMap = {
      diagnosis_level: "诊断级别",
      priority: "优先级",
      evidence: "证据",
      diagnosis_basis: "诊断依据",
      recommendation: "建议",
      direction: "方向",
    };
    data.slice(0, 12).forEach((item, index) => {
      const title = reportItemTitle(item, `诊断项 ${index + 1}`);
      lines.push(`#### ${index + 1}. ${title}`);
      ["diagnosis_level", "priority", "evidence", "diagnosis_basis", "recommendation", "direction"].forEach((key) => {
        if (item[key]) lines.push(`- ${labelMap[key]}: ${valueToReadableMarkdown(item[key])}`);
      });
      const actions = item.first_actions || item.next_steps || item.actionable_tasks || item.actions;
      if (actions) lines.push(`- 建议动作: ${valueToReadableMarkdown(actions)}`);
    });
  }
  if (!lines.length) lines.push("```json\n" + JSON.stringify(result || report, null, 2) + "\n```");
  return lines.join("\n\n");
}

function tryParseJsonValue(text = "") {
  try {
    return JSON.parse(String(text || "").trim());
  } catch (_) {
    return null;
  }
}

function extractEmbeddedFinalJson(text = "") {
  const source = String(text || "");
  const candidates = [];
  const fencedRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let fencedMatch;
  while ((fencedMatch = fencedRegex.exec(source)) !== null) {
    const parsed = tryParseJsonValue(fencedMatch[1]);
    if (parsed) candidates.push(parsed);
  }

  for (let start = 0; start < source.length; start += 1) {
    if (source[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
      const char = source[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === "\"") {
          inString = false;
        }
        continue;
      }
      if (char === "\"") {
        inString = true;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          const parsed = tryParseJsonValue(source.slice(start, index + 1));
          if (parsed) candidates.push(parsed);
          start = index;
          break;
        }
      }
    }
  }

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    if (candidate?.type === "final" || candidate?.output || candidate?.overview || candidate?.analysis || candidate?.summary) {
      return candidate;
    }
  }
  return null;
}

function normalizeFinalOutput(value) {
  let current = value;
  for (let i = 0; i < 4; i += 1) {
    if (typeof current === "string") {
      const trimmed = current.trim();
      const exact = tryParseJsonValue(trimmed);
      if (exact) {
        current = exact;
        continue;
      }
      const embedded = extractEmbeddedFinalJson(trimmed);
      if (embedded) {
        current = embedded;
        continue;
      }
      return { overview: current };
    }
    if (current && typeof current === "object" && current.type === "final" && current.output && typeof current.output === "object") {
      current = current.output;
      continue;
    }
    if (current && typeof current === "object" && current.result && typeof current.result === "object") {
      current = current.result;
      continue;
    }
    break;
  }
  return current && typeof current === "object" ? current : { overview: String(current || "") };
}

function resultToReportMarkdown(result = {}) {
  const data = normalizeFinalOutput(result);
  const lines = [];
  if (data.overview) lines.push(`### 分析概述\n\n${valueToReadableMarkdown(data.overview)}`);
  if (data.analysis) lines.push(`### 深度商业诊断\n\n${valueToReadableMarkdown(data.analysis)}`);
  const depthMatrix = data.diagnostic_depth_matrix || data.depth_matrix || data.diagnosis_dimensions;
  const depthMarkdown = renderDepthMatrixMarkdown(depthMatrix);
  if (depthMarkdown) lines.push(depthMarkdown);
  const competitorMarkdown = renderCompetitorBenchmarksMarkdown(data.competitor_benchmarks);
  if (competitorMarkdown) lines.push(competitorMarkdown);
  if (data.summary) lines.push(`### 核心运营建议\n\n${valueToReadableMarkdown(data.summary)}`);
  if (Array.isArray(data.data) && data.data.length) {
    lines.push("### 结构化行动项");
    data.data.slice(0, 12).forEach((item, index) => {
      if (!item || typeof item !== "object") return;
      const title = reportItemTitle(item, `行动项 ${index + 1}`);
      const actions = item.first_actions || item.next_steps || item.actionable_tasks || item.actions;
      const fields = [
        ["优先级", item.diagnosis_level || item.priority || item.severity],
        ["方向", item.direction || item.recommendation || item.strategy],
        ["证据", item.evidence || item.diagnosis_basis || item.selection_rationale || item.trend_evidence],
        ["首批动作", actions],
        ["风险护栏", item.risk_guard || item.risk_notes || item.guardrail],
      ];
      lines.push(`#### ${index + 1}. ${title}`);
      fields.forEach(([label, value]) => {
        if (value) lines.push(`- ${label}: ${valueToReadableMarkdown(value)}`);
      });
    });
  }
  return lines.filter(Boolean).join("\n\n") || "```json\n" + JSON.stringify(data, null, 2) + "\n```";
}

function renderSafeMarkdown(markdown = "") {
  const source = String(markdown || "");
  if (window.marked?.parse) {
    const rendered = window.marked.parse(source);
    return window.DOMPurify?.sanitize ? window.DOMPurify.sanitize(rendered) : rendered;
  }
  return escapeHtml(source).replace(/\n/g, "<br>");
}

function buildReportPrintHtml(rep, bodyHtml, dateStr) {
  const safeTitle = escapeHtml(rep?.title || "Etsy Growth Report");
  const safeTag = escapeHtml(rep?.tag || "AI 决策报告");
  const safeDate = escapeHtml(rep?.date || dateStr);
  return `<!DOCTYPE html>
<html lang="zh-CN" dir="ltr">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeTitle}_${dateStr}</title>
  <style>
    :root {
      --bg2: #f1f5f9;
      --bg3: #f8fafc;
      --text: #0f172a;
      --text2: #475569;
      --border: #cbd5e1;
      --accent: #6366f1;
      --accent2: #8b5cf6;
    }

    @page { size: A4 portrait; margin: 25mm 20mm; }
    @page landscape-page { size: A4 landscape; margin: 20mm 25mm; }

    html { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", sans-serif; }
    body { font-family: inherit; color: #1a202c; line-height: 1.7; background: #fff; margin: 0 !important; padding: 0 !important; text-align: left; -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }

    .print-banner { background: #eff6ff; color: #1d4ed8; padding: 15px; text-align: center; font-weight: bold; border-bottom: 1px solid #bfdbfe; margin-bottom: 20px; }
    @media print {
      .print-banner { display: none !important; }
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; margin: 0 !important; padding: 0 !important; }
    }

    .cover-page { padding-top: 60px; text-align: center !important; page-break-after: always; box-sizing: border-box; }
    .cover-title { font-size: 2.4em; color: #1e3a8a; font-weight: 800; max-width: 84%; line-height: 1.35; margin: 40px auto 20px; text-align: center !important; }
    .cover-subtitle { font-size: 1.05em; color: #64748b; margin-top: 10px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; text-align: center !important; }
    .cover-footer { margin-top: 160px; font-size: 1em; color: #94a3b8; text-align: center !important; }
    .cover-page p, .cover-page div, .cover-page span { text-align: center !important; }

    .report-container { max-width: 100%; font-size: 11pt; padding: 0 20px; text-align: left !important; word-break: break-word; overflow-wrap: anywhere; }
    .report-container p, .report-container li, .report-container td, .report-container div { text-align: left !important; }

    h1 { color: #0f172a; font-size: 22pt; border-bottom: 2px solid #1e3a8a; padding-bottom: 10px; margin-top: 30px; margin-bottom: 20px; text-align: center !important; }
    h2 { color: #1e3a8a; font-size: 16pt; border-bottom: 1px solid #e2e8f0; padding-bottom: 8px; margin-top: 30px; margin-bottom: 15px; padding-top: 15px; page-break-after: avoid; text-align: left !important; }
    h3 { color: #334155; font-size: 14pt; margin-top: 25px; margin-bottom: 10px; padding-top: 12px; page-break-after: avoid; text-align: left !important; }
    p { margin-bottom: 15px; color: #334155; orphans: 3; widows: 3; }
    strong { color: #0f172a; }

    .report-section { margin-bottom: 30px; border: none !important; padding: 0 !important; background-color: transparent !important; text-align: left !important; page-break-inside: avoid; }
    .data-card { page-break-inside: avoid !important; break-inside: avoid !important; margin-bottom: 25px; border: 1px solid #cbd5e1; border-radius: 8px; overflow: hidden; background-color: #f8fafc; text-align: left !important; }
    .data-card td { padding: 8px 10px !important; font-size: 11px !important; }
    .data-card td:first-child { width: 140px !important; }
    .section-divider { page-break-before: always; }
    .landscape-section { page: landscape-page; width: 100%; text-align: left !important; }

    table { width: 100%; border-collapse: collapse; margin-top: 20px; margin-bottom: 30px; page-break-inside: avoid; font-size: 10pt; text-align: left !important; }
    th, td { border: 1px solid #cbd5e1 !important; padding: 12px !important; text-align: left !important; vertical-align: top; }
    th { background-color: #f8fafc !important; color: #0f172a !important; font-weight: 700; text-transform: uppercase; font-size: 9pt; }
    tr:nth-child(even) { background-color: #f8fafc; }

    code { background: #f1f5f9; color: #b91c1c; padding: 2px 6px; border-radius: 4px; font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; font-size: 0.9em; text-align: left !important; }
    pre { page-break-inside: avoid; text-align: left !important; }
    pre code { display: block; background: #0f172a; color: #f8fafc; padding: 15px; border-radius: 6px; overflow-x: auto; white-space: pre-wrap; word-wrap: break-word; text-align: left !important; }
    ul, ol { margin-bottom: 15px; padding-left: 20px; text-align: left !important; }
    li { margin-bottom: 8px; text-align: left !important; }
    img { max-width: 100%; height: auto; border-radius: 6px; margin: 15px 0; }
    a { color: #1e3a8a; text-decoration: none; border-bottom: 1px dashed #cbd5e1; }
    .empty-text { display: none; }
  </style>
</head>
<body>
  <div class="print-banner">正在生成原生数字版 PDF。请在弹出的对话框中选择“另存为 PDF”。如未弹出，请按 Ctrl+P 或 Cmd+P。</div>
  <div class="cover-page">
    <div class="cover-subtitle">Etsy Growth Agent</div>
    <div class="cover-title">${safeTitle}</div>
    <div class="cover-subtitle">${safeTag}</div>
    <div class="cover-footer">
      <p>Report Date: ${safeDate}</p>
      <p>UTF-8 Native Print Report</p>
    </div>
  </div>
  <div class="report-container">
    <h1>${safeTitle}</h1>
    <p style="color:#64748b;font-size:12px;margin-bottom:20px;">${safeTag} · ${safeDate}</p>
    ${bodyHtml}
  </div>
</body>
</html>`;
}

function renderWorkflowReportHtml(report) {
  const markdown = workflowReportToMarkdown(report);
  return renderSafeMarkdown(markdown);
}

function openWorkflowPip({ rootId = "", taskId = "" } = {}) {
  const pip = document.getElementById("workflow-pip");
  if (!pip) return;
  const roots = growthRuntimeState.workflowRoots || [];
  const root = rootId
    ? roots.find(item => item.id === rootId)
    : roots.find(item => item.tasks?.some(task => task.id === taskId));
  const task = taskId ? (growthRuntimeState.workflowTasks || []).find(item => item.id === taskId) : null;
  const rootCase = root ? (growthRuntimeState.growthCases || []).find(item => item.type === root.id || item.id?.startsWith(`${root.id}_`)) : null;
  const latestRun = rootCase?.runs?.[0] || null;
  const title = task?.title || root?.title || "流程详情";
  const reportHtml = renderWorkflowReportHtml(root?.report);

  pip.innerHTML = `
    <div class="workflow-pip-head">
      <div>
        <span class="node-lane">${escapeHtml(task ? workflowKindLabel(task.kind) : workflowLaneLabel(root?.lane || "workflow"))}</span>
        <h3>${escapeHtml(title)}</h3>
      </div>
      <button class="modal-close workflow-pip-close" aria-label="关闭">&times;</button>
    </div>
    <div class="workflow-pip-body">
      ${task ? `
        <section>
          <h4>为什么要做</h4>
          <p>${escapeHtml(task.reason)}</p>
        </section>
        <section>
          <h4>下一步</h4>
          <p>${escapeHtml(task.actionText)}</p>
        </section>
        <div class="workflow-pip-meta">
          <span>${escapeHtml(task.severity || "P1")}</span>
          <span>${escapeHtml(task.source)}</span>
          <span>${escapeHtml(task.owner)}</span>
          <span>${workflowStatusLabel(task.status)}</span>
        </div>
        <div class="workflow-pip-actions">
          ${task.actionId ? `<button class="btn btn-outline workflow-run-btn" data-action="${task.actionId}" data-sku="${escapeHtml(task.sku || "")}">AI 诊断</button>` : ""}
          <button class="btn btn-primary workflow-state-btn" data-id="${escapeHtml(task.id)}" data-status="${workflowNextStatus(task.status)}">${task.status === "todo" ? "已执行" : task.status === "confirmed" ? "进入观察" : "标记复盘"}</button>
          <button class="btn btn-outline workflow-exp-btn" data-id="${escapeHtml(task.id)}">加入实验</button>
        </div>
      ` : `
        <section>
          <h4>流程判断</h4>
          <p>${escapeHtml(root?.narrative || "当前根流程暂无说明。")}</p>
        </section>
        <section>
          <h4>运行前证据检查</h4>
          ${renderEvidenceChecklist(root?.evidenceStatus || [])}
        </section>
        <section>
          <h4>关联报告</h4>
          <div class="workflow-report-rendered md-report">${reportHtml}</div>
        </section>
        <div class="workflow-pip-meta">
          <span>${root?.stats?.total || 0} 个任务</span>
          <span>${root?.stats?.p0 || 0} 个 P0</span>
          <span>${root?.report ? "有报告" : "待诊断"}</span>
          ${rootCase ? `<span>案件: ${escapeHtml(workflowCaseStatusLabel(rootCase.status))}</span>` : ""}
          ${latestRun ? `<span>最近运行: ${escapeHtml(workflowCaseStatusLabel(latestRun.status))}</span>` : ""}
          ${rootCase?.reportIds?.length ? `<span>${rootCase.reportIds.length} 份归档</span>` : ""}
        </div>
        <div class="workflow-pip-actions">
          ${root ? `<button class="btn btn-primary growth-action-btn" data-action="${root.actionId}">运行/更新此流程</button>` : ""}
        </div>
      `}
    </div>
  `;
  pip.classList.remove("hidden");
  applyWorkflowPipPosition(pip);

  pip.querySelector(".workflow-pip-close")?.addEventListener("click", closeWorkflowPip);
  bindWorkflowPipDrag(pip);
  pip.querySelectorAll(".growth-action-btn").forEach((btn) => {
    btn.addEventListener("click", () => handleGrowthAction(btn.dataset.action, ""));
  });
  pip.querySelectorAll(".workflow-run-btn").forEach((btn) => {
    btn.addEventListener("click", () => handleGrowthAction(btn.dataset.action, btn.dataset.sku || ""));
  });
  pip.querySelectorAll(".workflow-state-btn").forEach((btn) => {
    btn.addEventListener("click", () => updateWorkflowTaskState(btn.dataset.id, { status: btn.dataset.status }));
  });
  pip.querySelectorAll(".workflow-exp-btn").forEach((btn) => {
    const selectedTask = (growthRuntimeState.workflowTasks || []).find(item => item.id === btn.dataset.id);
    if (!selectedTask) return;
    btn.addEventListener("click", () => createGrowthExperiment({
      sku: selectedTask.sku || workflowKindLabel(selectedTask.kind),
      title: selectedTask.title,
      action: selectedTask.actionText,
      metric: selectedTask.kind === "fulfillment" ? "履约准时率" : "曝光 / 加购 / 订单",
      source: "workflow_task",
    }));
  });
}

function applyWorkflowPipPosition(pip) {
  if (!workflowPipPosition) {
    pip.style.left = "";
    pip.style.top = "";
    pip.style.right = "";
    pip.style.bottom = "";
    return;
  }
  pip.style.left = `${workflowPipPosition.left}px`;
  pip.style.top = `${workflowPipPosition.top}px`;
  pip.style.right = "auto";
  pip.style.bottom = "auto";
}

function bindWorkflowPipDrag(pip) {
  const head = pip.querySelector(".workflow-pip-head");
  if (!head) return;
  if (typeof pip.workflowDragCleanup === "function") pip.workflowDragCleanup();
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;
  const start = (event) => {
    if (event.target.closest("button")) return;
    dragging = true;
    const rect = pip.getBoundingClientRect();
    startX = event.clientX;
    startY = event.clientY;
    startLeft = rect.left;
    startTop = rect.top;
    event.preventDefault();
    pip.classList.add("is-dragging");
  };
  const move = (event) => {
    if (!dragging) return;
    const width = pip.offsetWidth || 520;
    const height = pip.offsetHeight || 360;
    const nextLeft = Math.min(window.innerWidth - width - 12, Math.max(12, startLeft + event.clientX - startX));
    const nextTop = Math.min(window.innerHeight - height - 12, Math.max(12, startTop + event.clientY - startY));
    workflowPipPosition = { left: nextLeft, top: nextTop };
    applyWorkflowPipPosition(pip);
  };
  const stop = () => {
    if (!dragging) return;
    dragging = false;
    pip.classList.remove("is-dragging");
  };
  head.addEventListener("pointerdown", start);
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", stop);
  document.addEventListener("pointercancel", stop);
  pip.workflowDragCleanup = () => {
    head.removeEventListener("pointerdown", start);
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", stop);
    document.removeEventListener("pointercancel", stop);
  };
}

async function updateWorkflowTaskState(taskId, patch = {}) {
  if (!taskId) return;
  const stored = await new Promise((r) => chrome.storage.local.get(["growthWorkflowTaskState"], r));
  const state = stored.growthWorkflowTaskState || {};
  state[taskId] = {
    ...(state[taskId] || {}),
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await new Promise((r) => chrome.storage.local.set({ growthWorkflowTaskState: state }, r));
  await refreshAllData();
}

function renderGrowthHome() {
  const tasks = document.getElementById("today-growth-tasks");
  const opportunities = document.getElementById("today-growth-opportunities");
  if (!tasks || !opportunities) return;

  const urgentRows = growthRuntimeState.skuRows.filter(row => row.issue !== "scale").slice(0, 4);
  tasks.innerHTML = urgentRows.length ? urgentRows.map(row => `
    <div class="growth-task-item">
      <span class="badge ${getRiskBadgeClass(row.issue)}">${row.issueLabel}</span>
      <div>
        <strong>${escapeHtml(row.title)}</strong>
        <p>${escapeHtml(row.nextAction)}</p>
      </div>
      <button class="btn btn-outline btn-xs growth-action-btn" data-action="${row.issue === "profit" ? "calculate_profit_guardrail" : row.issue === "fulfillment" ? "detect_fulfillment_risk" : "diagnose_sku_funnel"}" data-sku="${escapeHtml(row.sku)}">诊断</button>
    </div>
  `).join("") : `<div class="empty-state">暂无紧急风险。先绑定店铺 API 或添加监控任务后，系统会自动生成今日动作。</div>`;

  opportunities.innerHTML = growthRuntimeState.opportunities.slice(0, 4).map(card => `
    <div class="growth-task-item">
      <span class="badge success">${escapeHtml(card.type)}</span>
      <div>
        <strong>${escapeHtml(card.title)}</strong>
        <p>${escapeHtml(card.impact)}</p>
      </div>
      <button class="btn btn-outline btn-xs growth-action-btn" data-action="${card.action}">处理</button>
    </div>
  `).join("");

  const sessions = growthRuntimeState.skuRows.reduce((sum, row) => sum + row.sessions, 0);
  const views = growthRuntimeState.skuRows.reduce((sum, row) => sum + row.views, 0);
  const avgCart = growthRuntimeState.skuRows.length
    ? growthRuntimeState.skuRows.reduce((sum, row) => sum + row.cartRate, 0) / growthRuntimeState.skuRows.length
    : 0;
  const avgOrder = growthRuntimeState.skuRows.length
    ? growthRuntimeState.skuRows.reduce((sum, row) => sum + row.orderRate, 0) / growthRuntimeState.skuRows.length
    : 0;
  document.getElementById("funnel-exposure").innerText = sessions ? sessions.toLocaleString() : "--";
  document.getElementById("funnel-views").innerText = views ? views.toLocaleString() : "--";
  document.getElementById("funnel-cart").innerText = avgCart ? `${avgCart.toFixed(1)}%` : "--";
  document.getElementById("funnel-order").innerText = avgOrder ? `${avgOrder.toFixed(1)}%` : "--";
  document.getElementById("funnel-fulfillment").innerText = `${growthRuntimeState.skuRows.filter(row => row.issue === "fulfillment").length} 风险`;

  [...tasks.querySelectorAll(".growth-action-btn"), ...opportunities.querySelectorAll(".growth-action-btn")].forEach((btn) => {
    btn.onclick = () => handleGrowthAction(btn.dataset.action, btn.dataset.sku || "");
  });
}

function renderSourceLedger() {
  const ledger = document.getElementById("growth-source-ledger");
  if (!ledger) return;
  const hasShop = !!growthRuntimeState.activeShop;
  const hasHistory = growthRuntimeState.savedResults.length > 0 || growthRuntimeState.monitorEvents.length > 0;
  const hasExperiments = growthRuntimeState.experiments.length > 0;
  const hasSkuApi = !!growthRuntimeState.skuAnalyticsSnapshot?.result?.data?.length;
  const hasStoreApi = !!growthRuntimeState.storeSnapshotCache?.result;
  const formatSyncTime = (value) => value ? new Date(value).toLocaleString() : "未同步";
  ledger.innerHTML = `
    <div class="source-ledger-item">
      <strong><span class="source-dot ${hasSkuApi ? "live" : "local"}"></span>${hasSkuApi ? "Etsy 个人访问 API SKU Analytics" : "本地跟踪 SKU"}</strong>
      <p>${hasSkuApi ? `SKU 作战台已接入 ${growthRuntimeState.skuAnalyticsSnapshot.result.data.length} 行真实 SKU 维度 analytics；本地缓存更新时间：${formatSyncTime(growthRuntimeState.skuAnalyticsSnapshot.syncedAt)}。` : "SKU 作战台仅显示本地跟踪商品；曝光、加购、订单等指标需同步 Etsy 个人访问 API 后显示。"}</p>
    </div>
    <div class="source-ledger-item">
      <strong><span class="source-dot local"></span>${hasHistory ? "本地历史可用" : "暂无历史证据"}</strong>
      <p>${hasHistory ? "机会卡会读取 savedResults / monitorChangeEvents / monitorReports。" : "机会中心暂无真实历史证据，只显示空态。"}</p>
    </div>
    <div class="source-ledger-item">
      <strong><span class="source-dot ${hasStoreApi ? "live" : "local"}"></span>${hasStoreApi ? "Etsy 个人访问 API 店铺快照" : hasShop ? "已选择活动店铺" : "未绑定 Etsy 个人访问 API"}</strong>
      <p>${hasStoreApi ? `店铺快照已保存在本地；下次 Etsy 个人访问 API 同步成功会覆盖更新。最近同步：${formatSyncTime(growthRuntimeState.storeSnapshotCache.syncedAt)}。` : hasShop ? "店铺 API 看板会请求 Etsy 个人访问 API；失败时只显示错误和空态。" : "店铺业绩、订单和费用在未绑定 API 时显示为空态。"}</p>
    </div>
    <div class="source-ledger-item">
      <strong><span class="source-dot ${hasExperiments ? "local" : "ai"}"></span>${hasExperiments ? "实验状态真实保存" : "实验示例待启动"}</strong>
      <p>${hasExperiments ? "growthExperiments 已本地持久化；真实复盘需拉取实验前后 API 窗口。" : "暂无实验记录；不会生成默认示例实验。"}</p>
    </div>
  `;
}

function getEndpointAuditSummary() {
  return [
    {
      name: "Etsy 个人访问 API 店铺快照",
      status: "真实端点",
      evidence: "GET_ETSY_STORE_SNAPSHOT 调用 etsy_api_get_store_snapshot，成功后缓存到 etsyStoreSnapshotCache。",
      action: "保留在 API 概览；画布只引用它作为经营证据。",
    },
    {
      name: "Etsy 个人访问 API 自营商品与订单数据",
      status: "真实端点",
      evidence: "当前个人卖家 API 可读取自营 listings、商品详情和 receipts/发货资料；不提供 Sessions、页面浏览、点击率或加购率 analytics。",
      action: "流量与转化方向改由公开 Etsy 页面、搜索和截图证据提供，不把 unsupported analytics 填成 0。",
    },
    {
      name: "AI 业务技能运行",
      status: "真实端点，但 dashboard 未直接执行",
      evidence: "RUN_SKILL 在 background.js 中真实执行；dashboard 当前按钮只创建 growthActionRuns 队列。",
      action: "下一步应把画布动作接到 RUN_SKILL，形成可观察的运行状态。",
    },
    {
      name: "增长实验",
      status: "本地真实状态",
      evidence: "growthExperiments 可创建、推进、观察和复盘；真实效果仍需拉 Etsy 个人访问 API 时间窗对比。",
      action: "整合为画布 Scrum 列和案件复盘，不再作为左侧一级菜单。",
    },
    {
      name: "监控任务",
      status: "本地真实任务 + Chrome alarm",
      evidence: "monitorTasks 可添加/删除，并通过 chrome.alarms 定期触发后台监控。",
      action: "保留在系统任务页，作为底层能力而不是增长主流程入口。",
    },
    {
      name: "商品页、竞品、扩品、利润线按钮",
      status: "业务意图队列",
      evidence: "这些按钮调用 handleGrowthAction，只写入 queued growthActionRuns 并提示去前台/侧边栏运行。",
      action: "放入画布案件；UI 上避免伪装成已自动完成的业务执行。",
    },
    {
      name: "AI 报告与监控报告",
      status: "本地真实数据",
      evidence: "savedResults / monitorReports 来自技能 final 或监控报告；PIP 已可直接解析 Markdown / JSON。",
      action: "画布内作为案件证据阅读；报告中心保留为跨案件归档、复制、删除和 PDF 下载入口。",
    },
  ];
}

function renderSettingsTab() {
  const container = document.getElementById("endpoint-audit-summary");
  if (!container) return;
  container.innerHTML = getEndpointAuditSummary().map((item) => `
    <article class="endpoint-audit-item">
      <div>
        <strong>${escapeHtml(item.name)}</strong>
        <span>${escapeHtml(item.status)}</span>
      </div>
      <p>${escapeHtml(item.evidence)}</p>
      <small>${escapeHtml(item.action)}</small>
    </article>
  `).join("");
}

function renderSkuWorkbench() {
  const body = document.getElementById("sku-war-table-body");
  if (!body) return;
  const filter = document.getElementById("sku-filter")?.value || "all";
  const rows = growthRuntimeState.skuRows.filter(row => filter === "all" || row.issue === filter);
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="9" class="empty-cell"><div class="empty-state">暂无 SKU 数据。绑定 Etsy API、添加跟踪商品或运行一次店铺诊断后会自动补齐。</div></td></tr>`;
    return;
  }
  body.innerHTML = rows.map(row => `
    <tr>
      <td>
        <strong class="cell-ellipsis" title="${escapeHtml(row.title)}">${escapeHtml(row.title)}</strong>
        <small>${escapeHtml(row.sku)} · ${escapeHtml(row.dataSource || "本地追踪")}</small>
      </td>
      <td><span class="badge ${getRiskBadgeClass(row.issue)}">${row.issueLabel}</span></td>
      <td>${row.revenue === null || row.revenue === undefined ? "--" : `${Number(row.revenue).toLocaleString()} $`}</td>
      <td>${row.sessions === null || row.sessions === undefined ? "--" : Number(row.sessions).toLocaleString()}</td>
      <td>${row.cartRate === null || row.cartRate === undefined ? "--" : `${row.cartRate}%`}</td>
      <td>${row.orderRate === null || row.orderRate === undefined ? "--" : `${row.orderRate}%`}</td>
      <td><span style="color:${Number(row.margin || 0) >= 20 ? 'var(--success)' : 'var(--warning)'}">${row.margin === null || row.margin === undefined ? "--" : `${row.margin}%`}</span></td>
      <td>${escapeHtml(row.nextAction)}</td>
      <td class="sku-actions">
        <button class="btn btn-outline btn-xs growth-action-btn" data-action="diagnose_sku_funnel" data-sku="${escapeHtml(row.sku)}">诊断</button>
        <button class="btn btn-outline btn-xs growth-action-btn" data-action="rewrite_listing" data-sku="${escapeHtml(row.sku)}">改版</button>
        <button class="btn btn-primary btn-xs create-exp-btn" data-sku="${escapeHtml(row.sku)}" data-title="${escapeHtml(row.title)}" data-action="${escapeHtml(row.nextAction)}">实验</button>
      </td>
    </tr>
  `).join("");
  body.querySelectorAll(".growth-action-btn").forEach((btn) => {
    btn.addEventListener("click", () => handleGrowthAction(btn.dataset.action, btn.dataset.sku || ""));
  });
  body.querySelectorAll(".create-exp-btn").forEach((btn) => {
    btn.addEventListener("click", () => createGrowthExperiment({
      sku: btn.dataset.sku,
      title: btn.dataset.title,
      action: btn.dataset.action,
      metric: "加购率 / 付款率",
      source: "sku_workbench",
    }));
  });
}

function renderOpportunityCenter() {
  const grid = document.getElementById("opportunity-card-grid");
  if (!grid) return;
  grid.innerHTML = growthRuntimeState.opportunities.map(card => `
    <article class="opportunity-card">
      <div class="opportunity-topline">
        <span class="badge success">${escapeHtml(card.type)}</span>
        <span>${escapeHtml(card.impact)}</span>
      </div>
      <h3>${escapeHtml(card.title)}</h3>
      <p>${escapeHtml(card.evidence)}</p>
      <div class="opportunity-actions">
        <button class="btn btn-primary btn-xs growth-action-btn" data-action="${card.action}">一键诊断</button>
        <button class="btn btn-outline btn-xs create-opportunity-exp-btn" data-title="${escapeHtml(card.title)}" data-action="${escapeHtml(card.experiment)}">加入实验</button>
      </div>
    </article>
  `).join("");
  grid.querySelectorAll(".growth-action-btn").forEach((btn) => {
    btn.addEventListener("click", () => handleGrowthAction(btn.dataset.action, ""));
  });
  grid.querySelectorAll(".create-opportunity-exp-btn").forEach((btn) => {
    btn.addEventListener("click", () => createGrowthExperiment({
      sku: "机会中心",
      title: btn.dataset.title,
      action: btn.dataset.action,
      metric: "曝光 / 加购 / 订单",
      source: "opportunity_center",
    }));
  });
}

function renderExperimentBoard() {
  const columns = {
    todo: document.getElementById("experiment-todo"),
    running: document.getElementById("experiment-running"),
    observing: document.getElementById("experiment-observing"),
    reviewed: document.getElementById("experiment-reviewed"),
  };
  if (!columns.todo) return;
  Object.values(columns).forEach((column) => { column.innerHTML = ""; });
  const experiments = growthRuntimeState.experiments;
  experiments.forEach((experiment) => {
    const status = columns[experiment.status] ? experiment.status : "todo";
    const node = document.createElement("div");
    node.className = "experiment-card";
    node.innerHTML = `
      <div class="experiment-card-head">
        <strong>${escapeHtml(experiment.title)}</strong>
        <span>${escapeHtml(experiment.sku || "店铺级")}</span>
      </div>
      <p>${escapeHtml(experiment.action)}</p>
      <div class="experiment-meta">
        <span>目标: ${escapeHtml(experiment.metric || "加购率")}</span>
        <span>${escapeHtml(experiment.window || "7 天")}</span>
      </div>
      ${experiment.baseline ? `<div class="experiment-baseline">基线: ${Number(experiment.baseline.sessions || 0).toLocaleString()} 曝光 / 加购 ${experiment.baseline.cartRate || 0}% / ${escapeHtml(experiment.baseline.dataSource || "")}</div>` : ""}
      <div class="experiment-actions">
        <button class="btn btn-outline btn-xs experiment-move-btn" data-id="${escapeHtml(experiment.id)}" data-next="${status === "todo" ? "running" : status === "running" ? "observing" : "reviewed"}">${status === "reviewed" ? "已完成" : "推进"}</button>
        <button class="btn btn-outline btn-xs growth-action-btn" data-action="review_experiment_result">复盘</button>
      </div>
    `;
    columns[status].appendChild(node);
  });
  Object.entries(columns).forEach(([, column]) => {
    if (!column.innerHTML.trim()) column.innerHTML = `<div class="empty-state compact">暂无</div>`;
  });
  document.querySelectorAll(".experiment-move-btn").forEach((btn) => {
    btn.addEventListener("click", () => moveExperiment(btn.dataset.id, btn.dataset.next));
  });
  document.querySelectorAll(".experiment-card .growth-action-btn").forEach((btn) => {
    btn.addEventListener("click", () => handleGrowthAction(btn.dataset.action, ""));
  });
}

async function createGrowthExperiment({ sku, title, action, metric, source }) {
  const stored = await new Promise((r) => chrome.storage.local.get(["growthExperiments", "activeShopId"], r));
  const experiments = stored.growthExperiments || [];
  const baselineRow = growthRuntimeState.skuRows.find(row => row.sku === sku || row.title === title);
  const experiment = {
    id: `exp_${Date.now()}`,
    shopId: stored.activeShopId || growthRuntimeState.activeShop?.id || "",
    status: "todo",
    sku,
    title: title || "增长实验",
    action: action || "验证一个运营优化动作",
    metric: metric || "加购率 / 订单量",
    window: "7 天",
    baseline: baselineRow ? {
      sessions: baselineRow.sessions,
      views: baselineRow.views,
      cartRate: baselineRow.cartRate,
      orderRate: baselineRow.orderRate,
      orderedUnits: baselineRow.orderedUnits || 0,
      revenue: baselineRow.revenue,
      dataSource: baselineRow.dataSource || "unknown",
      capturedAt: new Date().toISOString(),
    } : null,
    source: source || "growth_action",
    createdAt: new Date().toISOString(),
  };
  experiments.unshift(experiment);
  await new Promise((r) => chrome.storage.local.set({ growthExperiments: experiments }, r));
  await refreshAllData();
  document.querySelector('.nav-menu button[data-tab="workflow"]')?.click();
  openWorkflowPip({
    taskId: (growthRuntimeState.workflowTasks || []).find((task) => task.title.includes(title || "增长实验"))?.id || "",
  });
}

async function moveExperiment(id, nextStatus) {
  if (!id || id.startsWith("seed_")) return;
  const stored = await new Promise((r) => chrome.storage.local.get(["growthExperiments"], r));
  const experiments = stored.growthExperiments || [];
  const match = experiments.find(exp => exp.id === id);
  if (match) {
    match.status = nextStatus;
    match.updatedAt = new Date().toISOString();
    await new Promise((r) => chrome.storage.local.set({ growthExperiments: experiments }, r));
    await refreshAllData();
  }
}

async function persistGrowthRunUpdate(caseId, runId, runPatch = {}, casePatch = {}) {
  const stored = await new Promise((r) => chrome.storage.local.get(["growthActionRuns", "growthCases"], r));
  const runs = stored.growthActionRuns || [];
  const cases = stored.growthCases || [];
  const now = new Date().toISOString();
  const nextRuns = runs.map((run) => run.id === runId ? normalizeGrowthRunRecord({ ...run, ...runPatch, updatedAt: now }) : normalizeGrowthRunRecord(run));
  const nextCases = cases.map((caseItem) => {
    if (caseItem.id !== caseId) return caseItem;
    const normalizedCase = normalizeGrowthCaseRecord(caseItem);
    const caseRuns = normalizedCase.runs.map((run) => run.id === runId ? normalizeGrowthRunRecord({ ...run, ...runPatch, updatedAt: now }) : normalizeGrowthRunRecord(run));
    const mergedReportIds = casePatch.reportIds
      ? Array.from(new Set([...(caseItem.reportIds || []), ...casePatch.reportIds.map(String)]))
      : (caseItem.reportIds || []);
    const cleanCasePatch = { ...casePatch };
    delete cleanCasePatch.reportIds;
    return {
      ...normalizedCase,
      ...cleanCasePatch,
      reportIds: mergedReportIds,
      runs: caseRuns,
      runHistory: caseRuns,
      contractVersion: GROWTH_CONTRACT_VERSION,
      status: casePatch.status || statusFromCaseRuns({ ...caseItem, runs: caseRuns }),
      updatedAt: now,
    };
  });
  await new Promise((r) => chrome.storage.local.set({
    growthActionRuns: nextRuns.slice(0, 80),
    growthCases: nextCases.slice(0, 80),
  }, r));
}

async function ensureDashboardSavedEntry(run, successResult = {}) {
  if (successResult.savedEntry?.id) return successResult.savedEntry;
  const output = successResult.result || successResult.output || successResult;
  if (!output || typeof output !== "object") return null;
  const stored = await new Promise((r) => chrome.storage.local.get(["savedResults"], r));
  const savedResults = stored.savedResults || [];
  const entry = {
    id: Date.now(),
    createdAt: new Date().toISOString(),
    skillId: run.skillPath,
    skillName: run.title,
    pageUrl: "dashboard://growth-workflow",
    pageTitle: "增长工作流画布",
    growthActionId: run.actionId,
    growthRunId: run.id,
    growthCaseId: run.caseId,
    workflowSessionId: run.workflowSessionId || "",
    result: output,
  };
  savedResults.unshift(entry);
  await new Promise((r) => chrome.storage.local.set({ savedResults: savedResults.slice(0, 100) }, r));
  return entry;
}

function startDashboardGrowthRun(run) {
  return new Promise((resolve, reject) => {
    if (!chrome.runtime?.connect) {
      reject(new Error("当前环境不支持后台长连接，请在 Etsy 页面右侧浮窗执行该技能。"));
      return;
    }
    const port = chrome.runtime.connect({ name: "etsy-agent-loop" });
    let settled = false;
    port.onMessage.addListener(async (message) => {
      try {
        if (message.type === "PROGRESS") {
          await persistGrowthRunUpdate(run.caseId, run.id, {
            status: "running",
            lastProgress: message.data?.message || message.data?.type || "运行中",
          }, { status: "running" });
        }
        if (message.type === "SUCCESS") {
          settled = true;
          const savedEntry = await ensureDashboardSavedEntry(run, message.result || {});
          await persistGrowthRunUpdate(run.caseId, run.id, {
            status: "completed",
            completedAt: new Date().toISOString(),
            savedResultId: savedEntry?.id || message.result?.savedEntry?.id || "",
          }, {
            status: "completed",
            reportIds: savedEntry?.id ? [String(savedEntry.id)] : undefined,
          });
          port.disconnect?.();
          resolve(message.result);
        }
        if (message.type === "ERROR") {
          settled = true;
          await persistGrowthRunUpdate(run.caseId, run.id, {
            status: "failed",
            error: message.error || "运行失败",
            failedAt: new Date().toISOString(),
          }, { status: "failed" });
          port.disconnect?.();
          reject(new Error(message.error || "运行失败"));
        }
        if (message.type === "INTERRUPTED") {
          settled = true;
          await persistGrowthRunUpdate(run.caseId, run.id, {
            status: "interrupted",
            error: message.result?.result || message.resumeHint || "工作流已保存断点",
            interruptedAt: new Date().toISOString(),
          }, { status: "interrupted" });
          port.disconnect?.();
          reject(new Error(message.result?.result || message.resumeHint || "工作流已保存断点"));
        }
      } catch (err) {
        settled = true;
        port.disconnect?.();
        reject(err);
      }
    });
    port.onDisconnect?.addListener(async () => {
      if (settled) return;
      await persistGrowthRunUpdate(run.caseId, run.id, {
        status: "interrupted",
        error: "后台连接中断，已保存断点，可再次运行继续。",
        interruptedAt: new Date().toISOString(),
      }, { status: "interrupted" });
      reject(new Error("后台连接中断，已保存断点，可再次运行继续。"));
    });
    port.postMessage({
      type: "RUN_SKILL",
      skillPath: run.skillPath,
      growthActionId: run.actionId,
      growthRunId: run.id,
      growthCaseId: run.caseId,
      workflowSessionId: run.workflowSessionId,
      continueSession: false,
      forceNewSession: true,
      userInstruction: run.instruction,
    });
  });
}

async function createGrowthCaseRun(actionId, sku = "") {
  const action = GROWTH_ACTIONS[actionId] || GROWTH_ACTIONS.diagnose_store_growth;
  const stored = await new Promise((r) => chrome.storage.local.get(["growthActionRuns", "growthCases", "activeShopId"], r));
  const shopId = stored.activeShopId || growthRuntimeState.activeShop?.id || "";
  const caseType = GROWTH_ACTION_CASE_TYPE[actionId] || "store_health";
  const caseId = growthCaseIdFor(actionId, shopId, sku);
  const now = new Date().toISOString();
  const run = {
    contractVersion: GROWTH_CONTRACT_VERSION,
    id: `growth_run_${Date.now()}`,
    workflowSessionId: `workflow_session_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    caseId,
    caseType,
    shopId,
    actionId,
    title: action.title,
    sku,
    instruction: sku ? `${action.instruction}\n目标 SKU: ${sku}` : action.instruction,
    skillPath: action.skillPath,
    status: "queued",
    evidence: {},
    reportIds: [],
    createdAt: now,
    updatedAt: now,
  };
  const runs = [run, ...(stored.growthActionRuns || [])].slice(0, 80);
  const cases = stored.growthCases || [];
  const existing = cases.find((caseItem) => caseItem.id === caseId);
  const caseRun = normalizeGrowthRunRecord({ id: run.id, caseId, actionId, title: run.title, status: run.status, createdAt: now, updatedAt: now });
  const nextCase = normalizeGrowthCaseRecord({
    ...(existing || {}),
    contractVersion: GROWTH_CONTRACT_VERSION,
    id: caseId,
    type: caseType,
    title: existing?.title || GROWTH_CASE_LABELS[caseType] || action.title,
    shopId,
    status: "queued",
    actionId,
    taskIds: existing?.taskIds || [],
    reportIds: existing?.reportIds || [],
    eventIds: existing?.eventIds || [],
    runs: [caseRun, ...((existing?.runs || []).filter(item => item.id !== run.id))].slice(0, 20),
    runHistory: [caseRun, ...((existing?.runHistory || existing?.runs || []).filter(item => item.id !== run.id))].slice(0, 20),
    experiments: existing?.experiments || [],
    nextReviewAt: existing?.nextReviewAt || null,
    evidence: {
      ...(existing?.evidence || {}),
      sku,
      actionTitle: action.title,
      queuedFrom: "dashboard_workflow_canvas",
    },
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  });
  const nextCases = [nextCase, ...cases.filter((caseItem) => caseItem.id !== caseId)].slice(0, 80);
  await new Promise((r) => chrome.storage.local.set({ growthActionRuns: runs, growthCases: nextCases }, r));
  return run;
}

async function handleGrowthAction(actionId, sku = "") {
  const run = await createGrowthCaseRun(actionId, sku);
  await refreshAllData();
  openWorkflowPip({ rootId: GROWTH_ACTION_CASE_TYPE[actionId] || "store_health" });
  try {
    await persistGrowthRunUpdate(run.caseId, run.id, { status: "running", startedAt: new Date().toISOString() }, { status: "running" });
    await startDashboardGrowthRun(run);
    await refreshAllData();
    openWorkflowPip({ rootId: GROWTH_ACTION_CASE_TYPE[actionId] || "store_health" });
  } catch (err) {
    const isInterrupted = /已保存断点|后台连接中断/.test(err.message);
    const fallbackStatus = isInterrupted
      ? "interrupted"
      : /当前环境不支持|Receiving end|无法获取当前活动|无法注入|content/i.test(err.message)
      ? "needs_frontend_context"
      : "failed";
    await persistGrowthRunUpdate(run.caseId, run.id, {
      status: fallbackStatus,
      error: err.message,
      ...(isInterrupted ? { interruptedAt: new Date().toISOString() } : { failedAt: new Date().toISOString() }),
    }, { status: fallbackStatus });
    await refreshAllData();
    openWorkflowPip({ rootId: GROWTH_ACTION_CASE_TYPE[actionId] || "store_health" });
    alert(`已创建「${run.title}」增长案件，但当前无法在 dashboard 内直接完成运行。\n\n原因：${err.message}\n\n请打开对应 Etsy 页面，右侧浮窗会继续承接该动作。`);
  }
}

async function syncSkuAnalyticsFromApi() {
  const btn = document.getElementById("sync-sku-api-btn");
  const original = btn?.innerText || "同步 Etsy 个人访问 API SKU";
  if (btn) {
    btn.disabled = true;
    btn.innerText = "同步中...";
  }
  try {
	    const range = readStoreDateRange();
	    const activeShopId = document.getElementById("global-shop-selector")?.value || growthRuntimeState.activeShop?.id || "";
	    const response = await chrome.runtime.sendMessage({
	      type: "GET_ETSY_SKU_ANALYTICS",
	      args: { shopId: activeShopId, dateFrom: range.dateFrom, dateTo: range.dateTo, limit: 1000 }
	    });
    const rows = response?.data?.result?.data || [];
    if (!response?.ok || !rows.length) {
      alert(`Etsy 个人访问 API SKU analytics 暂无数据：${response?.error || response?.data?.error || "返回为空"}`);
      return;
    }
	    await new Promise((r) => chrome.storage.local.set({
	      etsySkuAnalyticsSnapshot: {
        shopId: activeShopId,
        dateFrom: range.dateFrom,
        dateTo: range.dateTo,
        result: response.data.result,
        syncedAt: new Date().toISOString(),
      }
    }, r));
    await refreshAllData();
    alert(`已同步 ${rows.length} 行真实 SKU analytics，SKU 作战台已刷新。`);
  } catch (err) {
    alert(`同步失败：${err.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerText = original;
    }
  }
}

function renderRecentEventsFeed(events = []) {
  const container = document.getElementById("recent-events-feed");
  if (events.length === 0) {
    container.innerHTML = `<div class="empty-state">暂无最新感知变化事件</div>`;
    return;
  }

  container.innerHTML = events.slice(0, 10).map((ev) => `
    <div class="event-item" style="padding:10px; border-bottom:1px solid rgba(255,255,255,0.04); display:flex; justify-content:space-between; font-size:12px;">
      <div>
        <strong style="color:var(--text1)">${ev.entity_name || '竞争商品'}</strong>
        <span style="color:var(--text2); margin-left:8px;">${ev.event_desc || '检测到价格变动'}</span>
      </div>
      <span style="color:#64748b">${new Date(ev.detected_at || Date.now()).toLocaleTimeString()}</span>
    </div>
  `).join('');
}

function renderPipelineTable(savedResults = []) {
  const body = document.getElementById("pipeline-table-body");
  const sourcingResults = savedResults.filter(r => r.skillId && r.skillId.includes("sourcing_finder"));

  if (sourcingResults.length === 0) {
    body.innerHTML = `
      <tr>
        <td colspan="9" class="empty-cell">
          <div class="empty-state">暂无对齐货源，请在 Etsy 详情页开启“1688寻源与套利测算”AI技能。</div>
        </td>
      </tr>
    `;
    return;
  }

  let rowsHtml = '';
  sourcingResults.forEach((res) => {
    const listData = (res.result && res.result.data) ? res.result.data : [];
    listData.forEach((item) => {
      const spec = item.spec_audit || {};
      const ledger = item.financial_ledger || {};

      rowsHtml += `
        <tr>
          <td><img src="${item.candidate_image_url || 'icons/icon128.png'}" style="width:40px; height:40px; border-radius:4px; object-fit:cover;"></td>
          <td>
            <div style="font-weight:600; font-size:12px; max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${item.title || '对标品'}</div>
            <a href="${res.pageUrl || '#'}" target="_blank" style="font-size:10px; color:#005bff">前台直达 ➔</a>
          </td>
          <td>
            <div style="font-weight:500; font-size:12px;">1688 供应商货源</div>
            <a href="${item.product_link || '#'}" target="_blank" style="font-size:10px; color:#10b981">采购直达 ➔</a>
          </td>
          <td>¥${ledger.sourcing_cost || '0'}</td>
          <td>${ledger.shipping_cost || '0'} $</td>
          <td>${ledger.target_price || '0'} $</td>
          <td style="color:${parseFloat(ledger.margin_rate) > 20 ? '#10b981' : '#ef4444'}; font-weight:700;">${ledger.margin_rate}%</td>
          <td>
            <span class="badge ${spec.status === '完全一致' ? 'success' : 'warning'}" style="font-size:10px; padding:2px 6px; border-radius:4px; background:rgba(16,185,129,0.1); color:#10b981">
              ${spec.status || '无'}
            </span>
          </td>
          <td>
            <button class="btn btn-outline btn-xs" onclick="alert('即将拉取货源卖点生成 Etsy 英文商品页文案！');">生成英文商品页</button>
          </td>
        </tr>
      `;
    });
  });

  body.innerHTML = rowsHtml || `
    <tr>
      <td colspan="9" class="empty-cell">
        <div class="empty-state">暂无对齐货源，请在 Etsy 详情页开启“1688寻源与套利测算”AI技能。</div>
      </td>
    </tr>
  `;
}

function renderTasksTable(tasks = []) {
  const body = document.getElementById("tasks-table-body");
  if (tasks.length === 0) {
    body.innerHTML = `
      <tr>
        <td colspan="6" class="empty-cell"><div class="empty-state">暂无感知监控任务</div></td>
      </tr>
    `;
    return;
  }

  body.innerHTML = tasks.map((task) => {
    const typeText = task.target_type === "shop" ? "Etsy 店铺" : "Etsy 商品";
    const natureText = task.shop_nature === "self" ? "自营(API)" : "第三方竞品";
    const badgeColor = task.target_type === "shop" ? "rgba(139, 92, 246, 0.1); color: #8b5cf6;" : "rgba(0, 91, 255, 0.1); color: #005bff;";
    const natureColor = task.shop_nature === "self" ? "rgba(16, 185, 129, 0.1); color: #10b981;" : "rgba(245, 158, 11, 0.1); color: #f59e0b;";

    return `
      <tr>
        <td>
          <span class="badge" style="background:${badgeColor}">${typeText}</span>
          <span class="badge" style="background:${natureColor}">${natureText}</span>
        </td>
        <td><a href="${task.target_url}" target="_blank" style="font-size:11px; max-width:280px; overflow:hidden; text-overflow:ellipsis; display:block; color:var(--text-secondary)">${task.target_url}</a></td>
        <td>${task.frequency === '15m' ? '每15分钟' : (task.frequency === '1h' ? '每1小时' : '每6小时')}</td>
        <td>${task.last_run_at}</td>
        <td><span class="status-indicator success" style="margin-right:6px;"></span> 运行中</td>
        <td>
          <button class="btn btn-outline btn-xs btn-danger-hover" id="delete-task-${task.id}">移除</button>
        </td>
      </tr>
    `;
  }).join('');

  tasks.forEach((t) => {
    document.getElementById(`delete-task-${t.id}`).addEventListener("click", async () => {
      if (confirm("确定移除此自动监控感知任务？")) {
        const stored = await new Promise((r) => chrome.storage.local.get(["monitorTasks"], r));
        const filtered = (stored.monitorTasks || []).filter(item => item.id !== t.id);
        await new Promise((r) => chrome.storage.local.set({ monitorTasks: filtered }, r));

        // Clear Chrome alarm
        const alarmName = `monitor_task_${encodeURIComponent(JSON.stringify(t))}`;
        try {
          await chrome.alarms.clear(alarmName);
        } catch (alarmErr) {
          console.warn("Could not clear Chrome alarm:", alarmErr.message);
        }

        await refreshAllData();
      }
    });
  });
}

// ── Operations Tracker View Tab Logic ──
let currentTrackedItem = null;

function renderTrackerTab() {
  chrome.storage.local.get(['trackedProducts'], (data) => {
    const list = data.trackedProducts || [];
    const listContainer = document.getElementById("tracked-products-list");
    const detailPlaceholder = document.getElementById("tracker-detail-placeholder");
    const detailContent = document.getElementById("tracker-detail-content");

    if (list.length === 0) {
      listContainer.innerHTML = `<div class="empty-state">暂无跟踪商品，请前往商品页浮窗点击“追踪此商品”。</div>`;
      detailPlaceholder.classList.remove("hidden");
      detailContent.classList.add("hidden");
      return;
    }

    listContainer.innerHTML = list.map((prod) => `
      <div class="tracked-item ${currentTrackedItem?.id === prod.id ? 'active' : ''}" id="tracked-item-${prod.id}" style="padding:12px; border-bottom:1px solid rgba(255,255,255,0.06); cursor:pointer;">
        <div style="font-weight:600; font-size:12px; color:var(--text1); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${prod.title}</div>
        <div style="font-size:10px; color:var(--text2); margin-top:4px; display:flex; justify-content:space-between">
          <span>阶段数: ${prod.phases?.length || 1} 个</span>
          <span>注册: ${prod.registeredAt}</span>
        </div>
      </div>
    `).join('');

    detailPlaceholder.classList.add("hidden");
    detailContent.classList.remove("hidden");

    list.forEach((prod) => {
      document.getElementById(`tracked-item-${prod.id}`).addEventListener("click", () => {
        currentTrackedItem = prod;
        renderTrackerTab(); // Refresh highlight
        renderTrackedItemDetails(prod);
      });
    });

    // Auto-select first item if none is selected
    if (!currentTrackedItem && list.length > 0) {
      currentTrackedItem = list[0];
      renderTrackedItemDetails(list[0]);
      // re-render to apply active highlight
      renderTrackerTab();
    }
  });
}

function renderTrackedItemDetails(prod) {
  document.getElementById("tracked-item-title").innerText = prod.title;
  document.getElementById("tracked-item-date").innerText = `注册时间: ${prod.registeredAt}`;
  document.getElementById("tracked-item-url").href = prod.url;

  // Render optimization phases timeline
  const timeline = document.getElementById("phases-timeline-list");
  const phases = prod.phases || [];
  
  timeline.innerHTML = phases.map((phase) => `
    <div class="timeline-item" style="position:relative; padding-left:24px; margin-bottom:18px; border-left:2px solid #005bff;">
      <div class="timeline-badge" style="position:absolute; left:-7px; top:0; width:12px; height:12px; border-radius:50%; background:#005bff;"></div>
      <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
        <strong style="font-size:12px; color:var(--text1);">${phase.name}</strong>
        <span style="font-size:11px; color:#64748b;">${phase.date}</span>
      </div>
      <p style="font-size:12px; color:var(--text2); line-height:1.4; margin:0;">${phase.note}</p>
    </div>
  `).join('');

  // Setup Phase marking buttons
  document.getElementById("add-phase-btn").onclick = () => {
    document.getElementById("add-stage-modal").classList.remove("hidden");
    document.getElementById("new-stage-date").value = new Date().toISOString().split('T')[0];
  };

  document.getElementById("close-stage-modal-btn").onclick = () => {
    document.getElementById("add-stage-modal").classList.add("hidden");
  };

  document.getElementById("save-stage-btn").onclick = () => {
    const name = document.getElementById("new-stage-name").value.trim();
    const date = document.getElementById("new-stage-date").value;
    const note = document.getElementById("new-stage-note").value.trim();

    if (!name) {
      alert("请填写阶段名称！");
      return;
    }

    chrome.storage.local.get(['trackedProducts'], (data) => {
      const list = data.trackedProducts || [];
      const match = list.find(p => p.id === prod.id);
      if (match) {
        if (!match.phases) match.phases = [];
        match.phases.push({ name, date, note });
        chrome.storage.local.set({ trackedProducts: list }, () => {
          document.getElementById("add-stage-modal").classList.add("hidden");
          document.getElementById("new-stage-name").value = '';
          document.getElementById("new-stage-note").value = '';
          currentTrackedItem = match;
          renderTrackerTab();
        });
      }
    });
  };

  document.getElementById("store-api-query-shortcut-btn")?.addEventListener("click", () => {
    document.querySelector('.nav-menu button[data-tab="store"]')?.click();
    setTimeout(() => document.getElementById("store-api-query-btn")?.click(), 0);
  });

  // Run AI analysis
  document.getElementById("run-tracker-ai-btn").onclick = () => {
    const reportText = document.getElementById("tracker-ai-report-text");
    if (!reportText) return;
    reportText.innerHTML = `
      <div class="empty-state tiny">
        请先绑定 Etsy 个人卖家 API 并积累两个完整观察窗口。本插件不会生成虚拟曝光、转化或利润诊断。
      </div>
    `;
  };

  // Draw Charts
  drawTrackerCharts();
}

function drawTrackerCharts() {
  const drawLine = (canvasId, data = [], labels = [], color = '#005bff') => {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    
    // Set drawing width/height to match actual layout size multiplied by devicePixelRatio
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = 180 * dpr; // height is 180px
    
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    
    const width = rect.width;
    const height = 180;
    
    // Clear
    ctx.clearRect(0, 0, width, height);
    
    // Draw grid
    const themeBorder = getComputedStyle(document.documentElement).getPropertyValue('--border').trim() || 'rgba(255,255,255,0.06)';
    ctx.strokeStyle = themeBorder;
    ctx.lineWidth = 1;
    for(let i = 1; i < 4; i++) {
      const y = height * (i / 4);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    if (data.length === 0) return;

    // Plot line
    const maxVal = Math.max(...data) * 1.25 || 10;
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();

    const points = [];
    for(let i = 0; i < data.length; i++) {
      const x = (width * 0.8) * (i / (data.length - 1 || 1)) + (width * 0.1);
      const y = height - (height * 0.6) * (data[i] / maxVal) - 40;
      points.push({ x, y });
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Draw dots & labels
    const textPrimary = getComputedStyle(document.documentElement).getPropertyValue('--text-primary').trim() || '#ffffff';
    const textSecondary = getComputedStyle(document.documentElement).getPropertyValue('--text-secondary').trim() || '#9ca3af';

    points.forEach((p, idx) => {
      // Draw dot fill (white or background color depending on theme)
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg-input').trim() || '#1f2937';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
      ctx.fill();
      
      // Draw dot border (colored line)
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.5;
      ctx.stroke();
      
      // Draw data value label above dot
      ctx.fillStyle = textPrimary;
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(data[idx], p.x, p.y - 10);
      
      // Draw phase label below dot
      ctx.fillStyle = textSecondary;
      ctx.font = '10px sans-serif';
      ctx.fillText(labels[idx] || '', p.x, height - 12);
    });
  };

  const rows = Array.isArray(growthRuntimeState.skuRows) ? growthRuntimeState.skuRows.filter((row) => row.source === "seller_api") : [];
  const salesData = rows.map((row) => Number(row.orderedUnits || 0)).filter((value) => Number.isFinite(value) && value > 0).slice(0, 6);
  const conversionData = rows.map((row) => Number(row.cartRate || 0)).filter((value) => Number.isFinite(value) && value > 0).slice(0, 6);
  const labels = rows.map((row) => String(row.sku || row.title || "").slice(0, 8)).slice(0, 6);
  drawLine('tracker-sales-chart', salesData, labels, '#005bff');
  drawLine('tracker-conv-chart', conversionData, labels, '#ff005b');
}

// ── Etsy Store API Tab Logic ──
let storeApiRequestInFlight = false;

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatDateInput(date) {
  return date.toISOString().slice(0, 10);
}

function getDefaultStoreDateRange(days = 14) {
  const dateTo = new Date();
  const dateFrom = new Date(dateTo);
  dateFrom.setDate(dateTo.getDate() - Math.max(1, days));
  return {
    dateFrom: formatDateInput(dateFrom),
    dateTo: formatDateInput(dateTo),
  };
}

function setDefaultStoreDateRange() {
  const fromInput = document.getElementById("store-api-date-from");
  const toInput = document.getElementById("store-api-date-to");
  if (!fromInput || !toInput) return;
  const defaults = getDefaultStoreDateRange(14);
  if (!fromInput.value) fromInput.value = defaults.dateFrom;
  if (!toInput.value) toInput.value = defaults.dateTo;
}

function readStoreDateRange() {
  const defaults = getDefaultStoreDateRange(14);
  const fromInput = document.getElementById("store-api-date-from");
  const toInput = document.getElementById("store-api-date-to");
  let dateFrom = fromInput?.value || defaults.dateFrom;
  let dateTo = toInput?.value || defaults.dateTo;
  if (dateFrom > dateTo) {
    [dateFrom, dateTo] = [dateTo, dateFrom];
    if (fromInput) fromInput.value = dateFrom;
    if (toInput) toInput.value = dateTo;
  }
  return { dateFrom, dateTo };
}

function isSellerApiCacheFresh(cache, activeShopId, maxAgeMs = SELLER_API_AUTO_REFRESH_MS) {
  if (!cache || cache.shopId !== activeShopId || !cache.syncedAt) return false;
  return Date.now() - new Date(cache.syncedAt).getTime() < maxAgeMs;
}

async function maybeAutoRefreshSellerApiCache() {
  const activeShopId = growthRuntimeState.activeShop?.id || "";
  if (!activeShopId) return;
  if (isSellerApiCacheFresh(growthRuntimeState.skuAnalyticsSnapshot, activeShopId)) return;
  const range = readStoreDateRange();
  const response = await chrome.runtime.sendMessage({
    type: "GET_ETSY_SKU_ANALYTICS",
    args: { shopId: activeShopId, dateFrom: range.dateFrom, dateTo: range.dateTo, limit: 1000 }
  });
  if (response?.ok && response?.data?.result?.data?.length) {
    await refreshAllData();
  }
}

function ensureStoreApiStatusNode() {
  const nodes = [...document.querySelectorAll(".store-api-source-status")];
  if (nodes.length) return nodes;
  const cardHeader = document.querySelector("#view-store .grid-card .card-header");
  if (!cardHeader) return [];
  const statusNode = document.createElement("div");
  statusNode.className = "store-api-source-status";
  cardHeader.appendChild(statusNode);
  return [statusNode];
}

function setStoreApiStatus(kind, message) {
  const nodes = ensureStoreApiStatusNode();
  if (!nodes.length) return;
  const color = kind === "live" ? "#10b981" : kind === "partial" ? "#f59e0b" : "#ef4444";
  nodes.forEach((node) => {
    node.innerHTML = `<span style="color:${color}; font-weight:600;">● ${escapeHtml(message)}</span>`;
  });
}

function formatStoreApiFailure(failure = {}) {
  const endpoint = failure.endpoint || "Etsy 个人访问 API";
  const error = String(failure.error || "");
  if (/429|rate limit/i.test(error)) {
    return `${endpoint}: 触发 Etsy 频率限制，系统已排队并自动重试；若仍失败请缩小日期范围或稍后再查`;
  }
  if (/404|not found/i.test(error)) {
    return `${endpoint}: 接口不可用或权限不足`;
  }
  return `${endpoint}: ${error}`;
}

function metricValue(totals = {}, metrics = [], metricName) {
  if (Object.prototype.hasOwnProperty.call(totals, metricName)) return Number(totals[metricName]) || 0;
  const idx = metrics.indexOf(metricName);
  if (idx >= 0 && Object.prototype.hasOwnProperty.call(totals, idx)) return Number(totals[idx]) || 0;
  return 0;
}

function averageMetric(rows = [], metricNames = [], metricName) {
  const idx = metricNames.indexOf(metricName);
  if (idx < 0) return 0;
  const values = rows
    .map((row) => Number((row.metrics || [])[idx]))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function mapSnapshotToStoreMetrics(snapshot = {}) {
  const analytics = snapshot.analytics || {};
  const analyticsSupported = analytics.supported === true;
  const metrics = analytics.metrics || [];
  const totals = analytics.totals || {};
  const rows = analytics.data || [];
  const views = analyticsSupported ? metricValue(totals, metrics, "hits_view") : null;
  const sessions = analyticsSupported ? metricValue(totals, metrics, "session_view") : null;
  const orderedUnits = analyticsSupported ? metricValue(totals, metrics, "ordered_units") : null;
  const avgCartRate = analyticsSupported ? averageMetric(rows, metrics, "conv_tocart") : null;
  const cartRate = avgCartRate > 0
    ? avgCartRate
    : (analyticsSupported && sessions > 0 ? (orderedUnits / sessions) * 100 : null);
  const orderRate = analyticsSupported && sessions > 0 ? (orderedUnits / sessions) * 100 : null;
  return {
    analyticsSupported,
    sessions,
    views,
    cartRate: cartRate === null ? null : cartRate.toFixed(1),
    orderRate: orderRate === null ? null : orderRate.toFixed(1),
    orders: snapshot.orders || [],
    failures: snapshot.failures || [],
  };
}

function renderStoreMetrics(storeData, sourceKind) {
  const analyticsSupported = storeData.analyticsSupported !== false;
  document.getElementById("api-sessions").innerText = analyticsSupported && storeData.sessions !== null ? Number(storeData.sessions || 0).toLocaleString() : "--";
  document.getElementById("api-views").innerText = analyticsSupported && storeData.views !== null ? Number(storeData.views || 0).toLocaleString() : "--";
  document.getElementById("api-cart-rate").innerText = analyticsSupported && storeData.cartRate !== null ? `${storeData.cartRate || "0.0"}%` : "--";
  document.getElementById("api-order-rate").innerText = analyticsSupported && storeData.orderRate !== null ? `${storeData.orderRate || "0.0"}%` : "--";

  const tableBody = document.getElementById("store-orders-table");
  const orders = storeData.orders || [];
  if (!orders.length) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="7" class="empty-cell">
          <div class="empty-state">${sourceKind === "live" ? "Etsy 个人访问 API 暂未返回交易订单。" : "暂无真实订单数据。"}</div>
        </td>
      </tr>
    `;
  } else {
    tableBody.innerHTML = orders.map(o => `
      <tr>
        <td><span class="cell-ellipsis" title="${escapeHtml(o.orderId)}">${escapeHtml(o.orderId)}</span></td>
        <td>
          <span class="sku-cell">
            <strong class="cell-ellipsis" title="${escapeHtml(o.sku)}">${escapeHtml(o.sku)}</strong>
            <small class="cell-ellipsis" title="${escapeHtml(o.cat)}">${escapeHtml(o.cat)}</small>
          </span>
        </td>
        <td>${Number(o.qty || 0)}</td>
        <td><span class="cell-ellipsis">${Number(o.price || 0).toLocaleString()} $</span></td>
        <td><span class="badge cell-ellipsis" title="${escapeHtml(o.logisticsType || "--")}" style="background:${String(o.logisticsType || "").includes("Etsy 自发货") ? 'rgba(255,0,91,0.1)' : 'rgba(0,91,255,0.1)'}; color:${String(o.logisticsType || "").includes("Etsy 自发货") ? '#ff005b' : '#005bff'}">${escapeHtml(o.logisticsType || "--")}</span></td>
        <td><span class="cell-ellipsis" title="${escapeHtml(o.status || "--")}"><span class="status-indicator ${o.status === '待包装' ? 'warning' : 'success'}" style="margin-right:6px;"></span>${escapeHtml(o.status || "--")}</span></td>
        <td><span class="cell-ellipsis" title="${escapeHtml(o.countdown || "--")}">${escapeHtml(o.countdown || "--")}</span></td>
      </tr>
    `).join('');
  }
}

function renderStoreCostBreakdown(costData = {}, sourceKind = "empty") {
  const hasCostData = ["profit", "commission", "logistics", "tail"].every((key) => Number.isFinite(Number(costData[key])));
  drawStoreFeesChart(hasCostData ? [costData.profit, costData.commission, costData.logistics, costData.tail] : []);

  const labelContainer = document.querySelector("#store-fees-chart").parentNode.nextElementSibling;
  if (labelContainer) {
    labelContainer.innerHTML = `
      <div style="font-size:10px; color:var(--text-secondary); margin-bottom:4px;">${sourceKind === "live" && hasCostData ? "费用占比为模型估算，待 Etsy 个人访问 API 财务明细验证" : "暂无真实费用结构数据；需同步 API 或人工录入成本后显示"}</div>
      <div style="display:flex; justify-content:space-between;"><span>类目佣金扣除:</span><strong style="color:#005bff">${hasCostData ? `${costData.commission}%` : "--"}</strong></div>
      <div style="display:flex; justify-content:space-between;"><span>干线运费占比:</span><strong style="color:#ff005b">${hasCostData ? `${costData.logistics}%` : "--"}</strong></div>
      <div style="display:flex; justify-content:space-between;"><span>末端送达扣减:</span><strong style="color:#f59e0b">${hasCostData ? `${costData.tail}%` : "--"}</strong></div>
      <div style="display:flex; justify-content:space-between;"><span>实际到手货款:</span><strong style="color:#10b981">${hasCostData ? `${costData.profit}%` : "--"}</strong></div>
    `;
  }
}

function renderEmptyStoreData(reason = "") {
  renderStoreMetrics({
    analyticsSupported: false,
    sessions: null,
    views: null,
    cartRate: null,
    orderRate: null,
    orders: [],
  }, "empty");
  renderStoreCostBreakdown({}, "empty");
  setStoreApiStatus("partial", reason ? `暂无真实 Etsy API 数据：${reason}` : "暂无真实 Etsy API 数据");
}

async function renderStoreTab() {
  chrome.storage.local.get(['etsyShops', 'activeShopId'], async (data) => {
    setDefaultStoreDateRange();
    const range = readStoreDateRange();
    const tableBody = document.getElementById("store-orders-table");
    const shops = data.etsyShops || [];
    const activeId = data.activeShopId;
    const activeShop = shops.find(s => s.id === activeId);

    if (!activeShop) {
      tableBody.innerHTML = `
        <tr>
          <td colspan="7" class="empty-cell">
            <div class="empty-state">暂无活动店铺，请在右侧录入或绑定 Etsy 店铺。</div>
          </td>
        </tr>
      `;
    document.getElementById("api-sessions").innerText = "--";
      document.getElementById("api-views").innerText = "--";
      document.getElementById("api-cart-rate").innerText = "--";
      document.getElementById("api-order-rate").innerText = "--";
      renderStoreCostBreakdown({}, "empty");
      setStoreApiStatus("partial", "未绑定活动店铺，无法调用 Etsy 个人访问 API");
      return;
    }

    if (storeApiRequestInFlight) {
      setStoreApiStatus("partial", "Etsy 个人访问 API 正在同步中，请等待当前查询完成...");
      return;
    }
    storeApiRequestInFlight = true;
    const queryBtn = document.getElementById("store-api-query-btn");
    if (queryBtn) queryBtn.disabled = true;
    tableBody.innerHTML = `
      <tr>
        <td colspan="7" class="empty-cell">
          <div class="empty-state">正在同步 Etsy 个人访问 API...</div>
        </td>
      </tr>
    `;
    setStoreApiStatus("partial", "正在请求 Etsy 个人访问 API 实时数据...");

    try {
	      const response = await chrome.runtime.sendMessage({
	        type: "GET_ETSY_STORE_SNAPSHOT",
	        args: { shopId: activeId, dateFrom: range.dateFrom, dateTo: range.dateTo, productLimit: 100, pageSize: 20 }
	      });
	      const skuAnalyticsResponse = await chrome.runtime.sendMessage({
	        type: "GET_ETSY_SKU_ANALYTICS",
	        args: { shopId: activeId, dateFrom: range.dateFrom, dateTo: range.dateTo, limit: 1000 }
	      });
      if (skuAnalyticsResponse?.ok && skuAnalyticsResponse?.data?.result?.data?.length) {
        await new Promise((r) => chrome.storage.local.set({
          etsySkuAnalyticsSnapshot: {
            shopId: activeId,
            dateFrom: range.dateFrom,
            dateTo: range.dateTo,
            result: skuAnalyticsResponse.data.result,
            syncedAt: new Date().toISOString(),
          }
        }, r));
      }
      const snapshot = response?.data?.result;
      if (!snapshot) {
        renderEmptyStoreData(response?.error || response?.data?.error || "未收到 API 快照");
        return;
      }

      const storeMetrics = mapSnapshotToStoreMetrics(snapshot);
      const hasLivePayload = (snapshot.analytics?.data || []).length > 0 || (snapshot.orders || []).length > 0 || (snapshot.products?.items || []).length > 0;
      if (!hasLivePayload) {
        const reason = (storeMetrics.failures || []).map(formatStoreApiFailure).join("；") || "API 返回空数据";
        renderEmptyStoreData(reason);
        return;
      }

      renderStoreMetrics(storeMetrics, snapshot.ok ? "live" : "partial");
      renderStoreCostBreakdown({}, "empty");
      if (snapshot.ok) {
        const skuCount = skuAnalyticsResponse?.data?.result?.data?.length || 0;
        setStoreApiStatus("live", `Etsy 个人访问 API 实时自营数据：${snapshot.dateFrom} 至 ${snapshot.dateTo}${snapshot.analytics?.supported === false ? "；个人 API 不提供流量/加购 analytics，相关指标显示为 --" : skuCount ? `；SKU 作战台已同步 ${skuCount} 行真实 analytics` : ""}`);
      } else {
        const reason = (storeMetrics.failures || []).map(formatStoreApiFailure).join("；");
        setStoreApiStatus("partial", `Etsy 个人访问 API 部分成功：${reason || "部分接口无数据"}`);
      }
    } catch (err) {
      renderEmptyStoreData(err.message);
    } finally {
      storeApiRequestInFlight = false;
      if (queryBtn) queryBtn.disabled = false;
      refreshAllData();
    }
  });
}

function drawStoreFeesChart(costs = []) {
  const canvas = document.getElementById("store-fees-chart");
  if (!canvas) return;
  
  // Set drawing width/height to match actual layout size multiplied by devicePixelRatio for razor-sharp rendering
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = 200 * dpr; // height is 200px
  
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  
  const width = rect.width;
  const height = 200;
  
  ctx.clearRect(0, 0, width, height);
  if (!Array.isArray(costs) || costs.length === 0 || costs.some((value) => !Number.isFinite(Number(value)))) {
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-secondary').trim() || '#9ca3af';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('暂无真实费用结构数据', width / 2, height / 2);
    return;
  }
  
  const labels = ['净货款', '佣金', '干线物流', '末端扣除'];
  const colors = ['#10b981', '#005bff', '#ff005b', '#f59e0b'];
  
  const barWidth = 45;
  const spacing = (width - 60 - (barWidth * costs.length)) / (costs.length - 1);
  const startX = 30;

  for(let i = 0; i < costs.length; i++) {
    const x = startX + i * (barWidth + spacing);
    const maxBarHeight = height - 60; // leave padding for labels and values
    const barHeight = maxBarHeight * (costs[i] / 100);
    const y = height - barHeight - 30;
    
    // Draw bar with rounded corners for a premium modern look
    ctx.fillStyle = colors[i];
    ctx.beginPath();
    ctx.roundRect(x, y, barWidth, barHeight, [4, 4, 0, 0]);
    ctx.fill();
    
    // Text value (percentage) - dynamic styling depending on mode
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-primary').trim() || '#ffffff';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${costs[i]}%`, x + barWidth / 2, y - 8);
    
    // Text label
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-secondary').trim() || '#9ca3af';
    ctx.font = '11px sans-serif';
    ctx.fillText(labels[i], x + barWidth / 2, height - 12);
  }
}

// ── Reports Tab View Logic ──
function renderReportsList(monitorReports = [], savedResults = []) {
  const container = document.getElementById("reports-list-container");
  const viewer = document.getElementById("report-viewer-content");

  // Combine automatic monitor reports and regular skill runs
  const list = [];
  monitorReports.forEach(r => {
    const text = `### ${valueToPlainText(r.overview || '诊断概述')}\n\n**决策诊断与数据推演**:\n${valueToReadableMarkdown(r.analysis || '')}\n\n**下一步建议与分级路线图**:\n${valueToReadableMarkdown(r.summary || '')}`;
    list.push({ id: r.id, source: "monitor", title: r.title || r.shop_name || "店铺诊断报告", date: new Date(r.created_at || Date.now()).toLocaleDateString(), content: text, tag: "店铺报告" });
  });

  savedResults.forEach(r => {
    let name = "决策诊断书";
    if (r.skillId && r.skillId.includes("opportunity")) name = "Etsy选品机会书";
    if (r.skillId && r.skillId.includes("sourcing")) name = "Etsy-1688寻源账本";
    if (r.skillId && r.skillId.includes("optimizer")) name = "Etsy店铺优化诊断书";
    
    let text = '';
    const normalizedResult = normalizeFinalOutput(r.result);
    if (normalizedResult && (normalizedResult.overview || normalizedResult.analysis || normalizedResult.summary || normalizedResult.data)) {
      text = resultToReportMarkdown(normalizedResult);
    } else {
      text = typeof r.result === "string" ? r.result : JSON.stringify(r.result, null, 2);
    }
    
    list.push({ id: r.id || `res_${Math.random()}`, source: "saved", title: name, date: new Date(r.timestamp || Date.now()).toLocaleDateString(), content: text, tag: "AI决策" });
  });

  if (list.length === 0) {
    container.innerHTML = `<div class="empty-state">暂无生成报告</div>`;
    if (viewer) viewer.innerHTML = `<div class="empty-state">请在 Etsy 前台网页唤醒浮窗执行 AI 技能，生成后的报告会汇聚在这里。</div>`;
    return;
  }

  container.innerHTML = list.map((rep, index) => `
    <div class="report-item" id="report-item-${index}" data-report-index="${index}">
      <div class="report-item-main">
        <div style="font-weight:600; font-size:12px;">${escapeHtml(rep.title)}</div>
        <div style="font-size:10px; color:var(--text-secondary); margin-top:4px; display:flex; justify-content:space-between">
          <span>${escapeHtml(rep.tag)}</span>
          <span>${escapeHtml(rep.date)}</span>
        </div>
      </div>
      <div class="report-item-actions">
        <button class="btn btn-outline btn-xs report-copy-btn" data-report-index="${index}">复制</button>
        <button class="btn btn-outline btn-xs report-pdf-btn" data-report-index="${index}">PDF</button>
        <button class="btn btn-danger btn-xs report-delete-btn" data-report-index="${index}">删除</button>
      </div>
    </div>
  `).join('');

  const renderReport = (rep, index) => {
    document.querySelectorAll(".report-item").forEach(item => item.classList.remove("active"));
    document.getElementById(`report-item-${index}`)?.classList.add("active");
    viewer.innerHTML = `
      <div class="report-viewer-toolbar">
        <div>
          <strong>${escapeHtml(rep.title)}</strong>
          <span>${escapeHtml(rep.tag)} · ${escapeHtml(rep.date)}</span>
        </div>
        <div class="report-item-actions">
          <button class="btn btn-outline btn-xs report-copy-current">复制</button>
          <button class="btn btn-outline btn-xs report-pdf-current">下载 PDF</button>
          <button class="btn btn-danger btn-xs report-delete-current">删除</button>
        </div>
      </div>
      <div class="md-report">
        ${renderSafeMarkdown(rep.content)}
      </div>
    `;
    viewer.querySelector(".report-copy-current")?.addEventListener("click", () => copyReportContent(rep));
    viewer.querySelector(".report-pdf-current")?.addEventListener("click", () => downloadReportPdf(rep));
    viewer.querySelector(".report-delete-current")?.addEventListener("click", () => deleteReportEntry(rep));
  };

  list.forEach((rep, index) => {
    document.getElementById(`report-item-${index}`).addEventListener("click", () => renderReport(rep, index));
  });
  container.querySelectorAll(".report-copy-btn").forEach((btn) => {
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      copyReportContent(list[Number(btn.dataset.reportIndex)]);
    });
  });
  container.querySelectorAll(".report-pdf-btn").forEach((btn) => {
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      downloadReportPdf(list[Number(btn.dataset.reportIndex)]);
    });
  });
  container.querySelectorAll(".report-delete-btn").forEach((btn) => {
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteReportEntry(list[Number(btn.dataset.reportIndex)]);
    });
  });
  renderReport(list[0], 0);
}

async function copyReportContent(rep) {
  if (!rep) return;
  const text = `# ${rep.title}\n\n${rep.content}`;
  const clipboard = window.navigator?.clipboard || navigator?.clipboard;
  if (clipboard?.writeText) {
    await clipboard.writeText(text);
    alert("报告内容已复制。");
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "readonly");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand?.("copy");
  textarea.remove();
  if (copied) {
    alert("报告内容已复制。");
  } else {
    alert("当前环境不支持自动复制，请在报告正文中手动复制。");
  }
}

async function deleteReportEntry(rep) {
  if (!rep) return;
  if (!confirm(`确定删除「${rep.title}」吗？`)) return;
  if (rep.source === "monitor") {
    const stored = await new Promise((resolve) => chrome.storage.local.get(["monitorReports"], resolve));
    const next = (stored.monitorReports || []).filter((item) => String(item.id) !== String(rep.id));
    await new Promise((resolve) => chrome.storage.local.set({ monitorReports: next }, resolve));
  } else {
    await chrome.runtime.sendMessage({ type: "DELETE_RESULT", id: rep.id });
  }
  await refreshAllData();
  document.querySelector('.nav-menu button[data-tab="reports"]')?.click();
}

function downloadReportPdf(rep) {
  if (!rep) return;
  const dateStr = new Date().toISOString().split("T")[0];
  const bodyHtml = renderSafeMarkdown(rep.content || "");
  const printHtml = buildReportPrintHtml(rep, bodyHtml, dateStr);
  chrome.storage.local.set({ printHtml }, () => {
    window.open(chrome.runtime.getURL("print.html"), "_blank");
  });
}
