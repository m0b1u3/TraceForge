# 工作流图谱引擎重做 实施计划（图谱重做 第 2 轮 / 共 3 轮）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans（当前会话直接执行，TDD 节奏）。Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 GraphView 从旧 reactflow v11 换成 @xyflow/react v12 + elkjs，照 flow/ demo 做成浅色白卡片节点（类型徽章+标题+body+N updates，superseded 置灰）+ 流动贝塞尔连线 + elk 层次布局 + 最新 updatedAt 节点聚焦，接真实事件流；buildGraph 节点 meta 透传第 1 轮的 updateCount/updatedAt/validity。对应 spec docs/superpowers/specs/2026-06-26-graph-engine-design.md。

**Architecture:** `@traceforge/shared` 的 buildGraph 给节点 meta 加字段（接口形状不变）。`apps/web` 装 @xyflow/react+elkjs、移除旧 reactflow，重写 GraphView（自定义节点 BwNode、自定义边 EventEdge、elk 异步布局、FocusLatest 聚焦、DetailPanel），app.css 加 `.tf-graph` 作用域浅色样式。GraphTab/GraphModal props 不变。后端零改动。

**Tech Stack:** React 18 + zustand + Vite，新增 `@xyflow/react@^12` + `elkjs@^0.9`（与 flow/ demo 同版本），图标用已装的 @phosphor-icons/react。

## Global Constraints

- 沿用既有约束：TypeScript strict、ESM、`@traceforge/shared` 单源类型、`verbatimModuleSyntax`（类型导入用 import type）。
- **配色边界**：本轮**只图谱区浅色白卡片**（忠于 demo），样式全部用 `.tf-graph` 前缀作用域，不污染周围深色（第 3 轮整体浅色才统一）。
- **接口不破坏**：buildGraph 的 GraphNode/GraphEdge/Graph 形状不变，meta（`Record<string,unknown>`）只多放键。
- **依赖**：装 @xyflow/react@^12 + elkjs@^0.9；移除旧 reactflow（GraphView 是唯一用处）。
- **容错**：elk 抛错回退网格坐标（不白屏）；老数据缺 updateCount 默认 0（不显示 N updates）。
- **前端无测试框架**：唯一单测是 shared 的 buildGraph；GraphView 靠 tsc + vite build + 端到端手测。
- 提交信息结尾附：`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。

**既有约定**（精确）：
- `buildGraph(facts, tasks, actions): Graph`；`GraphNode { id; kind: "fact"|"task"|"action"; label; meta }`。
- Fact 有 updateCount/updatedAt/validity；Task 有 updateCount/updatedAt（第 1 轮）。
- GraphTab/GraphModal 用 `<GraphView interactive={false}/>` / `<GraphView interactive/>`。
- 参照：flow/src/App.tsx（BwNode/CardLabel/EventEdge/layout/FlowCanvas/FitOnChange），flow/src/styles.css（.flow-card/.flow-card-head/.flow-icon/.edge-label/.react-flow/node-in）。

---

### Task 1: shared —— buildGraph 节点 meta 加字段

**Files:**
- Modify: `packages/shared/src/graph.ts`
- Test: `packages/shared/src/graph.test.ts`（扩）

**Interfaces:**
- Produces：buildGraph 的 fact 节点 meta 含 `updateCount/updatedAt/validity`，task 节点 meta 含 `updateCount/updatedAt`，action 不变（tool/status）。GraphNode 接口形状不变。

- [ ] **Step 1: 在 graph.test.ts 加失败测试**

在 `packages/shared/src/graph.test.ts` 末尾（最后一个 `});` 之前的 describe 内）追加一个 it：

```ts
  it("fact/task node meta carries realtime fields (updateCount/updatedAt/validity)", () => {
    const f = { ...fact("f1"), updateCount: 3, updatedAt: "t9", validity: "superseded" as const };
    const t = { ...task("t1"), updateCount: 2, updatedAt: "t8" };
    const g = buildGraph([f], [t], []);
    const fn = g.nodes.find((n) => n.id === "f1")!;
    expect(fn.meta.updateCount).toBe(3);
    expect(fn.meta.updatedAt).toBe("t9");
    expect(fn.meta.validity).toBe("superseded");
    const tn = g.nodes.find((n) => n.id === "t1")!;
    expect(tn.meta.updateCount).toBe(2);
    expect(tn.meta.updatedAt).toBe("t8");
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/shared/src/graph.test.ts`
Expected: FAIL —— meta 不含 updateCount/updatedAt/validity。

- [ ] **Step 3: 改 `packages/shared/src/graph.ts` 的 buildGraph 节点映射**

把 nodes 三行映射改为：
```ts
  const nodes: GraphNode[] = [
    ...facts.map((f): GraphNode => ({ id: f.id, kind: "fact", label: f.title, meta: { type: f.type, confidence: f.confidence, updateCount: f.updateCount, updatedAt: f.updatedAt, validity: f.validity } })),
    ...tasks.map((t): GraphNode => ({ id: t.id, kind: "task", label: t.title, meta: { status: t.status, priority: t.priority, updateCount: t.updateCount, updatedAt: t.updatedAt } })),
    ...actions.map((a): GraphNode => ({ id: a.id, kind: "action", label: a.title, meta: { tool: a.tool, status: a.status } })),
  ];
```

- [ ] **Step 4: 运行确认通过 + 全 shared + tsc**

Run: `pnpm vitest run packages/shared && pnpm --filter @traceforge/shared exec tsc --noEmit -p tsconfig.json`
Expected: graph.test 全绿（含新 it）；tsc 退出码 0。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(shared): buildGraph node meta carries updateCount/updatedAt/validity

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: web —— 换 @xyflow/react+elkjs，重写 GraphView

**Files:**
- Modify: `apps/web/package.json`（加 @xyflow/react+elkjs，移除 reactflow）
- Rewrite: `apps/web/src/components/GraphView.tsx`
- Test: 无单测（tsc + build 校验）

**Interfaces:**
- Consumes: `buildGraph`/`Graph`（shared，Task 1）、store 的 facts/tasks/actions、@xyflow/react、elkjs。
- Produces: `GraphView({ interactive: boolean })`（props 不变，GraphTab/GraphModal 沿用）。

- [ ] **Step 1: 装依赖、移除旧 reactflow**

Run: `cd apps/web && pnpm add @xyflow/react@^12 elkjs@^0.9 && pnpm remove reactflow && cd ../..`
Expected: package.json 出现 @xyflow/react、elkjs；reactflow 移除。

- [ ] **Step 2: 重写 `apps/web/src/components/GraphView.tsx`**

```tsx
import { useEffect, useMemo, useState } from "react";
import {
  Background, BaseEdge, Controls, EdgeLabelRenderer, Handle, MarkerType, Position,
  ReactFlow, ReactFlowProvider, getBezierPath, useReactFlow,
  type Edge, type EdgeProps, type Node, type NodeProps, type NodeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import ELK from "elkjs/lib/elk.bundled.js";
import { Notebook, ShieldCheck, Lightning } from "@phosphor-icons/react";
import { buildGraph, type Graph } from "@traceforge/shared";
import { useStore } from "../store.js";

const elk = new ELK();
const KIND_COLOR: Record<string, string> = { fact: "#047857", task: "#1d4ed8", action: "#7c3aed" };

function clip(v: unknown, max = 96) {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

type NodeData = {
  kind: "fact" | "task" | "action";
  title: string;
  body: string;
  updates: number;
  superseded: boolean;
  meta: Record<string, unknown>;
};

function BwNode({ data }: NodeProps<Node<NodeData>>) {
  const Icon = data.kind === "task" ? ShieldCheck : data.kind === "action" ? Lightning : Notebook;
  return (
    <div className={`flow-card ${data.kind} ${data.superseded ? "superseded" : ""}`}>
      <Handle className="flow-handle" position={Position.Top} type="target" />
      <Handle className="flow-handle" position={Position.Bottom} type="source" />
      <div className="flow-card-head">
        <span className="flow-icon" style={{ color: KIND_COLOR[data.kind] }}><Icon size={13} weight="bold" /></span>
        <div>
          <span style={{ color: KIND_COLOR[data.kind] }}>{data.kind.toUpperCase()}</span>
          <strong>{clip(data.title, 52)}</strong>
        </div>
      </div>
      {data.body && <p>{clip(data.body, 100)}</p>}
      {data.updates > 0 && <small>{data.updates} updates</small>}
    </div>
  );
}
const nodeTypes = { bw: BwNode };

function EventEdge(props: EdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, label } = props;
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const active = (props.data as { active?: boolean } | undefined)?.active === true;
  return (
    <g>
      <path d={path} fill="none" markerEnd={markerEnd}
        style={{ stroke: "#94a3b8", strokeWidth: active ? 2 : 1.25, strokeOpacity: active ? 0.95 : 0.5, strokeDasharray: active ? "9 7" : undefined }}>
        {active ? <animate attributeName="stroke-dashoffset" dur="1.2s" repeatCount="indefinite" values="0;-16" /> : null}
      </path>
      <BaseEdge id={id} path={path} style={{ stroke: "transparent", strokeWidth: 10 }} />
      {label ? (
        <EdgeLabelRenderer>
          <div className="edge-label" style={{ position: "absolute", transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)` }}>{String(label)}</div>
        </EdgeLabelRenderer>
      ) : null}
    </g>
  );
}
const edgeTypes = { event: EventEdge };

function toFlow(graph: Graph): { nodes: Node<NodeData>[]; edges: Edge[]; latestId?: string } {
  let latestId: string | undefined; let latestAt = "";
  const nodes: Node<NodeData>[] = graph.nodes.map((n) => {
    const updatedAt = String(n.meta.updatedAt ?? "");
    if (updatedAt > latestAt) { latestAt = updatedAt; latestId = n.id; }
    const body = n.kind === "fact" ? String(n.meta.type ?? "") : n.kind === "task" ? String(n.meta.status ?? "") : String(n.meta.tool ?? "");
    return {
      id: n.id, type: "bw", position: { x: 0, y: 0 },
      data: { kind: n.kind, title: n.label, body, updates: Number(n.meta.updateCount ?? 0), superseded: n.meta.validity === "superseded", meta: n.meta },
    };
  });
  const edges: Edge[] = graph.edges.map((e) => ({
    id: e.id, source: e.source, target: e.target, type: "event", label: e.label,
    markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: "#64748b" },
    data: { active: e.target === latestId },
  }));
  return { nodes, edges, latestId };
}

async function elkLayout(nodes: Node<NodeData>[], edges: Edge[]): Promise<Node<NodeData>[]> {
  try {
    const g = {
      id: "root",
      layoutOptions: {
        "elk.algorithm": "layered", "elk.direction": "DOWN",
        "elk.spacing.nodeNode": "80", "elk.layered.spacing.nodeNodeBetweenLayers": "120",
        "elk.edgeRouting": "ORTHOGONAL", "elk.padding": "[top=24,left=24,bottom=24,right=24]",
      },
      children: nodes.map((n) => ({ id: n.id, width: 224, height: 104 })),
      edges: edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
    };
    const res = await elk.layout(g);
    return nodes.map((n) => {
      const p = res.children?.find((c) => c.id === n.id);
      return { ...n, position: { x: p?.x ?? 0, y: p?.y ?? 0 }, sourcePosition: Position.Bottom, targetPosition: Position.Top };
    });
  } catch {
    // 回退：简单网格
    return nodes.map((n, i) => ({ ...n, position: { x: (i % 4) * 240, y: Math.floor(i / 4) * 150 } }));
  }
}

function FocusLatest({ latestId, version }: { latestId?: string; version: number }) {
  const { fitView, setCenter, getNode } = useReactFlow();
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const n = latestId ? getNode(latestId) : undefined;
      if (n) void setCenter(n.position.x + 112, n.position.y + 52, { zoom: 0.85, duration: 200 });
      else void fitView({ padding: 0.25, duration: 150 });
    });
    return () => cancelAnimationFrame(raf);
  }, [fitView, setCenter, getNode, latestId, version]);
  return null;
}

function DetailPanel({ graph, nodeId, onClose }: { graph: Graph; nodeId: string; onClose: () => void }) {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) return null;
  const out = graph.edges.filter((e) => e.source === nodeId);
  const inc = graph.edges.filter((e) => e.target === nodeId);
  const labelOf = (id: string) => graph.nodes.find((n) => n.id === id)?.label ?? id;
  return (
    <div className="tf-gdetail">
      <div className="tf-gdetail-head">
        <span style={{ color: KIND_COLOR[node.kind], fontWeight: 600, fontSize: 11, letterSpacing: "0.08em" }}>{node.kind.toUpperCase()}</span>
        <button className="tf-btn" onClick={onClose}>关闭</button>
      </div>
      <div className="tf-gdetail-title">{node.label}</div>
      <div className="tf-gdetail-id">{node.id}</div>
      <div className="tf-gdetail-meta">
        {Object.entries(node.meta).map(([k, v]) => (
          <div key={k} className="tf-gdetail-kv"><span>{k}</span><span>{String(v)}</span></div>
        ))}
      </div>
      {out.length > 0 && <div className="tf-gdetail-rel"><div className="tf-gdetail-rel-h">依赖证据 →</div>{out.map((e) => <div key={e.id} className="tf-gdetail-link">{labelOf(e.target)}</div>)}</div>}
      {inc.length > 0 && <div className="tf-gdetail-rel"><div className="tf-gdetail-rel-h">← 被引用</div>{inc.map((e) => <div key={e.id} className="tf-gdetail-link">{labelOf(e.source)}</div>)}</div>}
    </div>
  );
}

function GraphInner({ interactive }: { interactive: boolean }) {
  const { facts, tasks, actions } = useStore();
  const [selected, setSelected] = useState<string | null>(null);
  const graph = useMemo(() => buildGraph(facts, tasks, actions), [facts, tasks, actions]);
  const flow = useMemo(() => toFlow(graph), [graph]);
  const [laid, setLaid] = useState<Node<NodeData>[]>([]);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let active = true;
    void elkLayout(flow.nodes, flow.edges).then((n) => { if (active) { setLaid(n); setVersion((v) => v + 1); } });
    return () => { active = false; };
  }, [flow]);

  const onNodeClick: NodeMouseHandler = (_e, node) => { if (interactive) setSelected(node.id); };

  if (graph.nodes.length === 0) {
    return <div className="tf-empty" style={{ padding: 12 }}>暂无图谱数据（记录 Fact/Action 后出现）。</div>;
  }
  return (
    <div className="tf-graph" style={{ position: "relative", width: "100%", height: "100%" }}>
      <ReactFlow
        nodes={laid} edges={flow.edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} fitView
        nodesDraggable={false} nodesConnectable={false} elementsSelectable={interactive}
        panOnDrag={interactive} zoomOnScroll={interactive} zoomOnPinch={interactive} minZoom={0.2}
        onNodeClick={onNodeClick} proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{ type: "event" }}
      >
        <FocusLatest latestId={flow.latestId} version={version} />
        <Background color="rgba(148,163,184,0.22)" gap={22} />
        {interactive && <Controls showInteractive={false} />}
      </ReactFlow>
      {interactive && selected && <DetailPanel graph={graph} nodeId={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

export function GraphView({ interactive }: { interactive: boolean }) {
  return <ReactFlowProvider><GraphInner interactive={interactive} /></ReactFlowProvider>;
}
```

> 注：@phosphor-icons 用 `Lightning`（action）、`Database`（fact）、`ShieldCheck`（task）——若某图标名不存在，tsc 会报，换最接近的（如 Lightning→`LightningA` 不对就用 `Bolt`/`Flame`）。Step 3 build 时按 tsc 报错调整。

- [ ] **Step 3: tsc + build**

Run: `pnpm --filter @traceforge/web exec tsc --noEmit -p tsconfig.json && pnpm --filter @traceforge/web build`
Expected: tsc 退出码 0（若 phosphor 图标名报错，按提示换名）；vite 构建成功，产物含 @xyflow/elkjs。

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(web): rewrite GraphView with @xyflow/react v12 + elkjs (BreachWeave-style)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: web —— .tf-graph 作用域浅色样式

**Files:**
- Modify: `apps/web/src/app.css`
- Remove: 旧 GraphView 的 `.tf-gnode*` 样式（已不用）

**Interfaces:**
- Consumes: GraphView 渲染的 `.flow-card`/`.flow-card-head`/`.flow-icon`/`.edge-label`/`.tf-gdetail`（Task 2）。

- [ ] **Step 1: 删旧 `.tf-gnode*` 节点样式块**

在 app.css 找到 `/* Graph 自定义节点：BreachWeave 风深色卡片 */` 那整块（`.tf-gnode` ... `.tf-gnode-h`）删除（已被新节点取代）。保留 `.tf-gdetail*` 详情侧栏样式（Task 2 仍用）。

- [ ] **Step 2: 加 `.tf-graph` 作用域浅色样式**

在 app.css 末尾（`.react-flow__attribution` 那行附近）追加（照 demo styles.css，全部 `.tf-graph` 前缀）：

```css
/* 图谱区：demo 风浅色白卡片（作用域 .tf-graph，不污染周围深色） */
.tf-graph .react-flow { background:
  linear-gradient(90deg, rgba(15,23,42,0.02) 1px, transparent 1px),
  linear-gradient(180deg, rgba(15,23,42,0.02) 1px, transparent 1px), #fbfdff; background-size: 22px 22px; }
.tf-graph .react-flow__controls { overflow: hidden; border: 1px solid #dfe3e8; border-radius: 8px; box-shadow: 0 2px 8px rgba(22,24,29,0.1); }
.tf-graph .react-flow__controls-button { background: #fff; border-bottom: 1px solid #eef1f4; }
.tf-graph .react-flow__controls-button svg { fill: #475467; }
.tf-graph .flow-card { width: 224px; padding: 10px 12px; border: 1.5px solid #d6dbe3; border-radius: 8px; color: #111827; background: #fff; box-shadow: 0 12px 22px rgba(22,24,29,0.12); animation: tf-node-in .18s ease both; }
.tf-graph .flow-card.task { border-color: #c7d2fe; }
.tf-graph .flow-card.action { border-color: #ddd6fe; }
.tf-graph .flow-card.superseded { opacity: 0.55; background: #f3f4f6; }
.tf-graph .flow-card.superseded strong { text-decoration: line-through; }
.tf-graph .flow-handle { width: 1px; height: 1px; border: 0; opacity: 0; pointer-events: none; }
.tf-graph .flow-card-head { display: flex; align-items: flex-start; gap: 9px; min-width: 0; }
.tf-graph .flow-icon { display: grid; place-items: center; flex: 0 0 auto; width: 26px; height: 26px; border: 1px solid #e5e7eb; border-radius: 999px; }
.tf-graph .flow-card-head span:not(.flow-icon) { display: block; font-size: 9px; font-weight: 800; letter-spacing: 0.04em; line-height: 1; }
.tf-graph .flow-card-head strong { display: block; overflow: hidden; margin-top: 4px; color: #101828; font-size: 12px; line-height: 1.22; text-overflow: ellipsis; white-space: nowrap; }
.tf-graph .flow-card p { display: -webkit-box; overflow: hidden; margin: 8px 0 0; color: #475467; font-size: 11px; line-height: 1.35; -webkit-box-orient: vertical; -webkit-line-clamp: 3; }
.tf-graph .flow-card small { display: block; margin-top: 7px; color: #2563eb; font-size: 9.5px; font-weight: 700; }
.tf-graph .edge-label { padding: 3px 6px; border: 1px solid #dfe3e8; border-radius: 6px; color: #475467; background: rgba(255,255,255,0.94); box-shadow: 0 2px 8px rgba(22,24,29,0.08); font-size: 9px; font-weight: 700; pointer-events: none; }
@keyframes tf-node-in { from { opacity: 0; transform: translateY(4px) scale(0.98); } to { opacity: 1; transform: none; } }
```

> 注：`.tf-gdetail*`（详情侧栏）已在 app.css 存在且 GraphView 仍用，保持不动（它是深色侧栏，叠在浅色图谱上对比清晰，可接受；若觉突兀第 3 轮再调）。

- [ ] **Step 3: tsc + build + 全量 build**

Run: `pnpm --filter @traceforge/web build && pnpm -r build`
Expected: vite + 全量构建成功。

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(web): scoped light graph styles (.tf-graph) matching demo

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: 收尾 —— 全量校验、端到端、文档

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 全量测试 + 构建**

Run: `pnpm test && pnpm -r build`
Expected: 全绿（shared graph.test +1 用例）；各包构建无错。

- [ ] **Step 2: 端到端手动验证（真 agent，需 .env key）**

```bash
node --import tsx -e "import('./apps/server/src/main.ts').then(m=>m.buildServer('live.sqlite')).then(a=>a.listen({port:4000,host:'127.0.0.1'}))" > server.log 2>&1 &
sleep 5
# 另起前端 dev：pnpm --filter @traceforge/web dev → 浏览器 http://localhost:5173
# 1) 建 case → 给 agent 目标 → agent 记 fact/task
# 2) 看右栏 Graph Tab：白卡片节点（FACT/TASK 徽章）、elk 自动布局、连线
# 3) agent 带 id 更新 fact（或多轮）→ 节点出现 "N updates"、最新节点聚焦居中
# 4) 标 superseded 的 fact → 节点置灰划线
# 清理：杀后端、删 server.log
```
Expected: 图谱呈 demo 风白卡片 + 流动连线 + elk 布局 + 最新聚焦；N updates 随更新变化。（依赖真 LLM，buildGraph 单测已覆盖数据映射，此步手测。）

- [ ] **Step 3: 更新 `README.md`**

把「实时实体数据机制（工作流图谱重做 第 1 轮 / 共 3 轮）」那条之后追加：
```markdown
- 工作流图谱引擎（图谱重做 第 2 轮 / 共 3 轮）：GraphView 换 @xyflow/react v12 + elkjs 自动布局，照 BreachWeave 风做成浅色白卡片节点（类型徽章 + 标题 + body + N updates，validity=superseded 置灰划线）+ 流动贝塞尔连线 + 最新 updatedAt 节点自动聚焦。节点随真实 agent 事件实时出现/更新。仅图谱区浅色（.tf-graph 作用域），第 3 轮整体浅色化
```

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "docs: update README for graph engine rework (round 2)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## 自检说明（写给计划作者，非执行步骤）

- **Spec 覆盖**：§2 buildGraph 加字段 → Task 1；§3 节点/连线/布局/聚焦 → Task 2（BwNode/EventEdge/elkLayout/FocusLatest）；§4 GraphView 结构 → Task 2；§5 样式作用域 → Task 3（.tf-graph 前缀）；§6 容错 → Task 2（elkLayout catch 回退、updateCount ?? 0）；§7 测试 → Task 1 单测 + Task 4 端到端；§8 理念 → N updates/聚焦/superseded 贯穿；§9 分解 = 本 4 任务。
- **类型一致性**：`GraphNode.meta` 加键（Task 1，Task 2 toFlow 读 meta.updateCount/updatedAt/validity）；`GraphView({interactive})` props 不变（GraphTab/GraphModal 沿用）；`@xyflow/react` 取代 `reactflow` import（Task 2）；KIND_COLOR 键 fact/task/action 与 buildGraph kind 一致。
- **依赖核对**：装 @xyflow/react@^12+elkjs@^0.9（与 flow/ demo 同版本）、移除 reactflow（GraphView 唯一用处，GraphTab/GraphModal 不直接 import reactflow）。
- **作用域隔离**：所有图谱浅色样式 `.tf-graph` 前缀；GraphView 根容器加 `tf-graph` 类——周围深色不受影响（第 3 轮整体浅色才统一）。
- **已知风险**：phosphor 图标名（Lightning/Database/ShieldCheck）若不存在，Task 2 Step 3 tsc 报错时换名；@xyflow v12 的 NodeProps 泛型签名（`NodeProps<Node<NodeData>>`）按 v12 类型，若报错按 IDE 提示调整为 `NodeProps`（data 用 as 断言）。
- **前端无单测**：GraphView 是展示层，靠 tsc+build+手测（沿用前端一贯做法）；唯一单测是 Task 1 的 buildGraph。
