# Etsy Growth Agent 真实浏览器业务流验收矩阵

生成时间：2026-07-15T04:29:26.913Z

说明：该矩阵用于真实 Chrome/Etsy/1688/Google Trends 环境验收。脚本本身不访问外网，也不把静态检查伪装成真机通过。

## 验收项

### RB-01 Etsy 店铺体检
- 起始页面：Etsy shop home page
- 触发入口：右侧悬浮栏：店铺体检
- 必须留存证据：
  - [ ] 店铺定位、调性/格调、商品结构与政策读取
  - [ ] Etsy 搜索公开证据
  - [ ] 2-3 个同类高排名店铺/商品截图与 DOM 证据
  - [ ] diagnostic_depth_matrix 与 competitor_benchmarks
  - [ ] savedResults.evidence_bundle.screenshotRefs 非空
- 通过标准：
  - [ ] 不会只凭当前截图输出结论
  - [ ] 不关闭 source Etsy shop tab
  - [ ] 报告中心可阅读报告、下载 PDF、下载证据包
  - [ ] PDF 尾页包含证据包摘要
- 结论：未执行 / 通过 / 阻断
- 阻断说明：

### RB-02 平台趋势 / Google Trends
- 起始页面：Etsy shop, listing, category/search page, or explicit user keyword
- 触发入口：右侧悬浮栏：平台趋势
- 必须留存证据：
  - [ ] research_scope 标记店铺页/平台页/搜索页/竞品页语境
  - [ ] Google Trends US 页面稳定等待后截图/DOM 证据
  - [ ] Google Search/Etsy Search/Google Trends 证据分工清晰
  - [ ] 临时站外 tab 完成后可关闭，source Etsy tab 保留
- 通过标准：
  - [ ] 关闭当前 Etsy 主 tab 时任务可中断并保留 checkpoint
  - [ ] 打开新会话不会恢复旧 checkpoint
  - [ ] 历史会话恢复只恢复用户选择的 checkpoint
  - [ ] 报告不得把加载失败的 Google Trends 当作趋势结论
- 结论：未执行 / 通过 / 阻断
- 阻断说明：

### RB-03 Etsy Listing / 评论分析
- 起始页面：Etsy listing detail page
- 触发入口：右侧悬浮栏：Listing 改版 / 评论缺陷
- 必须留存证据：
  - [ ] 商品标题、价格、属性、图片、配送、退换货和评论 DOM 证据
  - [ ] 公开评论或 review count 证据
  - [ ] 评论区受阻时 blockingGaps 明确
  - [ ] review_dom 或 page_dom evidence ledger
- 通过标准：
  - [ ] 不能仅凭商品首屏截图推导买家痛点
  - [ ] 评论读取失败必须降级为待验证，不伪造评价结论
- 结论：未执行 / 通过 / 阻断
- 阻断说明：

### RB-04 竞品研究 / 店铺分页
- 起始页面：Etsy shop or Etsy search results page
- 触发入口：右侧悬浮栏：竞品扫描 / 店铺体检中的竞品阶段
- 必须留存证据：
  - [ ] 竞品店铺首页 DOM 与截图
  - [ ] 店铺商品分页采集记录
  - [ ] 排序口径，例如默认排序/最新上架/热卖可见口径
  - [ ] 商品价格、类别、SKU 可见数量、促销、评论等公开字段样本
- 通过标准：
  - [ ] 不能只打开竞品首页不翻页就声称全店商品结构
  - [ ] 不能把公开可见样本写成竞品后台完整 SKU 或销量
- 结论：未执行 / 通过 / 阻断
- 阻断说明：

### RB-05 供应商货源 / 1688 图搜
- 起始页面：Etsy listing page with target image
- 触发入口：右侧悬浮栏：货源筛选
- 必须留存证据：
  - [ ] 以图搜图进入 1688 结果页
  - [ ] 结果页 productCards 包含候选主图、价格、链接
  - [ ] 打开 2 个以上供应商详情页比较
  - [ ] 货源报告 data 至少 2 个供应商候选或明确阻断缺口
- 通过标准：
  - [ ] 拿到图搜结果后不循环切换关键词搜索
  - [ ] 文本搜索只在图片搜索明确阻断或用户允许时使用
  - [ ] 详情页 tab 生命周期受 workflow 管理
- 结论：未执行 / 通过 / 阻断
- 阻断说明：

### RB-06 报告中心 / 证据归档
- 起始页面：dashboard.html reports tab
- 触发入口：打开报告中心
- 必须留存证据：
  - [ ] 报告正文 Markdown/JSON 正常格式化
  - [ ] 复制按钮复制业务报告正文
  - [ ] PDF 中文不乱码
  - [ ] PDF 含证据包摘要尾页
  - [ ] 证据包 JSON 含 artifact_manifest
- 通过标准：
  - [ ] 删除只删除目标报告
  - [ ] 证据包 missing artifact 明确显示，不静默失败
- 结论：未执行 / 通过 / 阻断
- 阻断说明：
