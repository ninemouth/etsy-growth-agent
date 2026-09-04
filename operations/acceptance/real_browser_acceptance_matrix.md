# Marqel Etsy Edge 2.0 真实浏览器业务流验收矩阵

生成时间：2026-09-04T03:12:42.964Z

说明：该矩阵只验收 Edge 2.0 的浏览器最后一公里，不再验收竞品研究、趋势、报告、模型或业务设置。脚本不访问 Etsy，也不把静态测试冒充真机通过。
必须在指定 AdsPower Etsy Profile 中使用 Web 精确批准的任务完成端到端验收，并为每项结果附可回读证据。

## 验收项

### RB-01 构建身份与最小权限
- 起始页面：chrome://extensions and the assigned AdsPower Etsy profile
- 触发入口：Load the reviewed unpacked 2.0 candidate
- 必须留存证据：
  - [ ] 完整 Git SHA、ZIP SHA-256、manifest SHA-256 与版本 2.0.0
  - [ ] 实际 Chrome 版本、OS、AdsPower Profile ID 与运行时 Extension ID
  - [ ] 权限清单只有 storage、alarms、sidePanel 以及 Etsy/Marqel 精确 host
  - [ ] Control Center 对应设备身份和候选版本的可回读记录
- 通过标准：
  - [ ] 运行时 Extension ID 与组织持有的 manifest key 推导值一致
  - [ ] 无 all_urls、tabs、scripting、management 或模型/搜索/竞品站点权限
  - [ ] 现有 Etsy 标签页刷新后不再出现 Extension context invalidated
- 结论：未执行 / 通过 / 阻断
- 阻断说明：

### RB-02 单一 UI 与产品边界
- 起始页面：public Etsy Listing page and dashboard.html
- 触发入口：Open Dock task, Web and settings actions
- 必须留存证据：
  - [ ] Etsy 页面 Dock 只有任务、Web、设置三个动作
  - [ ] 设置只落到 sidepanel.html#settings
  - [ ] Node Console 只有运行身份、租约、边界与脱敏日志
  - [ ] 无聊天输入、竞品分析、趋势、报告、模型、汇率或利润设置入口
- 通过标准：
  - [ ] Dock 不遮挡主要 Etsy 内容且侧栏窄宽度无横向溢出
  - [ ] Dashboard 不再打开第二套设置抽屉
  - [ ] 键盘焦点、44px 控件、状态文字与颜色含义可辨认
- 结论：未执行 / 通过 / 阻断
- 阻断说明：

### RB-03 页面分类与隐私阻断
- 起始页面：public Listing, allowed Listing editor, account, order, message and payment routes
- 触发入口：Refresh capability passport and attempt task evidence
- 必须留存证据：
  - [ ] 公开 Listing 与 Listing 编辑器分别被正确分类
  - [ ] 非编辑器 /your 路径默认阻断
  - [ ] 账号、订单、消息、付款、安全和登录路径的阻断记录
  - [ ] 隐私遮罩前后 DOM 状态、maskedCount 与恢复证明
- 通过标准：
  - [ ] 敏感路径不调用 captureVisibleTab 且不产生 Artifact
  - [ ] 允许页面捕获前遮罩并在成功或失败后恢复
  - [ ] 没有活动获批任务时不允许证据采集
- 结论：未执行 / 通过 / 阻断
- 阻断说明：

### RB-04 Web 批准任务与租约预检
- 起始页面：Marqel Web approved Listing task plus matching Etsy editor
- 触发入口：领取并预检
- 必须留存证据：
  - [ ] task、operation、listingDraft、approval 与 etsyAutomationPermissionRef 的同链引用
  - [ ] etsy-listing-draft.v1、expectedUpdatedAt 与 publicPublishAllowed=false
  - [ ] claim/resume、heartbeat、checkpoint 和 lease owner 记录
  - [ ] stale draft、错误 approval、取消 operation 与失效 lease 的阻断记录
- 通过标准：
  - [ ] 只有 etsy_publish + etsy_adspower + upload_draft 可进入执行
  - [ ] 每次页面写入前重新读取任务和 operation
  - [ ] 租约丢失后停止全部写动作，必须显式恢复
- 结论：未执行 / 通过 / 阻断
- 阻断说明：

### RB-05 确定性字段填充
- 起始页面：current Etsy Listing editor variants used by the target shop
- 触发入口：填充获批字段
- 必须留存证据：
  - [ ] title、description、price、tags、category、personalization 的逐字段结果
  - [ ] selectorSetVersion、字段状态计数与页面 route class
  - [ ] 缺失/只读必填字段的原值恢复证据
  - [ ] Save、Submit、Publish 和图片上传均未触发的浏览器证据
- 通过标准：
  - [ ] 所有成功字段写入后回读值与获批草稿一致
  - [ ] 任一必填字段失败时已触碰字段原子回滚
  - [ ] 验证码、MFA、登录墙或未知编辑器变体均 fail closed
- 结论：未执行 / 通过 / 阻断
- 阻断说明：

### RB-06 任务绑定的隐私安全证据
- 起始页面：matching allowed Etsy page with an active preflighted task
- 触发入口：保存现场证据
- 必须留存证据：
  - [ ] 当前 taskId、operationId、source URL 与 capturedAt
  - [ ] JPEG SHA-256、redactionStatus=verified 与 Web artifact storageRef
  - [ ] 遮罩元素数量和 finally 恢复记录
  - [ ] 网络证据只发送到 matching /api/tasks/:id/artifacts
- 通过标准：
  - [ ] 截图不发送到任何模型或第三方分析端点
  - [ ] Artifact 与当前任务一一绑定并可在 Web 回读
  - [ ] 遮罩失败、页面变化或上传失败均不伪造成功 checkpoint
- 结论：未执行 / 通过 / 阻断
- 阻断说明：

### RB-07 人工草稿保存、终态回读与不重复执行
- 起始页面：same Etsy editor after field verification
- 触发入口：Operator saves draft, confirms visible ID/URL, then records readback
- 必须留存证据：
  - [ ] 可见 Etsy draft ID/URL 与人工未公开发布确认
  - [ ] etsy-publish-readback-artifact.v1 与 etsy-adspower-readback.v1
  - [ ] Control Center task、operation、Listing draft 与 Artifact 的终态一致
  - [ ] 响应丢失、context invalidation 与重开侧栏后的 reconciliation 记录
- 通过标准：
  - [ ] 无人确认时 uploaded readback 被拒绝
  - [ ] 写后响应不确定时 retrySubmissionAllowed=false 且只允许只读对账
  - [ ] 同一 operation 的 readback 只提交一次，最终状态可审计
- 结论：未执行 / 通过 / 阻断
- 阻断说明：
