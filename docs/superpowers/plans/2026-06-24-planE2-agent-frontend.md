# Plan E2：agent 前端对话流 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans（本计划在当前会话由控制者直接执行，TDD 节奏）。Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把前端从"候选确认 UI"换成"agent 对话流"：人在对话区给目标启动 agent，事件流实时显示 agent 调工具的活动，approval_requested 时弹确认按钮；保留 Facts/Tasks/Timeline 只读面板（靠现有 WebSocket 事件自动刷新）。删除调用已删后端路由的旧候选 UI（前端当前是坏的）。对应设计 docs/superpowers/specs/2026-06-24-agent-driven-interaction-design.md 的 Plan E2。

**Architecture:** `apps/web` 改造：`api.ts` 删候选 API、加 `runAgent`/`resolveApproval`；`store.ts` 删候选 state、加 `agentEvents` + 新 agent 事件的 WS 处理；`App.tsx` 删候选确认 UI、加对话区（输入目标 → 启动 agent）+ 事件流列表 + approval 弹窗，保留 Traffic/Facts/Tasks/Timeline 面板。纯前端改动，后端不动。

**Tech Stack:** 沿用前序（React、Zustand、Vite、TypeScript）。前端无单测框架（沿用：tsc + 构建 + 端到端验证）。

## Global Constraints

- 沿用全部既有约束：Node ≥ 22、pnpm、ESM、`strict: true`、`@traceforge/shared` 单源类型。
- **后端不动**：本计划只改 `apps/web`。
- **前端复用现有 WS 事件机制**：Facts/Tasks/Timeline 面板通过 `fact_created`/`task_created`/`timeline_appended` 等事件刷新（这些事件 agent 工具会 emit），面板逻辑基本不变。
- **删除坏掉的候选 UI**：候选 Fact/Action 列表 + confirm/reject/approve 按钮调用的后端路由已在 Plan E1 删除，必须移除。
- 提交信息结尾附：`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。

---

### Task 1: api.ts —— 删候选 API，加 agent API

**Files:**
- Modify: `apps/web/src/api.ts`

**Interfaces:**
- Consumes: 后端 agent 路由（Plan E1）。
- Produces：
  - `runAgent(caseId: string, goal: string): Promise<Response>` → `POST /api/cases/:id/agent/run`
  - `resolveApproval(approvalId: string, decision: "approved" | "rejected"): Promise<Response>` → `POST /api/agent/approvals/:id`
  - 删除：`extractCandidates`/`confirmCandidate`/`rejectCandidate`/`planActions`/`approveAction`/`rejectAction`（调用已删后端路由）。
  - 保留：`createCase`/`openUrl`/`listTraffic`/`createFact`/`listFacts`/`createTask`/`listTasks`/`patchTask`/`listTimeline`（基础 CRUD 仍有后端路由）。

- [ ] **Step 1: 删除候选相关 api 函数**

在 `apps/web/src/api.ts` 中删除以下函数（连同它们的 import 类型如不再用到）：`extractCandidates`、`confirmCandidate`、`rejectCandidate`、`planActions`、`approveAction`、`rejectAction`。

- [ ] **Step 2: 追加 agent API 函数**

```ts
export async function runAgent(caseId: string, goal: string): Promise<Response> {
  return fetch(`/api/cases/${caseId}/agent/run`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ goal }),
  });
}

export async function resolveApproval(approvalId: string, decision: "approved" | "rejected"): Promise<Response> {
  return fetch(`/api/agent/approvals/${approvalId}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision }),
  });
}
```

- [ ] **Step 3: 清理未用 import**

删除 api.ts 顶部 import 中不再用到的类型（`CandidateFact`、`ActionCard`、`Decision` 若仅候选用到则删；`Fact`/`Task`/`TimelineEntry`/`TrafficEntry`/`Case` 保留）。运行 tsc 确认（下个任务统一验证）。

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(web): replace candidate api with agent run/approval api

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: store.ts —— 删候选 state，加 agent 事件流

**Files:**
- Modify: `apps/web/src/store.ts`

**Interfaces:**
- Consumes: `RuntimeEvent`（含 Plan E1 新 agent 事件）。
- Produces：
  - State 删除：`candidates`/`actionCandidates`/`setCandidates`/`removeCandidate`/`setActionCandidates`/`removeActionCandidate`。
  - State 保留/调整：`actions`/`decisions`（agent 的 `action_recorded` 事件 push 到 actions），`addAction`/`addDecision` 保留。
  - State 新增：`agentEvents: AgentUiEvent[]`、`pendingApproval: { approvalId: string; tool: string; input: string } | null`、`addAgentEvent`、`setPendingApproval`、`clearPendingApproval`、`resetAgent`。
  - `interface AgentUiEvent { kind: "text" | "tool_call" | "tool_result" | "done" | "error" | "started"; text: string }`
  - WS 处理删除：`candidates_extracted`/`action_candidates_generated`/`action_approved`（旧）。
  - WS 处理新增：`agent_started`/`agent_text`/`agent_tool_call`/`agent_tool_result`/`agent_done`/`agent_error`（→ addAgentEvent）、`approval_requested`（→ setPendingApproval）、`approval_resolved`（→ clearPendingApproval）、`action_recorded`（→ addAction）。

- [ ] **Step 1: 改写 `apps/web/src/store.ts`**

```ts
import { create } from "zustand";
import type { TrafficEntry, Fact, Task, TimelineEntry, ActionCard, Decision, RuntimeEvent } from "@traceforge/shared";

export interface AgentUiEvent {
  kind: "text" | "tool_call" | "tool_result" | "done" | "error" | "started";
  text: string;
}

interface State {
  caseId: string | null;
  traffic: TrafficEntry[];
  facts: Fact[];
  tasks: Task[];
  timeline: TimelineEntry[];
  actions: ActionCard[];
  decisions: Decision[];
  agentEvents: AgentUiEvent[];
  pendingApproval: { approvalId: string; tool: string; input: string } | null;
  setCase: (id: string) => void;
  addEntry: (e: TrafficEntry) => void;
  addFact: (f: Fact) => void;
  upsertTask: (t: Task) => void;
  addTimeline: (e: TimelineEntry) => void;
  addAction: (a: ActionCard) => void;
  addDecision: (d: Decision) => void;
  addAgentEvent: (e: AgentUiEvent) => void;
  setPendingApproval: (p: { approvalId: string; tool: string; input: string }) => void;
  clearPendingApproval: () => void;
  resetAgent: () => void;
  connectWs: () => void;
}

export const useStore = create<State>((set, get) => ({
  caseId: null,
  traffic: [],
  facts: [],
  tasks: [],
  timeline: [],
  actions: [],
  decisions: [],
  agentEvents: [],
  pendingApproval: null,
  setCase: (id) => set({ caseId: id, traffic: [], facts: [], tasks: [], timeline: [], actions: [], decisions: [], agentEvents: [], pendingApproval: null }),
  addEntry: (e) => set((s) => ({ traffic: [...s.traffic, e] })),
  addFact: (f) => set((s) => ({ facts: [...s.facts, f] })),
  upsertTask: (t) =>
    set((s) => {
      const i = s.tasks.findIndex((x) => x.id === t.id);
      if (i === -1) return { tasks: [...s.tasks, t] };
      const copy = s.tasks.slice();
      copy[i] = t;
      return { tasks: copy };
    }),
  addTimeline: (e) => set((s) => ({ timeline: [...s.timeline, e] })),
  addAction: (a) => set((s) => ({ actions: [...s.actions, a] })),
  addDecision: (d) => set((s) => ({ decisions: [...s.decisions, d] })),
  addAgentEvent: (e) => set((s) => ({ agentEvents: [...s.agentEvents, e] })),
  setPendingApproval: (p) => set({ pendingApproval: p }),
  clearPendingApproval: () => set({ pendingApproval: null }),
  resetAgent: () => set({ agentEvents: [], pendingApproval: null }),
  connectWs: () => {
    const ws = new WebSocket(`ws://${location.host}/ws`);
    ws.onmessage = (msg) => {
      const event = JSON.parse(msg.data) as RuntimeEvent;
      const cid = get().caseId;
      if (event.type === "response_captured" && event.entry.caseId === cid) get().addEntry(event.entry);
      else if (event.type === "fact_created" && event.fact.caseId === cid) get().addFact(event.fact);
      else if (event.type === "task_created" && event.task.caseId === cid) get().upsertTask(event.task);
      else if (event.type === "task_updated" && event.task.caseId === cid) get().upsertTask(event.task);
      else if (event.type === "timeline_appended" && event.entry.caseId === cid) get().addTimeline(event.entry);
      else if (event.type === "action_recorded" && event.action.caseId === cid) get().addAction(event.action);
      else if (event.type === "decision_recorded" && event.decision.caseId === cid) get().addDecision(event.decision);
      else if (event.type === "agent_started" && event.caseId === cid) get().addAgentEvent({ kind: "started", text: `开始：${event.goal}` });
      else if (event.type === "agent_text" && event.caseId === cid) get().addAgentEvent({ kind: "text", text: event.content });
      else if (event.type === "agent_tool_call" && event.caseId === cid) get().addAgentEvent({ kind: "tool_call", text: `${event.tool}(${event.input})` });
      else if (event.type === "agent_tool_result" && event.caseId === cid) get().addAgentEvent({ kind: "tool_result", text: `${event.tool} → ${event.content}` });
      else if (event.type === "agent_done" && event.caseId === cid) get().addAgentEvent({ kind: "done", text: event.content });
      else if (event.type === "agent_error" && event.caseId === cid) get().addAgentEvent({ kind: "error", text: event.content });
      else if (event.type === "approval_requested" && event.caseId === cid) get().setPendingApproval({ approvalId: event.approvalId, tool: event.tool, input: event.input });
      else if (event.type === "approval_resolved" && event.caseId === cid) get().clearPendingApproval();
    };
  },
}));
```

- [ ] **Step 2: Commit**

```bash
git add -A && git commit -m "feat(web): replace candidate store state with agent event stream and approvals

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: App.tsx —— 对话流 UI 替换候选 UI

**Files:**
- Modify: `apps/web/src/App.tsx`

**Interfaces:**
- Consumes: store（Task 2）、api（Task 1）。
- Produces：App.tsx 渲染——给目标输入框 + 启动 agent 按钮、agent 事件流列表、approval 弹窗（pendingApproval 非空时）、保留 Traffic/Facts/Tasks/Timeline/Decisions 只读面板。删除候选确认 UI 与对其的所有引用。

- [ ] **Step 1: 改写 `apps/web/src/App.tsx`**

```tsx
import { useEffect, useState } from "react";
import { useStore } from "./store.js";
import { createCase, openUrl, runAgent, resolveApproval } from "./api.js";

export function App() {
  const {
    caseId, traffic, facts, tasks, timeline, actions, decisions,
    agentEvents, pendingApproval, setCase, connectWs, resetAgent,
  } = useStore();
  const [name, setName] = useState("demo");
  const [hosts, setHosts] = useState("example.com");
  const [url, setUrl] = useState("https://example.com/");
  const [goal, setGoal] = useState("看一下已抓的流量，把发现的接口记录为 Fact。");

  useEffect(() => { connectWs(); }, [connectWs]);

  if (!caseId) {
    return (
      <div style={{ fontFamily: "sans-serif", padding: 16 }}>
        <h1>TraceForge</h1>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="case name" />
        <input value={hosts} onChange={(e) => setHosts(e.target.value)} placeholder="allow hosts (comma)" />
        <button onClick={async () => {
          const c = await createCase(name, hosts.split(",").map((h) => h.trim()));
          setCase(c.id);
        }}>Create Case</button>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "sans-serif", padding: 16 }}>
      <h1>TraceForge</h1>
      <p>Case: {caseId}</p>

      <h2>抓流量</h2>
      <input value={url} onChange={(e) => setUrl(e.target.value)} style={{ width: 360 }} />
      <button onClick={() => openUrl(caseId, url)}>Open</button>
      <table border={1} cellPadding={4}>
        <thead><tr><th>Method</th><th>Status</th><th>URL</th></tr></thead>
        <tbody>
          {traffic.map((t) => (
            <tr key={t.id}><td>{t.method}</td><td>{t.responseStatus}</td><td>{t.url}</td></tr>
          ))}
        </tbody>
      </table>

      <h2>Agent</h2>
      <textarea value={goal} onChange={(e) => setGoal(e.target.value)} style={{ width: 480, height: 50 }} />
      <div>
        <button onClick={() => { resetAgent(); runAgent(caseId, goal); }}>启动 Agent</button>
      </div>
      {pendingApproval && (
        <div style={{ border: "2px solid orange", padding: 8, margin: "8px 0" }}>
          <b>需要确认：</b>{pendingApproval.tool}({pendingApproval.input}){" "}
          <button onClick={() => resolveApproval(pendingApproval.approvalId, "approved")}>批准</button>{" "}
          <button onClick={() => resolveApproval(pendingApproval.approvalId, "rejected")}>拒绝</button>
        </div>
      )}
      <h3>Agent 活动 ({agentEvents.length})</h3>
      <ul>
        {agentEvents.map((e, i) => (
          <li key={i}>
            <span style={{ color: e.kind === "error" ? "red" : e.kind === "tool_call" ? "blue" : "black" }}>
              [{e.kind}]
            </span>{" "}
            {e.text}
          </li>
        ))}
      </ul>

      <h2>Facts ({facts.length})</h2>
      <ul>{facts.map((f) => <li key={f.id}>[{f.type}] {f.title}</li>)}</ul>

      <h2>Tasks ({tasks.length})</h2>
      <ul>{tasks.map((t) => <li key={t.id}>[{t.status}] {t.title}</li>)}</ul>

      <h2>Actions ({actions.length})</h2>
      <ul>{actions.map((a) => <li key={a.id}>[{a.tool}/{a.priority}] {a.title}</li>)}</ul>

      <h2>Decisions ({decisions.length})</h2>
      <ul>{decisions.map((d) => <li key={d.id}>{d.decision} ← {d.basedOn.join(", ")}</li>)}</ul>

      <h2>Timeline ({timeline.length})</h2>
      <ol>{timeline.map((e) => <li key={e.id}>{e.eventType}: {e.detail}</li>)}</ol>
    </div>
  );
}
```

- [ ] **Step 2: tsc + 构建**

Run: `pnpm --filter @traceforge/web exec tsc --noEmit -p tsconfig.json && pnpm --filter @traceforge/web build`
Expected: tsc 退出码 0（候选 UI 引用已清除）；Vite 构建成功。

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat(web): replace candidate UI with agent conversation flow and approval prompt

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: 阶段收尾 —— 全量校验、端到端、README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 全量测试 + 构建**

Run: `pnpm test && pnpm -r build`
Expected: 全绿（后端测试不变 77）；各包构建无错误（web 构建通过）。

- [ ] **Step 2: 端到端手动验证（需真实 LLM + config/llm.json）**

Run（两个终端）:
```bash
# 终端 1
cd "E:/learn/TraceForge" && pnpm dev:server
# 终端 2
cd "E:/learn/TraceForge" && pnpm dev:web
```
浏览器开 `http://localhost:5173`：建 Case（allow host example.com）→ 抓流量区 Open `https://example.com/` → Agent 区填目标"把已抓的接口记录为 Fact"→ 点"启动 Agent"→ 观察 Agent 活动流实时显示 LLM 调工具、Facts 面板出现 agent 记录的 Fact。
Expected: Agent 活动流显示工具调用与结果；Facts 面板实时出现 agent 记的 Fact。（无 config/llm.json 时 agent 用空 Mock 不调工具，活动流仅显示 started/done——此时验证前端不报错、不调用已删路由即可。）

- [ ] **Step 3: 更新 `README.md`**

把 "前端对话流 UI 见 Plan E2" 改为已完成描述：

```markdown
- agent 前端对话流（Plan E2）：人在对话区给目标启动 agent，事件流实时显示 agent 调工具活动，危险动作弹确认；Facts/Tasks/Timeline 面板实时刷新。旧候选确认 UI 已移除
```

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "docs: update README for agent frontend (Plan E2)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## 自检说明（写给计划作者，非执行步骤）

- **Spec 覆盖**：对应 agent 重构设计 spec §5 前端全部内容——对话区给目标（Task 3）、agent 事件流（Task 2/3）、approval 弹窗（Task 2/3）、保留 Facts/Tasks/Timeline 面板（Task 3 复用现有 WS 事件）、删候选 UI（Task 1/2/3）。
- **类型一致性**：`runAgent`/`resolveApproval`（Task 1）→ App.tsx 消费（Task 3）。`AgentUiEvent`/`pendingApproval`（Task 2）→ App.tsx 消费。WS 处理消费 Plan E1 定义的 agent 事件（`agent_*`/`approval_*`/`action_recorded`），与 shared events.ts 一致。
- **删除坏 UI 的完整性**：候选 api（Task 1）、候选 store state + 旧 WS 处理（Task 2）、候选 UI（Task 3）三处协同删除——Task 3 的 tsc 会抓出任何残留引用（候选函数/state 已不存在则编译报错）。
- **后端不动**：仅改 apps/web 三个文件 + README。
- **已知简化**：前端无单测（沿用项目惯例），靠 tsc + 构建 + 手动端到端验证；agent run 是一次性 POST（人插话 /agent/message 后端 Plan E1 未实现，前端也不做——与 Plan E1 自检一致）；agentEvents 不持久化（刷新丢失，符合 MVP）。
