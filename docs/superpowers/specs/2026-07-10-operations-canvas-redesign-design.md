# TraceForge Operations Canvas 前端重设计规格

日期：2026-07-10
状态：已确认
设计方法：UI UX Pro Max 设计系统检索 + 高保真视觉样例验证

## 1. 目标

将现有 TraceForge 三栏界面重设计为浅色、专业、高密度的红队调查工作台。新版以 Agent 操作为视觉和交互中心，Traffic 提供实时证据，Knowledge 提供结构化调查记录。

重设计必须满足以下目标：

- 保留现有业务功能、API、WebSocket、Run、Token、审批、Scope、Observer、Graph 和 MCP 行为。
- 提高长命令、长推理和连续 Agent 输出的可读性。
- 让运行、审批、停止、错误和恢复状态始终可见且可理解。
- 在常见桌面和窄屏尺寸下避免遮挡、横向溢出和控件挤压。
- 统一 Tailwind/shadcn 主题与旧 CSS 变量，消除当前浅色 `app.css` 和深色 `globals.css` 的冲突。
- 不引入新的前端框架或字体依赖。

## 2. 产品与视觉定位

TraceForge 属于本地单用户、高密度、实时操作型安全工具。视觉方向采用 UI UX Pro Max 推荐的 Data-Dense Dashboard、Minimal & Direct 和企业操作台模式，不采用黑底 Matrix、赛博朋克、营销页、装饰性渐变或大面积玻璃效果。

最终选择的设计方向为 **B：Operations Canvas（行动画布）**。

设计特征：

- 冷白灰画布、白色工具面板、深墨色正文。
- 钢蓝色表示主要操作和选中状态。
- 青绿色表示运行、成功和已验证状态。
- 琥珀色表示审批、临时警告和需要人工判断的状态。
- 红色仅用于错误、拒绝、停止和破坏性操作。
- 使用边框、背景层级和间距建立结构，避免卡片嵌套和大阴影。

## 3. 信息架构

### 3.1 顶部全局栏

`TopBar` 统一承载以下全局信息和操作：

- TraceForge 品牌标识。
- 当前 Case 名称和切换入口。
- 新建 Case。
- 当前 Run 状态。
- 累计 Token 用量。
- 设置入口。

浏览器控制权、Run 状态和 Token 不再在多个面板重复展示。破坏性 Case 删除操作保持与常规操作分离。

### 3.2 Traffic

左侧 Traffic 是实时证据流，保留以下功能：

- 启动或接管共享浏览器。
- 显示浏览器 URL 和当前控制者。
- 显示请求数量。
- 清空流量。
- 显示 Method、Status、时间和 URL。
- 展开请求头、请求体和响应内容。

Traffic 行使用等宽数字和 URL，状态码同时使用文字和语义颜色。长 URL 默认省略，但必须可以展开或通过 Tooltip 查看完整内容。

### 3.3 Agent

中间 Agent 是主工作区，包含：

- Run 标识、持续时间和流式状态。
- 用户指令。
- Agent 回复。
- Reasoning 折叠内容。
- 工具调用与工具结果。
- Approval、Scope 和 Observer 介入状态。
- Stop、Clear 和 Steering。
- 固定在面板底部的 Composer。

消息不再全部使用相同卡片。不同事件使用稳定的标签、左侧标记、背景和排版区分。工具内容使用 Geist Mono，普通对话使用 Geist Sans。

Approval、Scope 和 Observer 状态必须保留在消息流中，直到用户明确处理。处理后原位置显示 Approved、Rejected、Ignored、Resolved 或 Failed 结果，不允许点击后无反馈消失。

### 3.4 Knowledge

右侧 Knowledge 保留以下 Tab：

- Facts
- Tasks
- Timeline
- MCP
- Graph
- Observer

Tab 使用一致的标题、计数、空状态、加载状态和错误状态。Graph 仍支持展开到 Modal。Observer 警告继续关联到可执行动作，而不是只保存文本。

## 4. 响应式布局

### 4.1 大桌面：宽度不小于 1440px

使用三栏 Operations Canvas：

- Traffic：`clamp(248px, 19vw, 300px)`。
- Agent：`minmax(520px, 1fr)`。
- Knowledge：`clamp(340px, 25vw, 420px)`。
- 工作区间距：8px。

### 4.2 标准桌面：1100px 至 1439px

- 两侧栏压缩到允许范围下限。
- Agent 保证至少 520px。
- Knowledge Tab 可横向滚动，不压缩文字或覆盖操作。

### 4.3 平板和窄桌面：768px 至 1099px

- 默认只显示 Agent。
- Traffic 和 Knowledge 通过带图标与文字的工具按钮打开侧边抽屉。
- 抽屉关闭后焦点返回触发按钮。
- 背景 Scrim 与前景面板保持足够对比。

### 4.4 移动宽度：小于 768px

- 使用单面板布局。
- 顶部通过带文字的导航在 Traffic、Agent 和 Knowledge 之间切换。
- Composer 保持在可视区域底部，不遮挡消息。
- 输入和正文不小于 16px，交互区域不小于 44px。
- 不产生页面级横向滚动。

## 5. 设计系统

### 5.1 字体

- 界面正文、标题、按钮：Geist Sans，中文回退 Noto Sans SC。
- URL、命令、时间、Token、状态码：Geist Mono。
- 桌面正文以 13px 至 14px 为主。
- 面板标题 14px，全局标题 16px。
- 字距统一为 0。
- 数字启用等宽数字特性，避免状态刷新引发布局跳动。

### 5.2 色彩语义

实现时使用语义 Token，不在组件中散落原始色值：

- `background`：冷白灰画布。
- `surface`：白色面板。
- `surface-subtle`：工具条和次级区域。
- `foreground`：深墨色主文字。
- `muted-foreground`：次级说明。
- `primary`：钢蓝色主要操作。
- `success`：运行、成功、已验证。
- `warning`：审批、暂态警告、人工判断。
- `destructive`：错误、停止、拒绝、删除。
- `border` 和 `border-subtle`：面板和内容分隔。
- `ring`：键盘焦点。

正常文本对比度必须达到 WCAG AA 4.5:1。状态不能只依靠颜色表达，必须同时提供文字或图标。

### 5.3 空间、圆角和层级

- 采用 4px/8px 间距体系。
- 工作台面板圆角 6px 至 8px。
- 内部行、工具条和消息不再重复使用大圆角卡片。
- 仅 Modal、Drawer、Popover 和真正浮层使用明显阴影。
- 建立固定 z-index 层级，禁止任意超大 z-index。

### 5.4 图标和控件

- 统一使用现有 Phosphor Icons。
- 同一层级保持一致的线性或填充风格。
- 图标按钮必须提供可访问名称和 Tooltip。
- 明确命令使用图标加文字。
- 桌面图标按钮点击区域至少 36px，窄屏至少 44px。

## 6. 交互与状态

- Hover、Focus、Pressed、Disabled 和 Loading 状态必须完整。
- 微交互使用 150ms 至 220ms 的颜色、透明度或位移动画。
- 不使用导致布局尺寸变化的 Hover 缩放。
- 支持 `prefers-reduced-motion`。
- 异步按钮在请求期间禁用并显示进行中状态。
- Approval、Reject 和 Stop 必须等待接口结果后显示明确结果。
- 网络超时显示原因和重试入口，不显示空白区域。
- 空 Traffic、Facts、Tasks、Graph 和 Observer 均提供说明和相关下一步动作。
- Toast 使用 `aria-live="polite"`，不抢占键盘焦点。
- Modal 和 Drawer 支持 Escape 关闭、焦点约束和关闭后的焦点恢复。

## 7. 组件边界

保留现有模块归属，只做与重设计直接相关的拆分：

- `App.tsx`：工作台组合、响应式面板容器、全局通知。
- `TopBar.tsx`：Case、Run、Token、设置和窄屏面板入口。
- `TrafficPanel.tsx`：Traffic 容器和请求列表。
- `TrafficRow`：请求摘要、展开状态和详情。
- `AgentPanel.tsx`：Run 控制、消息列表和 Composer 编排。
- Agent 子组件：普通消息、Reasoning、工具事件、Approval、Scope、Busy/Run 状态。
- `KnowledgePanel.tsx`：Tab 导航、标题和响应式容器。
- 现有 Knowledge Tab 文件继续负责各自内容。
- `SettingsModal.tsx` 和 `GraphModal.tsx`：适配统一主题和响应式尺寸。

`AgentPanel` 的拆分仅用于降低组件复杂度和提升测试能力，不修改事件格式、API 或 Zustand 业务状态。

## 8. 状态与数据流

- 现有 Zustand Store、API Client 和 WebSocket 数据流保持不变。
- Run、Token、Traffic、Facts、Tasks、Observer 和审批状态继续来自真实后端。
- 仅新增前端展示状态，例如窄屏 Traffic/Knowledge 抽屉是否打开。
- 展示状态不写入后端，不改变 Case 数据格式。
- 页面刷新后继续使用后端持久化的 Run 和 Token 状态，不进行客户端重新估算。

## 9. 错误处理

- 字段错误显示在相关字段下方。
- 面板加载错误显示在对应面板，并提供 Retry。
- Approval、Stop、Steering 和 Scope 操作失败时保留原操作上下文，并允许重试。
- 全局 Toast 只处理无法归属到具体区域的错误。
- Observer Tab 渲染失败不得导致整个 KnowledgePanel 空白。
- Graph 渲染失败显示文本错误和重试入口，不保留空白画布。

## 10. 测试与验证

### 10.1 自动测试

- 保持现有前端测试全部通过。
- 补充消息类型映射、审批状态、停止状态、Tab、面板开关和响应式控制逻辑测试。
- 补充空状态、错误状态和长文本渲染测试。
- 不使用 Mock LLM。任何触发 LLM 的测试必须调用当前配置的真实 LLM。

### 10.2 构建验证

- `tsc --noEmit -p apps/web/tsconfig.json`
- 相关 Vitest 测试。
- `pnpm --filter @traceforge/web build`
- `git diff --check`

### 10.3 真实浏览器验证

使用真实后端和实际 Case 数据验证：

- 1440x900
- 1280x720
- 1024x768
- 768x1024
- 375x812

检查项目：

- 页面无空白、遮挡和横向溢出。
- 面板标题、Tab、按钮、长 URL 和长命令不重叠。
- Traffic 展开、Agent 自动滚动和手动历史查看正常。
- Approval、Reject、Scope、Stop 和 Steering 状态完整。
- Knowledge Tabs、Graph Modal 和 Observer 正常显示。
- Drawer 和移动单面板导航可用。
- 键盘导航、Focus Ring 和 Escape 行为正确。
- Reduced Motion 下不保留非必要动画。

涉及 LLM 的浏览器流程使用已配置的真实 Provider 和模型，禁止 Mock。

## 11. 不在本次范围内

- 不修改后端业务协议。
- 不修改 Agent 推理和工具决策逻辑。
- 不新增深色主题。
- 不新增图表类型或安全功能。
- 不引入新的状态管理、图标、字体或动画依赖。
- 不重构与界面重设计无关的服务端和扩展层代码。

## 12. 完成标准

- 高保真样例中的 Operations Canvas 视觉层级已落实到真实组件。
- 所有现有功能点保持可用。
- 新旧 CSS 主题冲突被消除。
- 所有目标视口完成真实浏览器检查。
- TypeScript、相关 Vitest、生产构建和 `git diff --check` 通过。
- 所有触发 LLM 的验证均使用真实 LLM，无 Mock。
