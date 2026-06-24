# TraceForge 整体工作台 UI 设计文档

> 状态：设计已确认，待转 writing-plans 拆为实施计划。对应设计文档第 31.3 节修订路线第 1 项（P0）。

## 1. 目标与定位

把当前裸占位前端（单个 App.tsx + 内联 style + 几张表格）重构为一个**三栏多面板工作台**，整合已端到端可用的三大后端能力：人机共享浏览器（F1/F2）、agent 自主对话（E1/E2）、MCP 工具（Plan C）。并嵌入证据关系图谱（对应设计文档阶段 7 的形态，参考 BreachWeave 的 flow 图谱）。

**核心交互画面**：人看着共享浏览器、盯着 agent 自主推理、随时查知识面板（Facts/Tasks/Timeline/MCP/Graph），三者并列常驻——落地设计文档 3.4/10.2「人实时观察 AI、随时介入」。

## 2. 架构与组件结构

**技术栈**：React 18 + zustand + Vite（沿用），新增 `app.css`（全局样式：CSS 变量主题色 + 语义 class）和 **`reactflow`**（唯一新前端依赖，做图谱）。

**组件拆分**（`apps/web/src/`）：
```
App.tsx                  — 无 Case→Case 选择/新建；有 Case→三栏布局
components/
  TopBar.tsx             — logo + Case 下拉（切换/新建）+ 控制权状态条
  BrowserPanel.tsx       — 左上：共享浏览器控制（启动/停止/接管/交回 + URL）
  TrafficPanel.tsx       — 左下：流量列表
  AgentPanel.tsx         — 中栏：Agent 对话（事件流 + 目标输入 + 审批弹窗）
  KnowledgePanel.tsx     — 右栏：Tab 容器
  knowledge/
    FactsTab.tsx / TasksTab.tsx / TimelineTab.tsx / McpTab.tsx — 文字列表
    GraphTab.tsx         — 嵌入 GraphView（小尺寸只读）+「放大」按钮
  GraphView.tsx          — React Flow 图谱组件（尺寸/交互可配）
  GraphModal.tsx         — 全屏放大：同一 GraphView 开启缩放拖拽
api.ts / store.ts / app.css
```

**职责边界**：每个面板只读 store 的一个切片 + 调对应 api，互不依赖。App.tsx 只管布局和 Case 选择，不含业务逻辑。

**数据流**：一个 WebSocket（`connectWs()`）订阅所有 RuntimeEvent → 按 `caseId` 过滤 → 更新 zustand store → 各面板 `useStore` 读各自切片。**后端零改动**——所有数据已在库、已有 WS 事件与 GET 路由。

## 3. 三栏布局与顶栏

**布局**（CSS grid，占满视口高）：
```
┌─ TopBar ─────────────────────────────────────────────┐
│ logo  Case▾  [新建]              控制权:LLM │ /url   │
├──────────────┬───────────────────┬───────────────────┤
│ BrowserPanel │                   │  KnowledgePanel   │
│ (左上)       │   AgentPanel      │  [Facts|Tasks|    │
├──────────────┤   (中栏,最宽)    │   Timeline|MCP|   │
│ TrafficPanel │                   │   Graph]          │
│ (左下)       │                   │                   │
└──────────────┴───────────────────┴───────────────────┘
```
- 外层 `grid-template-columns: 1.1fr 1.3fr 1fr`，中栏最宽。
- 左栏内部上下分（Browser 固定高、Traffic 撑满剩余可滚）。
- 整页 `height: 100vh`，各面板内部独立滚动，页面本身不滚。
- 第一版只保证桌面宽屏，不做移动端适配。

**TopBar**：
- 左：logo + Case 下拉（`GET /api/cases` 填充，选中即 `setCase` 切换）+「新建 Case」（弹小输入：名称 + allowHosts）。
- 右：控制权状态条（复用 F2 的 `browserController`/`browserUrl`），显示「控制权:LLM/人 + 当前 URL」。

**无 Case 态**：App.tsx 显示居中卡片——Case 下拉（选已有）或「新建 Case」表单。选/建完进入三栏。

## 4. 各面板内容

**BrowserPanel（左上）**：F2 已有控制——启动/停止/接管/交回按钮 + 当前 URL。

**TrafficPanel（左下）**：流量列表，每行 `method · status · url`（status 按 2xx/3xx/4xx/5xx 着色）。

**AgentPanel（中栏）**：
- 顶部：目标输入框 +「启动 Agent」。
- 中部：事件流（复用 `agentEvents`）——text/tool_call/tool_result/done/error 分色，自动滚到底。
- 审批：`pendingApproval` 存在时在对话流插橙色卡片（工具名+入参+批准/拒绝），复用 F2/E2 逻辑。

**KnowledgePanel（右栏）**：Tab 容器，6 个 Tab：
- `Facts` / `Tasks` / `Timeline`：文字列表（沿用现有渲染，加类型/状态着色）。
- `MCP`：`GET /api/mcp/tools` 列出当前 MCP 工具池（serverName / toolName / 描述）。
- `Graph`：嵌入小尺寸只读 GraphView + 右上「放大」→ 打开 GraphModal 全屏。

## 5. 图谱（GraphView，React Flow）

参考 BreachWeave 的证据关系图谱形态。

- **节点**：Facts（按 `type` 着色）、Tasks（按 `status` 着色）、Actions（中性色）。节点显示类型徽章 + 标题摘要。
- **边**：ActionCard 的每个 `evidenceRefs[i]` → 一条 `action → fact` 边（标 `evidence`，即 BreachWeave 的 distilled 关系）。
- **小尺寸**（GraphTab 内）：`fitView`、禁用 pan/zoom、节点只读，纯概览。
- **放大**（GraphModal）：同一 GraphView 开启缩放/拖拽，点节点弹详情（标题/类型/置信度/关联），右下角 React Flow 自带缩放控件。
- **数据派生**：`buildGraph(facts, tasks, actions)` 纯函数从 store 现算节点和边；`useMemo` 包裹，WS 事件更新 store 时图自动重算。后端无需改动。

**buildGraph 契约**（纯函数，放 `@traceforge/shared`）：
```ts
interface GraphNode { id: string; kind: "fact" | "task" | "action"; label: string; meta: Record<string, unknown> }
interface GraphEdge { id: string; source: string; target: string; label: string }
interface Graph { nodes: GraphNode[]; edges: GraphEdge[] }
function buildGraph(facts: Fact[], tasks: Task[], actions: ActionCard[]): Graph
```
- 每个 Fact/Task/Action 一个节点（id 用各自的实体 id，kind 标类型）。
- 每个 action 的 `evidenceRefs` 数组里每个 factId，生成一条 `action.id → factId`、label="evidence" 的边（仅当该 factId 存在于 facts 中，避免悬空边）。

## 6. store / api 改动

**store.ts**（其余状态复用）：
- 加 `cases: Case[]` + `setCases(list)`、`activeTab: string`、`graphModalOpen: boolean`、`mcpTools: McpToolHandle[]`。
- `setCase` 切换时：重置该 Case 数据切片（已有）+ 触发拉该 Case 初始数据（traffic/facts/tasks/timeline，因 WS 只推增量，进 Case 要先 GET 现状）+ 拉 mcpTools。

**api.ts**：
- 加 `listCases()`、`listMcpTools()`。
- 已有的 `listTraffic/listFacts/listTasks/listTimeline` 在进 Case 时调用（补全 WS 增量前的历史）。

## 7. 错误处理

- WS 断线：`onclose` 时 setTimeout 简单重连（重建连接）。第一版不做复杂退避。
- 某 api 拉取失败：该面板显示空 + 一行「加载失败」，不崩整页。
- 图谱无数据：GraphView 显示「暂无图谱数据（记录 Fact/Action 后出现）」。
- React Flow 容器：小栏里用固定高度容器，避免 0 高度警告。

## 8. 测试

apps/web 无测试框架，沿用 build + 手动验证：
- **校验门**：`pnpm --filter @traceforge/web build`（vite）+ 显式 `tsc --noEmit -p tsconfig.json`。
- **buildGraph 单测**：放 `@traceforge/shared`（已有 vitest），测节点/边推导——每实体一节点、evidenceRefs 生成边、悬空 factId 不生成边、空输入返回空图。
- **端到端手动**：起后端 + 前端 dev，建 Case → 启浏览器（真窗口）→ 跑 agent → 看三栏联动 + Graph Tab 出节点 + 放大缩放。

## 9. 核心理念落点（自检）

- **人机协同**：三栏让「共享浏览器 ↔ agent 推理 ↔ 知识」并列常驻，人实时观察、随时接管浏览器（顶栏控制权 + BrowserPanel 操作）。
- **证据驱动可视化**：图谱的边 = evidenceRefs，把「每个动作都有证据依据」这条硬规则可视化为 action→fact 连线（设计文档「每个结果都能回到图谱」）。
- **零硬编码不受影响**：UI 是后端能力的展示层，不含任何领域判断逻辑；MCP/浏览器/agent 工具仍由 LLM 自主编排。
- **后端零改动**：工作台纯前端重构，所有数据经现有 WS 事件 + GET 路由获取，不动后端。

## 10. 实现分解（单一 plan）

聚焦单一子系统（前端工作台），适合一个实施计划，预计任务：
1. shared：`buildGraph` 纯函数 + 单测
2. web：app.css 全局样式 + store/api 扩展（cases/tabs/mcpTools + listCases/listMcpTools + 进 Case 拉初始数据）
3. web：TopBar + App.tsx 三栏布局骨架 + Case 选择（无 Case 态）
4. web：BrowserPanel + TrafficPanel + AgentPanel（左栏 + 中栏，复用现有逻辑迁移到组件）
5. web：KnowledgePanel + 5 个文字 Tab（Facts/Tasks/Timeline/MCP）
6. web：GraphView（React Flow）+ GraphTab 小图 + GraphModal 放大；加 reactflow 依赖
7. 收尾：全量 build + 端到端手测 + README
```