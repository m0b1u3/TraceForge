# TraceForge 工作流图谱引擎重做 设计文档（图谱重做 第 2 轮 / 共 3 轮）

> 状态：设计已确认，待转 writing-plans。第 1 轮（实时实体数据机制）已完成。本轮换图谱引擎；第 3 轮整体浅色化三栏。参照 flow/src/App.tsx（buildKnowledgeGraph/BwNode/EventEdge/layout/FlowCanvas）+ flow/src/styles.css（.flow-card/.edge-label）。

## 1. 范围与架构

把 GraphView 从旧 `reactflow` v11 换成 **`@xyflow/react` v12 + `elkjs` 自动布局**，照 flow/ demo 做成「浅色白卡片节点 + 流动贝塞尔连线 + elk 层次布局 + 最新节点聚焦」，接真实 agent 事件流（fact/task/action 节点随 agent 动态出现/更新）。

**依赖**：装 `@xyflow/react@^12` + `elkjs`；**移除旧 `reactflow`**（GraphView/GraphTab/GraphModal 是唯一用处）。

**改动单元**：
- `packages/shared/src/graph.ts` —— `buildGraph` 给节点 meta 加 updateCount/updatedAt/validity（fact）、updateCount/updatedAt（task），让节点显示「N updates」、灰掉 superseded、按 updatedAt 聚焦。+ 单测。
- `apps/web/src/components/GraphView.tsx` —— **重写**：@xyflow/react、白卡片自定义节点、流动连线、elk 异步布局、最新节点 setCenter 聚焦。
- `apps/web/src/components/knowledge/GraphTab.tsx` / `GraphModal.tsx` —— 适配新 GraphView（props 不变）。
- `apps/web/src/app.css` —— 加图谱区 demo 风浅色样式，作用域限定 `.tf-graph` 前缀（仅图谱区浅色，周围三栏不动）。

**配色边界**：本轮**只图谱区浅色白卡片**（忠于 demo），周围三栏仍深色（第 3 轮整体浅色统一）。

**后端零改动**（第 1 轮已就绪：Fact/Task 有 updateCount/updatedAt/validity、fact_updated 事件）。

## 2. buildGraph 加字段

`packages/shared/src/graph.ts` 节点 meta 透传第 1 轮字段（接口 GraphNode/GraphEdge/Graph 形状不变，meta 是 `Record<string,unknown>` 只多放键，不破坏调用方）：
```ts
fact 节点 meta:   { type, confidence, updateCount, updatedAt, validity }
task 节点 meta:   { status, priority, updateCount, updatedAt }
action 节点 meta: { tool, status }   // action 第 1 轮没加字段，不变
```
其余（节点 id/kind/label、edge source/target/label="evidence"）不变。

## 3. 节点 / 连线 / 布局 / 聚焦契约

**节点卡片**（自定义节点，照 demo BwNode + CardLabel）：
```
[图标] FACT/TASK/ACTION（类型徽章，按 kind 着色）
       <标题>（label，截断）
<body>（fact 用 type、task 用 status、action 用 tool；从 meta 取，截断）
N updates（meta.updateCount > 0 时显示）
validity=superseded 的 fact 节点 → 整卡置灰 + 标题划线
```

**连线**（自定义边，照 demo EventEdge）：贝塞尔曲线 + `evidence` 标注（白药丸居中）；**active 边流动**（指向最新更新节点的边用虚线流动动画 stroke-dashoffset）。

**elk 布局**（照 demo layout()）：`elk.algorithm=layered`、`elk.direction=DOWN`、正交边、节点间距，异步 `elk.layout()` 算坐标后 setNodes。

**聚焦**：每次图变化，找 meta.updatedAt 最新的节点，`setCenter` 居中（@xyflow useReactFlow），interactive 时生效。

## 4. GraphView 重写结构

`apps/web/src/components/GraphView.tsx`（照 demo 拆内部件）：
```
GraphView({ interactive })           外壳：ReactFlowProvider 包住（@xyflow v12 需要）
  ├ BwNode (自定义节点)              白卡片：徽章+标题+body+N updates+superseded 置灰
  ├ EventEdge (自定义边)             贝塞尔+evidence 标注+active 流动
  ├ toFlow(graph)                    Graph → @xyflow nodes/edges（纯转换，含 meta→body/updates 映射）
  ├ useElkLayout(nodes, edges)       elk 异步算坐标（useEffect + elk.layout）
  ├ FocusLatest                      按 meta.updatedAt 最新节点 setCenter（useReactFlow）
  └ DetailPanel                      点节点详情侧栏（沿用现有，适配新节点 data）
```
- `interactive=false`（GraphTab 小图）→ 禁 pan/zoom、fitView 只读。
- `interactive=true`（GraphModal 放大）→ 开缩放拖拽 + 聚焦。
- GraphTab / GraphModal props 不变（仍 `<GraphView interactive={false/true}/>`）。

## 5. 样式（app.css，作用域 .tf-graph）

照 demo styles.css 对应块，作用域限定图谱容器（GraphView 根容器加 `tf-graph` 类，所有图谱样式用 `.tf-graph` 前缀，避免污染周围深色）：
- `.tf-graph .flow-card`：白底 + 深边框 + 圆角 + 阴影 + node-in 入场动画。
- `.tf-graph .flow-card-head`：图标 + 类型徽章 + 标题。
- `.tf-graph .flow-card-meta`：N updates 小字。
- `.tf-graph .flow-card.superseded`：置灰 + 标题划线。
- `.tf-graph .edge-label`：白药丸标注。
- `.tf-graph .react-flow`：浅色网格背景。
- @xyflow 控件深/浅按图谱区浅色。

## 6. 错误处理

| 场景 | 行为 |
|---|---|
| 无节点 | 显示「暂无图谱数据（记录 Fact/Action 后出现）」（沿用） |
| elk 布局抛错 | catch → 回退简单网格坐标（不白屏） |
| meta 字段缺失（老数据无 updateCount） | 默认 0 / 不显示 N updates（容错） |

## 7. 测试

- **buildGraph 单测**（shared，扩 graph.test.ts）：fact 节点 meta 含 updateCount/updatedAt/validity；task 节点含 updateCount/updatedAt；action 节点不含（仍 tool/status）；空输入仍空图。
- **GraphView 渲染**：前端无测试框架 → tsc + `pnpm --filter @traceforge/web build` + 端到端手测（建 case → agent 记 fact / 带 id 更新 → 看节点出现、N updates 变、最新聚焦、superseded 置灰）。

## 8. 核心理念落点（自检）

- **活态工作流图谱**：节点随 agent 事件实时出现/更新，updateCount 显「N updates」（被深挖的热度）、updatedAt 驱动聚焦（跟随 agent 注意力）、validity=superseded 置灰（证据可回退）——落地 demo 那种「实时动态变化的工作流」，对得起第 1 轮数据地基。
- **零硬编码不受影响**：图谱是后端数据的展示层，不含领域判断；节点/边由 buildGraph 现算。
- **后端零改动**：纯前端 + shared buildGraph 透传，复用第 1 轮字段与事件。
- **作用域隔离**：图谱区浅色用 `.tf-graph` 前缀，不污染周围深色（第 3 轮整体浅色再统一）。

## 9. 实现分解（单一 plan）

聚焦单一子系统（图谱引擎），适合一个实施计划，预计任务：
1. shared：buildGraph 节点 meta 加 updateCount/updatedAt/validity + 扩单测
2. web：装 @xyflow/react+elkjs、移除旧 reactflow；GraphView 重写（节点/边/elk/聚焦）
3. web：app.css 加 .tf-graph 作用域浅色样式（白卡片/连线/网格）
4. 收尾：tsc + build + 端到端手测 + README + 设计文档进度
