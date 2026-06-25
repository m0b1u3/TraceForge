# 整体工作台 UI 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans（当前会话直接执行，TDD 节奏）。Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把当前裸占位前端重构为三栏多面板工作台：顶栏（Case 切换/新建 + 控制权状态）、左栏（共享浏览器 + 流量）、中栏（Agent 对话）、右栏（Facts/Tasks/Timeline/MCP/Graph 五 Tab，Graph 用 React Flow 嵌入小图 + 放大全屏）。后端零改动。对应 spec docs/superpowers/specs/2026-06-24-workbench-ui-design.md。

**Architecture:** `@traceforge/shared` 加纯函数 `buildGraph(facts, tasks, actions): Graph`（领域数据→图结构，单测）。`apps/web` 拆分组件（TopBar/BrowserPanel/TrafficPanel/AgentPanel/KnowledgePanel + GraphView/GraphModal），新增 `app.css` 全局样式与 `reactflow` 依赖，store 扩展（cases/activeTab/graphModalOpen/mcpTools + 进 Case 拉历史数据）。一个 WebSocket → 按 caseId 过滤 → zustand store → 各面板消费。

**Tech Stack:** React 18 + zustand + Vite（沿用），新增 `reactflow`（唯一新前端依赖）+ `app.css` 全局样式。`@traceforge/shared` 用 Vitest 测 buildGraph。

## Global Constraints

- **不推翻已定技术栈**：React 18 + zustand、全局 CSS + 语义 class（不引 Tailwind/CSS-in-JS）、唯一新前端依赖 `reactflow`。
- **面板组件实现用 frontend-design skill**：执行到组件实现任务（Task 3-6）时，先 invoke `frontend-design:frontend-design` 提升视觉/组件质量；但**冲突时以本 spec 技术栈为准**（frontend-design 不得改用别的样式方案或新依赖）。
- **后端零改动**：所有数据经现有 WS 事件 + GET 路由获取（`GET /api/cases`、`/api/cases/:id/{traffic,facts,tasks,timeline}`、`/api/mcp/tools`），不动 apps/server。
- **桌面宽屏**：第一版只保证桌面，不做移动端适配；整页 `height: 100vh`，各面板内部独立滚动。
- **图谱**：统一 React Flow——小栏只读概览（fitView + 禁 pan/zoom），放大共用同一 GraphView 开启缩放拖拽；边 = ActionCard 的 `evidenceRefs`（action→fact，悬空 factId 不生成边）。
- **apps/web 无测试框架**：校验门为 `pnpm --filter @traceforge/web build` + `tsc --noEmit`；唯一单测是 shared 里的 buildGraph。
- 提交信息结尾附：`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。

**既有类型**（来自 `@traceforge/shared`，prop 名精确）：
- `Fact { id, caseId, type: string, title, value, source:{type,ref}, confidence:number, tags:string[], createdAt }`
- `Task { id, caseId, title, status, reason, blockedBy, triggerWhen, relatedFacts, priority, createdAt, updatedAt }`
- `ActionCard { id, caseId, title, goal, evidenceRefs: string[], ..., tool:string, priority, status, createdAt, updatedAt }`
- `Case { id, name, status, scopeRules, createdAt }`
- `McpToolHandle { serverName, toolName, description, inputSchema, trustLevel }`（来自 `@traceforge/extension`）

---

### Task 1: shared —— buildGraph 纯函数

**Files:**
- Create: `packages/shared/src/graph.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/graph.test.ts`

**Interfaces:**
- Consumes: `Fact`/`Task`/`ActionCard`（`./schemas.js`）。
- Produces：
  - `interface GraphNode { id: string; kind: "fact" | "task" | "action"; label: string; meta: Record<string, unknown> }`
  - `interface GraphEdge { id: string; source: string; target: string; label: string }`
  - `interface Graph { nodes: GraphNode[]; edges: GraphEdge[] }`
  - `function buildGraph(facts: Fact[], tasks: Task[], actions: ActionCard[]): Graph` —— 每实体一节点；每个 action 的 evidenceRefs 里每个存在于 facts 的 factId 生成一条 `action.id→factId` label="evidence" 边（悬空 factId 跳过）。

- [ ] **Step 1: 写失败测试 `packages/shared/src/graph.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { buildGraph } from "./graph.js";
import type { Fact, Task, ActionCard } from "./schemas.js";

const fact = (id: string, type = "endpoint"): Fact => ({
  id, caseId: "c", type, title: `fact ${id}`, value: null,
  source: { type: "ai", ref: "" }, confidence: 1, tags: [], createdAt: "t",
});
const task = (id: string): Task => ({
  id, caseId: "c", title: `task ${id}`, status: "open", reason: "", blockedBy: [],
  triggerWhen: [], relatedFacts: [], priority: "medium", createdAt: "t", updatedAt: "t",
});
const action = (id: string, evidenceRefs: string[]): ActionCard => ({
  id, caseId: "c", title: `action ${id}`, goal: "", evidenceRefs, hypothesisRefs: [],
  taskRefs: [], reasoning: "", steps: [], expectedResults: [], riskNotes: [],
  tool: "http_replay", priority: "medium", requiresHumanApproval: true,
  status: "proposed", createdAt: "t", updatedAt: "t",
});

describe("buildGraph", () => {
  it("returns an empty graph for empty inputs", () => {
    expect(buildGraph([], [], [])).toEqual({ nodes: [], edges: [] });
  });

  it("makes one node per entity with the right kind", () => {
    const g = buildGraph([fact("f1")], [task("t1")], [action("a1", [])]);
    expect(g.nodes).toHaveLength(3);
    expect(g.nodes.find((n) => n.id === "f1")?.kind).toBe("fact");
    expect(g.nodes.find((n) => n.id === "t1")?.kind).toBe("task");
    expect(g.nodes.find((n) => n.id === "a1")?.kind).toBe("action");
  });

  it("creates an evidence edge from action to each referenced fact", () => {
    const g = buildGraph([fact("f1"), fact("f2")], [], [action("a1", ["f1", "f2"])]);
    expect(g.edges).toHaveLength(2);
    expect(g.edges).toContainEqual({ id: "a1->f1", source: "a1", target: "f1", label: "evidence" });
    expect(g.edges).toContainEqual({ id: "a1->f2", source: "a1", target: "f2", label: "evidence" });
  });

  it("skips dangling evidenceRefs (fact not present)", () => {
    const g = buildGraph([fact("f1")], [], [action("a1", ["f1", "ghost"])]);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0].target).toBe("f1");
  });

  it("node label carries the entity title and meta carries type/status", () => {
    const g = buildGraph([fact("f1", "credential")], [task("t1")], []);
    expect(g.nodes.find((n) => n.id === "f1")?.label).toBe("fact f1");
    expect(g.nodes.find((n) => n.id === "f1")?.meta.type).toBe("credential");
    expect(g.nodes.find((n) => n.id === "t1")?.meta.status).toBe("open");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/shared/src/graph.test.ts`
Expected: FAIL —— graph 模块不存在。

- [ ] **Step 3: 写 `packages/shared/src/graph.ts`**

```ts
import type { Fact, Task, ActionCard } from "./schemas.js";

export interface GraphNode {
  id: string;
  kind: "fact" | "task" | "action";
  label: string;
  meta: Record<string, unknown>;
}
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label: string;
}
export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export function buildGraph(facts: Fact[], tasks: Task[], actions: ActionCard[]): Graph {
  const nodes: GraphNode[] = [
    ...facts.map((f): GraphNode => ({ id: f.id, kind: "fact", label: f.title, meta: { type: f.type, confidence: f.confidence } })),
    ...tasks.map((t): GraphNode => ({ id: t.id, kind: "task", label: t.title, meta: { status: t.status, priority: t.priority } })),
    ...actions.map((a): GraphNode => ({ id: a.id, kind: "action", label: a.title, meta: { tool: a.tool, status: a.status } })),
  ];
  const factIds = new Set(facts.map((f) => f.id));
  const edges: GraphEdge[] = [];
  for (const a of actions) {
    for (const factId of a.evidenceRefs) {
      if (factIds.has(factId)) {
        edges.push({ id: `${a.id}->${factId}`, source: a.id, target: factId, label: "evidence" });
      }
    }
  }
  return { nodes, edges };
}
```

- [ ] **Step 4: 导出 `packages/shared/src/index.ts`**

在文件末尾追加：

```ts
export * from "./graph.js";
```

- [ ] **Step 5: 运行确认通过 + tsc**

Run: `pnpm vitest run packages/shared/src/graph.test.ts && pnpm --filter @traceforge/shared exec tsc --noEmit -p tsconfig.json`
Expected: 5 用例全绿；tsc 退出码 0。

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(shared): add buildGraph for evidence relationship graph

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: web —— 依赖、全局样式、store/api 扩展

**Files:**
- Modify: `apps/web/package.json`（加 reactflow）, `apps/web/src/main.tsx`（引 app.css）, `apps/web/src/store.ts`, `apps/web/src/api.ts`
- Create: `apps/web/src/app.css`

**Interfaces:**
- Consumes: `buildGraph`（Task 1）、`McpToolHandle`（extension）、`Case`（shared）、现有 store。
- Produces：
  - api：`listCases(): Promise<Case[]>`、`listMcpTools(): Promise<McpToolHandle[]>`。
  - store 新字段：`cases: Case[]`、`activeTab: "facts"|"tasks"|"timeline"|"mcp"|"graph"`、`graphModalOpen: boolean`、`mcpTools: McpToolHandle[]`。
  - store 新方法：`setCases(list)`、`setActiveTab(tab)`、`setGraphModalOpen(open)`、`enterCase(id)`（setCase + 拉历史数据 traffic/facts/tasks/timeline + 拉 mcpTools）。
  - `app.css` 全局样式（语义 class：`.tf-app`、`.tf-topbar`、`.tf-cols`、`.tf-panel` 等 + CSS 变量主题）。

- [ ] **Step 1: 加 reactflow 依赖**

Run: `cd apps/web && pnpm add reactflow && cd ../..`
Expected: package.json 出现 reactflow，安装成功。

- [ ] **Step 2: 写 `apps/web/src/app.css`（全局样式 + 语义 class）**

```css
:root {
  --tf-bg: #0f1115;
  --tf-panel: #171a21;
  --tf-border: #272b34;
  --tf-text: #e3e6eb;
  --tf-muted: #8b91a0;
  --tf-accent: #4f8cff;
  --tf-warn: #e0a020;
  --tf-ok: #3fb27f;
  --tf-err: #e2554a;
}
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, sans-serif; background: var(--tf-bg); color: var(--tf-text); }
.tf-app { display: flex; flex-direction: column; height: 100vh; }
.tf-topbar { display: flex; align-items: center; gap: 12px; padding: 8px 14px; background: var(--tf-panel); border-bottom: 1px solid var(--tf-border); font-size: 13px; }
.tf-topbar .tf-spacer { margin-left: auto; }
.tf-pill { background: var(--tf-bg); border: 1px solid var(--tf-border); border-radius: 6px; padding: 2px 8px; }
.tf-cols { display: grid; grid-template-columns: 1.1fr 1.3fr 1fr; flex: 1; min-height: 0; }
.tf-col { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--tf-border); }
.tf-col:last-child { border-right: none; }
.tf-col-left { display: grid; grid-template-rows: auto 1fr; min-height: 0; }
.tf-panel { display: flex; flex-direction: column; min-height: 0; }
.tf-panel-head { padding: 8px 10px; border-bottom: 1px solid var(--tf-border); font-size: 12px; font-weight: 500; display: flex; align-items: center; gap: 8px; }
.tf-panel-body { flex: 1; overflow: auto; padding: 8px 10px; font-size: 12px; }
.tf-tabs { display: flex; gap: 10px; padding: 8px 10px; border-bottom: 1px solid var(--tf-border); font-size: 12px; }
.tf-tab { color: var(--tf-muted); cursor: pointer; padding-bottom: 2px; background: none; border: none; }
.tf-tab.active { color: var(--tf-text); border-bottom: 2px solid var(--tf-accent); }
.tf-btn { background: var(--tf-bg); border: 1px solid var(--tf-border); color: var(--tf-text); border-radius: 6px; padding: 4px 10px; font-size: 12px; cursor: pointer; }
.tf-btn:hover { border-color: var(--tf-accent); }
.tf-input { background: var(--tf-bg); border: 1px solid var(--tf-border); color: var(--tf-text); border-radius: 6px; padding: 4px 8px; font-size: 12px; }
.tf-row { line-height: 1.9; }
.tf-approval { border: 1px solid var(--tf-warn); border-radius: 6px; padding: 8px; margin: 8px 0; }
.tf-status-2 { color: var(--tf-ok); } .tf-status-3 { color: var(--tf-accent); }
.tf-status-4 { color: var(--tf-warn); } .tf-status-5 { color: var(--tf-err); }
.tf-modal-bg { position: absolute; inset: 0; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; z-index: 10; }
.tf-modal { width: 86vw; height: 80vh; background: var(--tf-panel); border: 1px solid var(--tf-border); border-radius: 8px; display: flex; flex-direction: column; }
.tf-center { display: flex; align-items: center; justify-content: center; height: 100vh; }
.tf-card { background: var(--tf-panel); border: 1px solid var(--tf-border); border-radius: 8px; padding: 20px; display: flex; flex-direction: column; gap: 10px; min-width: 320px; }
```

- [ ] **Step 3: 在 `apps/web/src/main.tsx` 顶部引入样式**

在 main.tsx 现有 import 之后加一行（具体位置：所有 import 末尾）：

```ts
import "./app.css";
```

- [ ] **Step 4: 扩展 `apps/web/src/api.ts`（加两个 GET）**

在文件末尾追加：

```ts
import type { Case } from "@traceforge/shared";
import type { McpToolHandle } from "@traceforge/extension";

export async function listCases(): Promise<Case[]> {
  return (await fetch("/api/cases")).json();
}
export async function listMcpTools(): Promise<McpToolHandle[]> {
  return (await fetch("/api/mcp/tools")).json();
}
```

> 注：若顶部已 `import type { Case ... }`，把 Case 合并进去避免重复 import；McpToolHandle 需 apps/web 依赖 @traceforge/extension——若 package.json 无此依赖，Step 4b 加。

- [ ] **Step 4b: 确认 apps/web 依赖 @traceforge/extension**

Run: `grep '"@traceforge/extension"' apps/web/package.json || (cd apps/web && pnpm add @traceforge/extension@workspace:* && cd ../..)`
Expected: 有则跳过；无则装上。

- [ ] **Step 5: 扩展 `apps/web/src/store.ts`**

在 import 行加 Case/McpToolHandle 类型：把首行
```ts
import type { TrafficEntry, Fact, Task, TimelineEntry, ActionCard, Decision, RuntimeEvent } from "@traceforge/shared";
```
改为：
```ts
import type { TrafficEntry, Fact, Task, TimelineEntry, ActionCard, Decision, RuntimeEvent, Case } from "@traceforge/shared";
import type { McpToolHandle } from "@traceforge/extension";
import { listTraffic, listFacts, listTasks, listTimeline, listMcpTools } from "./api.js";
```

在 `interface State` 里（`pendingApproval` 行后、`browserController` 行前任意处）加字段：
```ts
  cases: Case[];
  activeTab: "facts" | "tasks" | "timeline" | "mcp" | "graph";
  graphModalOpen: boolean;
  mcpTools: McpToolHandle[];
```
在方法区加：
```ts
  setCases: (list: Case[]) => void;
  setActiveTab: (tab: State["activeTab"]) => void;
  setGraphModalOpen: (open: boolean) => void;
  enterCase: (id: string) => Promise<void>;
```

在 store 实现的初值区（`pendingApproval: null,` 附近）加：
```ts
  cases: [],
  activeTab: "facts",
  graphModalOpen: false,
  mcpTools: [],
```
在方法实现区（`clearPendingApproval` 附近）加：
```ts
  setCases: (list) => set({ cases: list }),
  setActiveTab: (tab) => set({ activeTab: tab }),
  setGraphModalOpen: (open) => set({ graphModalOpen: open }),
  enterCase: async (id) => {
    get().setCase(id);
    const [traffic, facts, tasks, timeline, mcpTools] = await Promise.all([
      listTraffic(id), listFacts(id), listTasks(id), listTimeline(id), listMcpTools(),
    ]);
    set({ traffic, facts, tasks, timeline, mcpTools });
  },
```

> `setCase` 已有（重置切片）；`enterCase` 在其上补拉历史数据（WS 只推增量）。

- [ ] **Step 6: 校验 build + tsc**

Run: `pnpm --filter @traceforge/web exec tsc --noEmit -p tsconfig.json`
Expected: tsc 退出码 0（此时 App.tsx 仍是旧版，但新增的 store/api 类型应自洽；若 App.tsx 因旧 import 报错，留待 Task 3 重写——本步只要新增代码无类型错。若旧 App.tsx 阻塞 tsc，跳过此步到 Task 3 末尾统一校验）。

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(web): add reactflow dep, global styles, store/api for workbench

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: web —— TopBar + App.tsx 三栏骨架 + Case 选择

> **执行前先 invoke `frontend-design:frontend-design` skill**（本任务起进入组件实现）。

**Files:**
- Create: `apps/web/src/components/TopBar.tsx`
- Modify: `apps/web/src/App.tsx`

**Interfaces:**
- Consumes: store 的 `cases`/`enterCase`/`setCases`/`browserController`/`browserUrl`、api 的 `listCases`/`createCase`、`connectWs`。
- Produces：
  - `TopBar` 组件：Case 下拉（切换调 enterCase）+「新建 Case」（createCase 后 enterCase）+ 控制权状态条。
  - App.tsx：无 caseId → 居中 Case 选择卡片；有 caseId → `<TopBar/>` + 三栏 `<div class="tf-cols">`（此任务三栏内先放占位 `<div class="tf-col">`，Task 4-6 填充）。

- [ ] **Step 1: 写 `apps/web/src/components/TopBar.tsx`**

```tsx
import { useState, useEffect } from "react";
import { useStore } from "../store.js";
import { listCases, createCase } from "../api.js";

export function TopBar() {
  const { caseId, cases, setCases, enterCase, browserController, browserUrl } = useStore();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("demo");
  const [hosts, setHosts] = useState("example.com");

  useEffect(() => { listCases().then(setCases); }, [setCases]);

  return (
    <div className="tf-topbar">
      <span style={{ fontWeight: 500 }}>TraceForge</span>
      <select className="tf-input" value={caseId ?? ""} onChange={(e) => enterCase(e.target.value)}>
        {!caseId && <option value="">选择 Case…</option>}
        {cases.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <button className="tf-btn" onClick={() => setCreating((v) => !v)}>新建 Case</button>
      {creating && (
        <>
          <input className="tf-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="名称" />
          <input className="tf-input" value={hosts} onChange={(e) => setHosts(e.target.value)} placeholder="allowHosts(逗号)" />
          <button className="tf-btn" onClick={async () => {
            const c = await createCase(name, hosts.split(",").map((h) => h.trim()));
            setCases([...cases, c]);
            await enterCase(c.id);
            setCreating(false);
          }}>创建</button>
        </>
      )}
      <span className="tf-spacer" />
      {caseId && (
        <span className="tf-pill">
          控制权：{browserController === "human" ? "人" : browserController === "llm" ? "LLM" : "未启动"}
          {browserUrl && ` · ${browserUrl}`}
        </span>
      )}
    </div>
  );
}
```

- [ ] **Step 2: 重写 `apps/web/src/App.tsx`（骨架，三栏占位）**

```tsx
import { useEffect } from "react";
import { useStore } from "./store.js";
import { TopBar } from "./components/TopBar.js";

export function App() {
  const { caseId, connectWs } = useStore();
  useEffect(() => { connectWs(); }, [connectWs]);

  if (!caseId) {
    return (
      <div className="tf-center">
        <div className="tf-card">
          <h2 style={{ margin: 0 }}>TraceForge 工作台</h2>
          <p style={{ color: "var(--tf-muted)", margin: 0, fontSize: 13 }}>选择或新建一个 Case 开始。</p>
          <TopBar />
        </div>
      </div>
    );
  }

  return (
    <div className="tf-app">
      <TopBar />
      <div className="tf-cols">
        <div className="tf-col tf-col-left">
          <div className="tf-panel"><div className="tf-panel-head">共享浏览器</div></div>
          <div className="tf-panel"><div className="tf-panel-head">流量</div></div>
        </div>
        <div className="tf-col"><div className="tf-panel-head">Agent 对话</div></div>
        <div className="tf-col"><div className="tf-panel-head">知识</div></div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 校验 build + tsc**

Run: `pnpm --filter @traceforge/web exec tsc --noEmit -p tsconfig.json && pnpm --filter @traceforge/web build`
Expected: tsc 退出码 0；vite 构建成功（旧 App.tsx 的内容已被替换，无残留旧 import）。

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(web): add TopBar and three-column workbench skeleton

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: web —— BrowserPanel + TrafficPanel + AgentPanel

> **沿用 Task 3 的 frontend-design 指引。**

**Files:**
- Create: `apps/web/src/components/BrowserPanel.tsx`, `apps/web/src/components/TrafficPanel.tsx`, `apps/web/src/components/AgentPanel.tsx`
- Modify: `apps/web/src/App.tsx`

**Interfaces:**
- Consumes: store 的 `caseId`/`browserController`/`traffic`/`agentEvents`/`pendingApproval`/`resetAgent`、api 的 `startBrowser`/`stopBrowser`/`takeoverBrowser`/`releaseBrowser`/`runAgent`/`resolveApproval`。
- Produces：三个面板组件，App.tsx 用它们替换 Task 3 的占位 div。

- [ ] **Step 1: 写 `apps/web/src/components/BrowserPanel.tsx`**

```tsx
import { useStore } from "../store.js";
import { startBrowser, stopBrowser, takeoverBrowser, releaseBrowser } from "../api.js";

export function BrowserPanel() {
  const { caseId, browserController } = useStore();
  if (!caseId) return null;
  return (
    <div className="tf-panel">
      <div className="tf-panel-head">共享浏览器</div>
      <div className="tf-panel-body">
        {browserController === null ? (
          <button className="tf-btn" onClick={() => startBrowser(caseId)}>启动浏览器</button>
        ) : (
          <div style={{ display: "flex", gap: 6 }}>
            <button className="tf-btn" onClick={() => stopBrowser(caseId)}>停止</button>
            {browserController === "llm"
              ? <button className="tf-btn" onClick={() => takeoverBrowser(caseId)}>接管</button>
              : <button className="tf-btn" onClick={() => releaseBrowser(caseId)}>交回 LLM</button>}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 写 `apps/web/src/components/TrafficPanel.tsx`**

```tsx
import { useStore } from "../store.js";

export function TrafficPanel() {
  const traffic = useStore((s) => s.traffic);
  return (
    <div className="tf-panel">
      <div className="tf-panel-head">流量 ({traffic.length})</div>
      <div className="tf-panel-body">
        {traffic.map((t) => (
          <div className="tf-row" key={t.id}>
            <span className={`tf-status-${String(t.responseStatus).charAt(0)}`}>{t.responseStatus}</span>{" "}
            {t.method} {t.url}
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 写 `apps/web/src/components/AgentPanel.tsx`**

```tsx
import { useState } from "react";
import { useStore } from "../store.js";
import { runAgent, resolveApproval } from "../api.js";

export function AgentPanel() {
  const { caseId, agentEvents, pendingApproval, resetAgent } = useStore();
  const [goal, setGoal] = useState("看一下已抓的流量，把发现的接口记录为 Fact。");
  if (!caseId) return null;
  return (
    <div className="tf-panel">
      <div className="tf-panel-head">Agent 对话</div>
      <div className="tf-panel-body">
        {pendingApproval && (
          <div className="tf-approval">
            <b>需要确认：</b>{pendingApproval.tool}({pendingApproval.input}){" "}
            <button className="tf-btn" onClick={() => resolveApproval(pendingApproval.approvalId, "approved")}>批准</button>{" "}
            <button className="tf-btn" onClick={() => resolveApproval(pendingApproval.approvalId, "rejected")}>拒绝</button>
          </div>
        )}
        {agentEvents.map((e, i) => (
          <div className="tf-row" key={i}>
            <span style={{ color: e.kind === "error" ? "var(--tf-err)" : e.kind === "tool_call" ? "var(--tf-accent)" : "var(--tf-muted)" }}>[{e.kind}]</span>{" "}
            {e.text}
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 6, padding: "8px 10px", borderTop: "1px solid var(--tf-border)" }}>
        <input className="tf-input" style={{ flex: 1 }} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="给 agent 一个目标…" />
        <button className="tf-btn" onClick={() => { resetAgent(); runAgent(caseId, goal); }}>启动 Agent</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 在 App.tsx 用这三个面板替换占位**

把 App.tsx 的三栏区（Task 3 Step 2 的 `<div className="tf-cols">…</div>`）替换为：

```tsx
      <div className="tf-cols">
        <div className="tf-col tf-col-left">
          <BrowserPanel />
          <TrafficPanel />
        </div>
        <div className="tf-col"><AgentPanel /></div>
        <div className="tf-col"><div className="tf-panel-head">知识</div></div>
      </div>
```

并在 App.tsx 顶部加 import：

```tsx
import { BrowserPanel } from "./components/BrowserPanel.js";
import { TrafficPanel } from "./components/TrafficPanel.js";
import { AgentPanel } from "./components/AgentPanel.js";
```

- [ ] **Step 5: 校验 build + tsc**

Run: `pnpm --filter @traceforge/web exec tsc --noEmit -p tsconfig.json && pnpm --filter @traceforge/web build`
Expected: tsc 退出码 0；vite 构建成功。

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(web): add browser, traffic, and agent panels

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: web —— KnowledgePanel + 文字 Tab（Facts/Tasks/Timeline/MCP）

> **沿用 frontend-design 指引。**

**Files:**
- Create: `apps/web/src/components/KnowledgePanel.tsx`, `apps/web/src/components/knowledge/FactsTab.tsx`, `TasksTab.tsx`, `TimelineTab.tsx`, `McpTab.tsx`
- Modify: `apps/web/src/App.tsx`

**Interfaces:**
- Consumes: store 的 `activeTab`/`setActiveTab`/`facts`/`tasks`/`timeline`/`mcpTools`。
- Produces：`KnowledgePanel`（Tab 容器，含 Graph Tab 占位待 Task 6）。

- [ ] **Step 1: 写四个文字 Tab 组件**

`apps/web/src/components/knowledge/FactsTab.tsx`：
```tsx
import { useStore } from "../../store.js";
export function FactsTab() {
  const facts = useStore((s) => s.facts);
  return <>{facts.map((f) => <div className="tf-row" key={f.id}>[{f.type}] {f.title}</div>)}</>;
}
```

`apps/web/src/components/knowledge/TasksTab.tsx`：
```tsx
import { useStore } from "../../store.js";
export function TasksTab() {
  const tasks = useStore((s) => s.tasks);
  return <>{tasks.map((t) => <div className="tf-row" key={t.id}>[{t.status}] {t.title}</div>)}</>;
}
```

`apps/web/src/components/knowledge/TimelineTab.tsx`：
```tsx
import { useStore } from "../../store.js";
export function TimelineTab() {
  const timeline = useStore((s) => s.timeline);
  return <>{timeline.map((e) => <div className="tf-row" key={e.id}>{e.eventType}: {e.detail}</div>)}</>;
}
```

`apps/web/src/components/knowledge/McpTab.tsx`：
```tsx
import { useStore } from "../../store.js";
export function McpTab() {
  const mcpTools = useStore((s) => s.mcpTools);
  if (mcpTools.length === 0) return <div className="tf-row" style={{ color: "var(--tf-muted)" }}>暂无 MCP 工具（配置 config/mcp.json 后出现）</div>;
  return <>{mcpTools.map((t) => <div className="tf-row" key={`${t.serverName}/${t.toolName}`}>[{t.serverName}] {t.toolName} — {t.description}</div>)}</>;
}
```

- [ ] **Step 2: 写 `apps/web/src/components/KnowledgePanel.tsx`**

```tsx
import { useStore } from "../store.js";
import { FactsTab } from "./knowledge/FactsTab.js";
import { TasksTab } from "./knowledge/TasksTab.js";
import { TimelineTab } from "./knowledge/TimelineTab.js";
import { McpTab } from "./knowledge/McpTab.js";

const TABS = [
  { key: "facts", label: "Facts" }, { key: "tasks", label: "Tasks" },
  { key: "timeline", label: "Timeline" }, { key: "mcp", label: "MCP" },
  { key: "graph", label: "Graph" },
] as const;

export function KnowledgePanel() {
  const { activeTab, setActiveTab } = useStore();
  return (
    <div className="tf-panel">
      <div className="tf-tabs">
        {TABS.map((t) => (
          <button key={t.key} className={`tf-tab ${activeTab === t.key ? "active" : ""}`} onClick={() => setActiveTab(t.key)}>{t.label}</button>
        ))}
      </div>
      <div className="tf-panel-body">
        {activeTab === "facts" && <FactsTab />}
        {activeTab === "tasks" && <TasksTab />}
        {activeTab === "timeline" && <TimelineTab />}
        {activeTab === "mcp" && <McpTab />}
        {activeTab === "graph" && <div className="tf-row" style={{ color: "var(--tf-muted)" }}>图谱待接入</div>}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 在 App.tsx 用 KnowledgePanel 替换右栏占位**

把右栏 `<div className="tf-col"><div className="tf-panel-head">知识</div></div>` 替换为：
```tsx
        <div className="tf-col"><KnowledgePanel /></div>
```
并加 import：
```tsx
import { KnowledgePanel } from "./components/KnowledgePanel.js";
```

- [ ] **Step 4: 校验 build + tsc**

Run: `pnpm --filter @traceforge/web exec tsc --noEmit -p tsconfig.json && pnpm --filter @traceforge/web build`
Expected: tsc 退出码 0；vite 构建成功。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(web): add knowledge panel with facts/tasks/timeline/mcp tabs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: web —— GraphView（React Flow）+ GraphTab 小图 + GraphModal 放大

> **沿用 frontend-design 指引。**

**Files:**
- Create: `apps/web/src/components/GraphView.tsx`, `apps/web/src/components/knowledge/GraphTab.tsx`, `apps/web/src/components/GraphModal.tsx`
- Modify: `apps/web/src/components/KnowledgePanel.tsx`, `apps/web/src/App.tsx`

**Interfaces:**
- Consumes: `buildGraph`（shared）、store 的 `facts`/`tasks`/`actions`/`graphModalOpen`/`setGraphModalOpen`、`reactflow`。
- Produces：
  - `GraphView({ interactive }: { interactive: boolean })` —— 用 buildGraph 派生节点/边喂 React Flow；`interactive=false` 时 fitView + 禁 pan/zoom，`true` 时开启缩放拖拽。
  - `GraphTab` —— 固定高度容器内嵌 `<GraphView interactive={false}/>` +「放大」按钮（setGraphModalOpen(true)）。
  - `GraphModal` —— graphModalOpen 时全屏 `<GraphView interactive/>` + 关闭按钮。

- [ ] **Step 1: 写 `apps/web/src/components/GraphView.tsx`**

```tsx
import { useMemo } from "react";
import ReactFlow, { Background, Controls, type Node, type Edge } from "reactflow";
import "reactflow/dist/style.css";
import { buildGraph } from "@traceforge/shared";
import { useStore } from "../store.js";

const KIND_COLOR: Record<string, string> = { fact: "#3fb27f", task: "#4f8cff", action: "#8b91a0" };

export function GraphView({ interactive }: { interactive: boolean }) {
  const { facts, tasks, actions } = useStore();
  const { nodes, edges } = useMemo(() => {
    const g = buildGraph(facts, tasks, actions);
    const rfNodes: Node[] = g.nodes.map((n, i) => ({
      id: n.id,
      data: { label: `${n.kind}: ${n.label}` },
      position: { x: (i % 4) * 200, y: Math.floor(i / 4) * 120 },
      style: { background: KIND_COLOR[n.kind], color: "#0f1115", border: "none", borderRadius: 6, fontSize: 11, width: 170 },
    }));
    const rfEdges: Edge[] = g.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, label: e.label, animated: true }));
    return { nodes: rfNodes, edges: rfEdges };
  }, [facts, tasks, actions]);

  if (nodes.length === 0) {
    return <div className="tf-row" style={{ color: "var(--tf-muted)" }}>暂无图谱数据（记录 Fact/Action 后出现）</div>;
  }
  return (
    <ReactFlow
      nodes={nodes} edges={edges} fitView
      nodesDraggable={interactive} nodesConnectable={false} elementsSelectable={interactive}
      panOnDrag={interactive} zoomOnScroll={interactive} zoomOnPinch={interactive}
    >
      <Background />
      {interactive && <Controls />}
    </ReactFlow>
  );
}
```

- [ ] **Step 2: 写 `apps/web/src/components/knowledge/GraphTab.tsx`**

```tsx
import { useStore } from "../../store.js";
import { GraphView } from "../GraphView.js";

export function GraphTab() {
  const setGraphModalOpen = useStore((s) => s.setGraphModalOpen);
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 6 }}>
        <button className="tf-btn" onClick={() => setGraphModalOpen(true)}>放大</button>
      </div>
      <div style={{ flex: 1, minHeight: 240, border: "1px solid var(--tf-border)", borderRadius: 6 }}>
        <GraphView interactive={false} />
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 写 `apps/web/src/components/GraphModal.tsx`**

```tsx
import { useStore } from "../store.js";
import { GraphView } from "./GraphView.js";

export function GraphModal() {
  const { graphModalOpen, setGraphModalOpen } = useStore();
  if (!graphModalOpen) return null;
  return (
    <div className="tf-modal-bg" onClick={() => setGraphModalOpen(false)}>
      <div className="tf-modal" onClick={(e) => e.stopPropagation()}>
        <div className="tf-panel-head" style={{ justifyContent: "space-between" }}>
          <span>证据关系图谱</span>
          <button className="tf-btn" onClick={() => setGraphModalOpen(false)}>关闭</button>
        </div>
        <div style={{ flex: 1, minHeight: 0 }}><GraphView interactive /></div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 在 KnowledgePanel 用 GraphTab 替换占位**

把 `KnowledgePanel.tsx` 里
```tsx
        {activeTab === "graph" && <div className="tf-row" style={{ color: "var(--tf-muted)" }}>图谱待接入</div>}
```
改为：
```tsx
        {activeTab === "graph" && <GraphTab />}
```
并加 import：
```tsx
import { GraphTab } from "./knowledge/GraphTab.js";
```

- [ ] **Step 5: 在 App.tsx 挂载 GraphModal**

在三栏 App.tsx 返回的最外层 `<div className="tf-app">…</div>` 里、`</div>` 闭合前加 `<GraphModal />`：
```tsx
      <div className="tf-cols">
        {/* ...三栏... */}
      </div>
      <GraphModal />
    </div>
```
并加 import：
```tsx
import { GraphModal } from "./components/GraphModal.js";
```

- [ ] **Step 6: 校验 build + tsc**

Run: `pnpm --filter @traceforge/web exec tsc --noEmit -p tsconfig.json && pnpm --filter @traceforge/web build`
Expected: tsc 退出码 0；vite 构建成功（reactflow 类型 Node/Edge 解析正常）。

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(web): add React Flow evidence graph with embed + zoom modal

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: 收尾 —— 全量校验、端到端、README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 全量测试 + 构建**

Run: `pnpm test && pnpm -r build`
Expected: 全绿（shared 多 buildGraph 5 用例）；各包构建无错。

- [ ] **Step 2: 端到端手动验证（真实后端 + 前端 dev）**

```bash
# 起后端（独立脚本绕开 main.ts 的 import.meta 判断）
node --import tsx -e "import('./apps/server/src/main.ts').then(m=>m.buildServer('e2e-ui.sqlite')).then(a=>a.listen({port:4000,host:'127.0.0.1'}))" > server.log 2>&1 &
sleep 5
# 另起前端 dev（vite 默认 5173，代理 /api 与 /ws 到 4000——确认 vite.config 有 proxy；若无，前端 fetch 用绝对地址或加 proxy）
pnpm --filter @traceforge/web dev
# 浏览器开 http://localhost:5173：
#  1) 顶栏新建 Case（allowHosts: example.com）→ 进入三栏
#  2) 左栏启动浏览器 → 真窗口弹出，顶栏控制权=LLM；接管→人；交回→LLM；停止
#  3) 中栏给目标启动 Agent → 事件流刷新；危险动作弹审批卡
#  4) 右栏切 Facts/Tasks/Timeline/MCP；切 Graph 看节点；点放大看缩放拖拽
# 清理：杀后端、删 e2e-ui.sqlite* server.log
```
Expected: 三栏联动正常；浏览器控制、agent 对话、知识 Tab、图谱嵌入与放大均работает。

> 注：vite 代理已就绪（`apps/web/vite.config.ts` 已含 `server.proxy`：`/api`→`http://127.0.0.1:4000`、`/ws`→ws 代理），端到端可直连后端，无需额外配置。

- [ ] **Step 3: 更新 `README.md`**

"当前进度"标题追加工作台 UI，并在 MCP 行后追加：

```markdown
- 整体工作台 UI（修订路线第 1 项）：三栏多面板工作台——顶栏（Case 切换/新建 + 控制权状态）+ 左栏（共享浏览器控制 + 流量）+ 中栏（Agent 对话，事件流 + 审批）+ 右栏（Facts/Tasks/Timeline/MCP/Graph 五 Tab）。Graph 用 React Flow 把 Facts/Tasks/Actions 渲染为证据关系图谱（边=evidenceRefs），可嵌入小图 + 点击放大全屏缩放拖拽。取代旧裸占位 UI，后端零改动
```

把测试数量更新为实际值（`pnpm test` 末尾总数）。

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "docs: update README for workbench UI

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## 自检说明（写给计划作者，非执行步骤）

- **Spec 覆盖**：§2 组件结构 → Task 3-6；§3 布局/顶栏 → Task 2(css)+3；§4 面板 → Task 4(浏览器/流量/agent)+5(知识 Tab)；§5 图谱+buildGraph → Task 1(buildGraph)+6(GraphView/Modal)；§6 store/api → Task 2；§7 错误处理 → Task 2(重连留 connectWs 现状)/6(空图提示)；§8 测试 → Task 1 单测 + Task 7 端到端；§10 分解 = 本 7 任务。
- **类型一致性**：`buildGraph(facts,tasks,actions): {nodes,edges}`（Task 1 定义，Task 6 消费）；`GraphNode.kind: "fact"|"task"|"action"`（Task 1 与 Task 6 KIND_COLOR 键一致）；store `activeTab` 五值与 KnowledgePanel TABS 的 key 一致（facts/tasks/timeline/mcp/graph）；`enterCase`（Task 2）被 TopBar（Task 3）调用；`McpToolHandle`（extension）在 api/store/McpTab 一致。
- **frontend-design skill**：全局约束写明 + Task 3-6 各自标注"先 invoke"；边界=不改技术栈。
- **后端零改动核对**：所有 api 都是既有路由（cases/traffic/facts/tasks/timeline/mcp/tools/agent/browser/approvals），无新后端端点。
- **已知风险**：vite 代理已就绪（已核查 vite.config.ts 含 /api 与 /ws proxy）；Task 2 Step 6 的 tsc 在旧 App.tsx 未重写前可能报错，已注明可顺延到 Task 3。
- **WS 既有**：store 的 connectWs 已处理所有 RuntimeEvent（含 browser_*、agent_*、fact/task/timeline、approval），新面板纯消费 store，无需改 WS 逻辑。
