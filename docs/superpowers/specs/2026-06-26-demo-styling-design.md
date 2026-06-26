# TraceForge 整体照搬 demo 样式 设计文档（图谱重做 第 3 轮 / 共 3 轮）

> 状态：设计已确认，待转 writing-plans。第 1 轮（实时数据）、第 2 轮（图谱引擎）已完成。本轮把整个工作台 UI 照 flow/ demo 重做：移植 demo styles.css 为样式基底，所有组件结构对齐 demo 的 class，深色 tf-* 样式废弃。参照 flow/src/App.tsx（结构）+ flow/src/styles.css（样式，现成、用户认可的质量）。

## 1. 目标与策略

把工作台从「我自拟的深色 tf-* 样式」整体换成「demo 的浅色专业样式」。**策略：直接移植 demo 的 styles.css 为基底，组件结构改成 demo 那套 class**——产出即 demo 质量，不是再发挥。

**取舍**：只搬 demo 的视觉/结构；demo 的「演示专用」部分换成我们的真功能：
- 重放控件（播放/暂停/进度条/1x2x4x）→ **删掉**（我们是真 agent，不重放 mock）。
- 写死的 `BW-0413-77A` run id → 换成我们的 Case 名 / 控制权状态。
- 顶栏假导航 Run/Evidence/Reports → 换成我们的 Case 选择 + 新建 + 统计徽章。
- demo 的 mock events/traffic/messages → 换成我们 store 的真实 facts/tasks/traffic/agentEvents。

**配色边界**：本轮整体浅色，去掉第 2 轮图谱的 `.tf-graph` 作用域限制（整体浅色后图谱区与周围统一）。

## 2. 样式基底（app.css 重做）

以 flow/src/styles.css 为蓝本重写 apps/web/src/app.css：
- **保留 demo 的 :root 变量**：`--bg #f6f7f9` / `--panel #fff` / `--panel-soft` / `--line #dfe3e8` / `--text #16181d` / `--muted #667085` / `--accent #2563eb` / `--green/--amber/--red` / `--shadow`。
- **保留 demo 的全部组件类**：`.app-shell`/`.topbar`/`.brand`/`.run-id`/`.workspace`/`.panel`/`.panel-header`/`.section-kicker`/`.traffic-panel`/`.browser-button`/`.browser-strip`/`.request-*`/`.method`/`.chat-panel`/`.session-state`/`.objective-block`/`.messages`/`.message`/`.tool-strip`/`.composer`/`.graph-panel`/`.graph-header`/`.graph-count`/`.graph-canvas`/`.flow-card*`/`.edge-label`，以及第 2 轮图谱已用的 `.flow-card`（demo 同名，统一）。
- **字体**：保留我们已装的 Geist + Noto Sans SC（demo 用系统字体，我们的更精致，配 demo 浅色更好）。`--font` 用 Geist Sans + Noto Sans SC。
- **新增我们特有的小类**：Case 选择下拉（复用现有 Select 组件，按 demo 浅色改其 CSS）、统计徽章、确认卡（审批/scope）——这些 demo 没有，按 demo 浅色风新写（白底+line 边框+accent）。
- **废弃**：所有深色 `--tf-*` 变量与 `.tf-*` 类（除少数我们特有功能类，按 demo 浅色重写）。

## 3. 组件结构对齐（逐组件）

| 我们的组件 | 对齐 demo 的 | 改动 |
|---|---|---|
| App.tsx（三栏壳） | `.app-shell` + `.topbar` + `.workspace` | 用 demo 的 grid 结构（topbar 56px + workspace 三栏 `304px / minmax(360px,.92fr) / minmax(540px,45vw)`） |
| TopBar | `.topbar`（brand + 中间留白 + run-id 区） | 左 brand；中间放 Case 选择 + 新建；右 run-id 区换成控制权状态 + 统计徽章 |
| TrafficPanel | `.traffic-panel`（panel-header + browser-strip + request-list） | 流量行用 `.request-row`（method 药丸 + 状态码 + 时间 + path + host/size/latency）。我们无 size/latency → 用现有字段（method/status/url），省略没有的 |
| BrowserPanel | demo 的 `.browser-button` + `.browser-strip` | 启动/接管/交回/停止按钮用 `.browser-button` 风；当前 url 用 `.browser-strip` |
| AgentPanel | `.chat-panel`（panel-header + objective-block + messages + tool-strip + composer） | 事件流用 `.message`（agent/operator/trace 三态）；目标输入用 `.composer`；审批/scope 卡按 demo 浅色风 |
| KnowledgePanel | `.graph-panel` 风（panel-header + tabs + body） | Tab 条 + 各 Tab 内容用浅色行样式 |
| GraphView/GraphTab/GraphModal | 已是 demo `.flow-card`（第 2 轮）| 去 `.tf-graph` 作用域，样式合并进全局（整体浅色后统一） |
| Select | demo 浅色下拉 | 触发器/菜单改白底 + line 边框 |
| 各 knowledge Tab（Facts/Tasks/Timeline/MCP/Observer） | demo 行样式 | 浅色行：白底卡片或 divide 行，按 demo `.request-row` 风简化 |
| 首屏 CaseLauncher（无 case 态） | demo 风浅色 | 左文右行动卡片改浅色（white card + line + shadow） |

## 4. 数据流与功能（不变）

后端零改动；store / WS / 各组件的数据与交互逻辑**完全不变**——本轮**只换样式 class 与少量 JSX 结构**（把 `className="tf-x"` 换成 demo 类、调整 DOM 层级贴合 demo）。功能（Case 切换、浏览器控制、agent run、审批、图谱、Tab）保持。

## 5. 错误处理 / 边界

- 我们有而 demo 没有的字段（如流量无 size/latency）→ 省略对应 DOM，不留空位。
- demo 有而我们没有的（重放控件等）→ 不实现。
- 浅色下确保对比度（demo 已是 WCAG 合规的浅色，沿用其色值即可）。
- 详情侧栏（GraphView DetailPanel）→ 改浅色（之前是深色 tf-gdetail，本轮浅色化）。

## 6. 测试

- 前端无测试框架 → tsc + `pnpm --filter @traceforge/web build` + 端到端手测（建 case → 启浏览器 → agent run → 看整体浅色 demo 风、流量/事件/图谱/Tab 都对齐 demo）。
- 后端零改动 → 全量 `pnpm test` 仍全绿（169）。

## 7. 核心理念落点（自检）

- **照 demo 质量**：样式移植 demo styles.css（用户认可），不再自拟——根治「自拟样式廉价」。
- **真功能不变**：演示专用部分换成真 Case/控制权/事件流；后端零改动、数据流不变。
- **整体统一**：去图谱 `.tf-graph` 作用域，整个工作台浅色一致（不再深色里嵌浅色图谱）。

## 8. 实现分解（单一 plan）

聚焦单一子系统（前端整体样式），适合一个实施计划，预计任务：
1. app.css：移植 demo styles.css 为基底（:root 变量 + 全部组件类 + Geist/Noto 字体），废弃深色 tf-*
2. App.tsx + TopBar：三栏壳 + 顶栏对齐 demo（.app-shell/.topbar/.workspace + Case/控制权/徽章）
3. TrafficPanel + BrowserPanel：对齐 demo `.traffic-panel`/`.request-row`/`.browser-*`
4. AgentPanel + Select + CaseLauncher：对齐 demo `.chat-panel`/`.message`/`.composer` + 浅色下拉 + 首屏浅色
5. KnowledgePanel + 各 Tab + GraphView 去作用域 + DetailPanel 浅色：知识区与图谱整体浅色统一
6. 收尾：tsc + build + 端到端手测 + README + 设计文档进度（3 轮收尾）
