# Plan E1：agent 后端闭环 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans（本计划在当前会话由控制者直接执行，TDD 节奏）。Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 agent 驱动交互的后端闭环：把现有 store 操作包装成 agent 工具（读流量 + 记 Fact/Task/Action），新增 agent 启动/插话/确认路由，ApprovalGate 接 WebSocket，废弃旧候选模式（FactExtractor/ActionPlanner + 候选路由/模块/测试）。对应设计 docs/superpowers/specs/2026-06-24-agent-driven-interaction-design.md 的 Plan E1。

**Architecture:** `@traceforge/extension` 新增 `case-tools.ts`：把 TrafficStore/FactStore/TaskStore/ActionCardStore/DecisionStore 的操作包装成 ToolDescriptor 工厂（全 normal 风险，写库工具内置 Timeline+emit 三连联动）。`@traceforge/shared` 加 agent 相关事件类型。server 用 AgentRuntime + 这套工具 + 接 WebSocket 的 ApprovalGate 装配 agent 路由，并删除旧候选路由/模块。前端不动（Plan E2）。

**Tech Stack:** 沿用前序（TypeScript、pnpm、Vitest、Fastify、Drizzle、AgentRuntime/ToolRegistry/ApprovalGate）。

## Global Constraints

- 沿用全部既有约束：Node ≥ 22、pnpm、ESM、`strict: true`、Vitest、`@traceforge/shared` 单源类型、所有业务表带 case_id、纯逻辑模块必须单测。
- **零硬编码（设计文档 3.0）**：Fact.type 开放字符串；工具领域无关；无漏洞专用逻辑。
- **写库工具直接落库（normal 风险）**：record_fact/task/action 不卡人工。只有 command 类工具经 ApprovalGate（本计划工具集无 command 类，但确认门机制要接好）。
- **写库工具三连联动（复用阶段 2 硬约束）**：每个 record_* 工具 execute 内 (1) 写 store (2) append Timeline (3) emit RuntimeEvent。
- **evidenceRefs 硬规则（搬自阶段 4）**：record_action 工具校验 evidenceRefs 非空且都是已知 fact_id，不满足返回 `{ok:false}` 让 LLM 重来。
- **store 不改**：复用现有 FactStore/TaskStore/ActionCardStore/DecisionStore/TrafficStore/TimelineStore 的现有签名，本计划不改 store。
- **provider 装配复用**：`loadLlmConfig` + `createProviderOrMock`（已端到端验证）。
- 提交信息结尾附：`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。

---

### Task 1: shared —— agent 相关事件类型

**Files:**
- Modify: `packages/shared/src/events.ts`
- Test: `packages/shared/src/phase-e1-events.test.ts`

**Interfaces:**
- Consumes: 现有 `RuntimeEvent`、`Fact`/`Task`/`ActionCard`/`Decision`。
- Produces：`RuntimeEvent` 新增分支：`agent_started`/`agent_text`/`agent_tool_call`/`agent_tool_result`/`agent_done`/`agent_error`/`approval_requested`/`approval_resolved`/`action_recorded`/`scope_expansion_proposed`。

- [ ] **Step 1: 写失败测试 `packages/shared/src/phase-e1-events.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import type { RuntimeEvent } from "./events.js";

// 类型层断言：构造各 agent 事件不报类型错（编译即测试）
describe("agent runtime events", () => {
  it("accepts agent lifecycle and approval events", () => {
    const events: RuntimeEvent[] = [
      { type: "agent_started", caseId: "c", goal: "test it" },
      { type: "agent_text", caseId: "c", content: "thinking" },
      { type: "agent_tool_call", caseId: "c", tool: "http_replay", input: "{}" },
      { type: "agent_tool_result", caseId: "c", tool: "http_replay", content: "status=200" },
      { type: "agent_done", caseId: "c", content: "finished" },
      { type: "agent_error", caseId: "c", content: "network error" },
      { type: "approval_requested", caseId: "c", approvalId: "a1", tool: "sqlmap", input: "{}" },
      { type: "approval_resolved", caseId: "c", approvalId: "a1", decision: "approved" },
      { type: "scope_expansion_proposed", caseId: "c", host: "cdn.t.com", reason: "same cert" },
    ];
    expect(events).toHaveLength(9);
    expect(events[0].type).toBe("agent_started");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/shared/src/phase-e1-events.test.ts`
Expected: FAIL —— 类型不存在，tsc 编译错（vitest 报类型错误）。

- [ ] **Step 3: 扩展 `packages/shared/src/events.ts`**

在 `RuntimeEvent` 联合末尾追加（保留所有现有分支；`action_recorded` 复用 ActionCard）：

```ts
  | { type: "agent_started"; caseId: string; goal: string }
  | { type: "agent_text"; caseId: string; content: string }
  | { type: "agent_tool_call"; caseId: string; tool: string; input: string }
  | { type: "agent_tool_result"; caseId: string; tool: string; content: string }
  | { type: "agent_done"; caseId: string; content: string }
  | { type: "agent_error"; caseId: string; content: string }
  | { type: "approval_requested"; caseId: string; approvalId: string; tool: string; input: string }
  | { type: "approval_resolved"; caseId: string; approvalId: string; decision: "approved" | "rejected" }
  | { type: "action_recorded"; action: ActionCard }
  | { type: "scope_expansion_proposed"; caseId: string; host: string; reason: string }
```

（`ActionCard` 已在 events.ts 顶部 import；若未 import 则在 import 行加上。）

- [ ] **Step 4: 运行确认通过 + 全 shared 测试 + tsc**

Run: `pnpm vitest run packages/shared && pnpm --filter @traceforge/shared exec tsc --noEmit -p tsconfig.json`
Expected: 全绿；tsc 退出码 0。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(shared): add agent runtime and approval event types

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: extension —— 读流量工具（list_traffic / get_traffic）

**Files:**
- Create: `packages/extension/src/case-tools.ts`
- Modify: `packages/extension/src/index.ts`
- Modify: `packages/extension/package.json`（加 server 不依赖；工具靠注入的 store 接口，不直接依赖 server）
- Test: `packages/extension/src/case-tools.test.ts`

**Interfaces:**
- Consumes: `ToolDescriptor`（Task 已有）、`TrafficEntry`（`@traceforge/shared`）。
- Produces：
  - `interface TrafficReader { listByCase(caseId: string): TrafficEntry[] }`（结构类型，由 server 的 TrafficStore 满足，extension 不依赖 server）。
  - `makeListTrafficTool(caseId: string, traffic: TrafficReader): ToolDescriptor` —— normal 风险，返回该 case 的请求摘要（method/url/status 列表）。
  - `makeGetTrafficTool(caseId: string, traffic: TrafficReader): ToolDescriptor` —— normal 风险，input `{ id }`，返回单条详情（含 headers/body）。

- [ ] **Step 1: 写失败测试 `packages/extension/src/case-tools.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { makeListTrafficTool, makeGetTrafficTool } from "./case-tools.js";
import type { TrafficEntry } from "@traceforge/shared";

const entries: TrafficEntry[] = [
  { id: "traf_1", caseId: "c", url: "https://t.com/a", method: "GET", requestHeaders: {}, responseStatus: 200, responseBody: "hi", createdAt: "now" },
  { id: "traf_2", caseId: "c", url: "https://t.com/b", method: "POST", requestHeaders: {}, responseStatus: 404, responseBody: null, createdAt: "now" },
];
const reader = { listByCase: (cid: string) => (cid === "c" ? entries : []) };

describe("makeListTrafficTool", () => {
  it("lists traffic summaries for the case", async () => {
    const tool = makeListTrafficTool("c", reader);
    expect(tool.risk).toBe("normal");
    const res = await tool.execute({});
    expect(res.ok).toBe(true);
    expect(res.content).toContain("traf_1");
    expect(res.content).toContain("GET");
    expect(res.content).toContain("https://t.com/b");
  });
});

describe("makeGetTrafficTool", () => {
  it("returns a single entry detail by id", async () => {
    const tool = makeGetTrafficTool("c", reader);
    const res = await tool.execute({ id: "traf_1" });
    expect(res.ok).toBe(true);
    expect(res.content).toContain("hi");
  });
  it("returns ok:false for a missing id", async () => {
    const tool = makeGetTrafficTool("c", reader);
    const res = await tool.execute({ id: "nope" });
    expect(res.ok).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/extension/src/case-tools.test.ts`
Expected: FAIL —— case-tools 模块不存在。

- [ ] **Step 3: 写 `packages/extension/src/case-tools.ts`（先只写两个读流量工具）**

```ts
import type { TrafficEntry } from "@traceforge/shared";
import type { ToolDescriptor } from "./tool.js";

export interface TrafficReader {
  listByCase(caseId: string): TrafficEntry[];
}

export function makeListTrafficTool(caseId: string, traffic: TrafficReader): ToolDescriptor {
  return {
    name: "list_traffic",
    description: "列出本 case 已捕获的 HTTP 请求摘要（method / url / 状态码 / id）。分析前先看有哪些流量。",
    inputSchema: { type: "object", properties: {} },
    risk: "normal",
    source: "builtin",
    execute: async () => {
      const list = traffic.listByCase(caseId);
      const summary = list.map((e) => `${e.id} ${e.method} ${e.responseStatus ?? "-"} ${e.url}`).join("\n");
      return { ok: true, content: summary || "（暂无流量）" };
    },
  };
}

export function makeGetTrafficTool(caseId: string, traffic: TrafficReader): ToolDescriptor {
  return {
    name: "get_traffic",
    description: "按 id 取一条已捕获请求的详情（含 headers 与响应体）。",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    risk: "normal",
    source: "builtin",
    execute: async (input) => {
      const { id } = input as { id: string };
      const entry = traffic.listByCase(caseId).find((e) => e.id === id);
      if (!entry) return { ok: false, content: `未找到流量 ${id}` };
      return {
        ok: true,
        content: JSON.stringify({
          url: entry.url, method: entry.method, status: entry.responseStatus,
          requestHeaders: entry.requestHeaders, body: entry.responseBody,
        }, null, 2),
      };
    },
  };
}
```

- [ ] **Step 4: 扩展 `packages/extension/src/index.ts`**

```ts
export {
  makeListTrafficTool, makeGetTrafficTool, type TrafficReader,
} from "./case-tools.js";
```

- [ ] **Step 5: 运行确认通过**

Run: `pnpm vitest run packages/extension/src/case-tools.test.ts`
Expected: PASS（list 1 + get 2）。

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(extension): add list_traffic/get_traffic agent tools

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: extension —— 写库工具（record_fact / record_task / record_action）

**Files:**
- Modify: `packages/extension/src/case-tools.ts`
- Modify: `packages/extension/src/index.ts`
- Test: `packages/extension/src/case-tools-record.test.ts`

**Interfaces:**
- Consumes: `Fact`/`Task`/`ActionCard`/`TimelineEntry`（`@traceforge/shared`）、`ToolDescriptor`、`RuntimeEvent`。
- Produces（结构类型注入，extension 不依赖 server）：
  - `interface FactWriter { create(caseId: string, input: Omit<Fact,"id"|"caseId"|"createdAt">): Fact; listByCase(caseId: string): Fact[] }`
  - `interface TaskWriter { create(caseId: string, input: Omit<Task,"id"|"caseId"|"createdAt"|"updatedAt">): Task }`
  - `interface ActionWriter { create(a: ActionCard): ActionCard }`
  - `interface DecisionWriter { create(caseId: string, input: { decision: string; basedOn: string[]; reasoning: string; actionRef?: string | null; result?: string | null; newFacts?: string[] }): unknown }`
  - `interface TimelineWriter { append(caseId: string, eventType: string, detail: string, refId?: string): TimelineEntry }`
  - `type Emit = (e: RuntimeEvent) => void`
  - `makeRecordFactTool(caseId, facts: FactWriter, timeline: TimelineWriter, emit: Emit): ToolDescriptor`
  - `makeRecordTaskTool(caseId, tasks: TaskWriter, timeline: TimelineWriter, emit: Emit): ToolDescriptor`
  - `makeRecordActionTool(caseId, facts: FactWriter, actions: ActionWriter, decisions: DecisionWriter, timeline: TimelineWriter, emit: Emit): ToolDescriptor`

- [ ] **Step 1: 写失败测试 `packages/extension/src/case-tools-record.test.ts`**

```ts
import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { makeRecordFactTool, makeRecordTaskTool, makeRecordActionTool } from "./case-tools.js";
import { type Fact, type Task, type ActionCard, ActionCardSchema, FactSchema, TaskSchema } from "@traceforge/shared";
import type { RuntimeEvent } from "@traceforge/shared";

// 内存 store 假实现（满足结构接口）
function memFacts() {
  const arr: Fact[] = [];
  return {
    create: (caseId: string, input: Omit<Fact, "id" | "caseId" | "createdAt">) => {
      const f = FactSchema.parse({ ...input, id: `fact_${randomUUID()}`, caseId, createdAt: "now" });
      arr.push(f); return f;
    },
    listByCase: (caseId: string) => arr.filter((f) => f.caseId === caseId),
    _arr: arr,
  };
}
const memTimeline = { append: (_c: string, _e: string, _d: string, _r?: string) => ({ id: "tl", caseId: "c", eventType: "x", refId: null, detail: "", createdAt: "now" }) };

describe("makeRecordFactTool", () => {
  it("writes a fact, appends timeline, emits event", async () => {
    const facts = memFacts();
    const tlSpy = vi.spyOn(memTimeline, "append");
    const events: RuntimeEvent[] = [];
    const tool = makeRecordFactTool("c", facts, memTimeline, (e) => events.push(e));
    expect(tool.risk).toBe("normal");
    const res = await tool.execute({ type: "graphql_endpoint", title: "gql", value: { url: "x" } });
    expect(res.ok).toBe(true);
    expect(facts._arr).toHaveLength(1);
    expect(facts._arr[0].source.type).toBe("ai");
    expect(tlSpy).toHaveBeenCalled();
    expect(events.some((e) => e.type === "fact_created")).toBe(true);
  });
});

describe("makeRecordActionTool", () => {
  it("rejects an action with evidenceRefs not pointing to known facts", async () => {
    const facts = memFacts(); // 空，无 fact
    const actions = { create: (a: ActionCard) => a };
    const decisions = { create: () => ({}) };
    const events: RuntimeEvent[] = [];
    const tool = makeRecordActionTool("c", facts, actions, decisions, memTimeline, (e) => events.push(e));
    const res = await tool.execute({ title: "x", goal: "g", evidenceRefs: ["fact_ghost"], reasoning: "r", steps: ["s"], tool: "http_replay" });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/evidence/i);
  });

  it("records an action when evidenceRefs are valid known facts", async () => {
    const facts = memFacts();
    const f = facts.create("c", { type: "api_endpoint", title: "api", value: {}, source: { type: "ai", ref: "r" }, confidence: 1, tags: [] });
    const stored: ActionCard[] = [];
    const actions = { create: (a: ActionCard) => { stored.push(a); return a; } };
    let decisionMade = false;
    const decisions = { create: () => { decisionMade = true; return {}; } };
    const events: RuntimeEvent[] = [];
    const tool = makeRecordActionTool("c", facts, actions, decisions, memTimeline, (e) => events.push(e));
    const res = await tool.execute({ title: "probe", goal: "g", evidenceRefs: [f.id], reasoning: "r", steps: ["s"], tool: "http_replay" });
    expect(res.ok).toBe(true);
    expect(stored).toHaveLength(1);
    expect(decisionMade).toBe(true);
    expect(events.some((e) => e.type === "action_recorded")).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run packages/extension/src/case-tools-record.test.ts`
Expected: FAIL —— 三个工厂未定义。

- [ ] **Step 3: 在 `packages/extension/src/case-tools.ts` 追加写库工具**

```ts
import { randomUUID } from "node:crypto";
import {
  type Fact, type Task, type ActionCard, type TimelineEntry,
  ActionCardSchema, type RuntimeEvent,
} from "@traceforge/shared";

export interface FactWriter {
  create(caseId: string, input: Omit<Fact, "id" | "caseId" | "createdAt">): Fact;
  listByCase(caseId: string): Fact[];
}
export interface TaskWriter {
  create(caseId: string, input: Omit<Task, "id" | "caseId" | "createdAt" | "updatedAt">): Task;
}
export interface ActionWriter {
  create(a: ActionCard): ActionCard;
}
export interface DecisionWriter {
  create(caseId: string, input: { decision: string; basedOn: string[]; reasoning: string; actionRef?: string | null; result?: string | null; newFacts?: string[] }): unknown;
}
export interface TimelineWriter {
  append(caseId: string, eventType: string, detail: string, refId?: string): TimelineEntry;
}
export type Emit = (e: RuntimeEvent) => void;

export function makeRecordFactTool(caseId: string, facts: FactWriter, timeline: TimelineWriter, emit: Emit): ToolDescriptor {
  return {
    name: "record_fact",
    description: "把一个发现记录为 Fact。type 用最贴切的英文标识（如 api_endpoint、graphql_endpoint、credential、finding 等，不限于预设）。",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string" }, title: { type: "string" }, value: {},
        confidence: { type: "number" }, tags: { type: "array", items: { type: "string" } },
      },
      required: ["type", "title"],
    },
    risk: "normal",
    source: "builtin",
    execute: async (input) => {
      const i = input as { type: string; title: string; value?: unknown; confidence?: number; tags?: string[] };
      const fact = facts.create(caseId, {
        type: i.type, title: i.title, value: i.value ?? {},
        source: { type: "ai", ref: "agent" },
        confidence: typeof i.confidence === "number" ? i.confidence : 1,
        tags: Array.isArray(i.tags) ? i.tags : [],
      });
      const entry = timeline.append(caseId, "fact_created", `Fact (agent): ${fact.title}`, fact.id);
      emit({ type: "fact_created", fact });
      emit({ type: "timeline_appended", entry });
      return { ok: true, content: `已记录 Fact ${fact.id}: ${fact.title}` };
    },
  };
}

export function makeRecordTaskTool(caseId: string, tasks: TaskWriter, timeline: TimelineWriter, emit: Emit): ToolDescriptor {
  return {
    name: "record_task",
    description: "记录一个待办/挂起任务。可设 status=blocked + triggerWhen 表示等待某条件（如等凭据）。",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" }, status: { type: "string" }, reason: { type: "string" },
        blockedBy: { type: "array", items: { type: "string" } },
        triggerWhen: { type: "array", items: { type: "string" } },
        relatedFacts: { type: "array", items: { type: "string" } },
        priority: { type: "string" },
      },
      required: ["title"],
    },
    risk: "normal",
    source: "builtin",
    execute: async (input) => {
      const i = input as Record<string, unknown>;
      const task = tasks.create(caseId, {
        title: String(i.title),
        status: (typeof i.status === "string" ? i.status : "open") as Task["status"],
        reason: typeof i.reason === "string" ? i.reason : "",
        blockedBy: Array.isArray(i.blockedBy) ? (i.blockedBy as string[]) : [],
        triggerWhen: Array.isArray(i.triggerWhen) ? (i.triggerWhen as string[]) : [],
        relatedFacts: Array.isArray(i.relatedFacts) ? (i.relatedFacts as string[]) : [],
        priority: (typeof i.priority === "string" ? i.priority : "medium") as Task["priority"],
      });
      const entry = timeline.append(caseId, "task_created", `Task (agent): ${task.title}`, task.id);
      emit({ type: "task_created", task });
      emit({ type: "timeline_appended", entry });
      return { ok: true, content: `已记录 Task ${task.id}: ${task.title}` };
    },
  };
}

export function makeRecordActionTool(
  caseId: string, facts: FactWriter, actions: ActionWriter, decisions: DecisionWriter,
  timeline: TimelineWriter, emit: Emit,
): ToolDescriptor {
  return {
    name: "record_action",
    description: "记录一个证据驱动的测试动作。evidenceRefs 必须引用至少一个已记录的 Fact id（无证据依据的动作不被接受）。",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" }, goal: { type: "string" },
        evidenceRefs: { type: "array", items: { type: "string" } },
        reasoning: { type: "string" }, steps: { type: "array", items: { type: "string" } },
        expectedResults: { type: "array", items: { type: "string" } },
        riskNotes: { type: "array", items: { type: "string" } },
        tool: { type: "string" }, priority: { type: "string" },
      },
      required: ["title", "goal", "evidenceRefs", "reasoning", "steps", "tool"],
    },
    risk: "normal",
    source: "builtin",
    execute: async (input) => {
      const i = input as Record<string, unknown>;
      const refs = Array.isArray(i.evidenceRefs) ? (i.evidenceRefs as unknown[]).filter((r): r is string => typeof r === "string") : [];
      const knownIds = new Set(facts.listByCase(caseId).map((f) => f.id));
      if (refs.length === 0 || !refs.every((r) => knownIds.has(r))) {
        return { ok: false, content: "evidenceRefs 必须非空且都引用已记录的 Fact id；请先 record_fact 再记录动作。" };
      }
      const now = new Date().toISOString();
      const parsed = ActionCardSchema.safeParse({
        id: `action_${randomUUID()}`, caseId, title: i.title, goal: i.goal,
        evidenceRefs: refs, reasoning: i.reasoning,
        steps: Array.isArray(i.steps) ? i.steps : [],
        expectedResults: Array.isArray(i.expectedResults) ? i.expectedResults : [],
        riskNotes: Array.isArray(i.riskNotes) ? i.riskNotes : [],
        tool: i.tool, priority: typeof i.priority === "string" ? i.priority : "medium",
        status: "approved", createdAt: now, updatedAt: now,
      });
      if (!parsed.success) return { ok: false, content: "动作结构不合法。" };
      const action = actions.create(parsed.data);
      decisions.create(caseId, {
        decision: action.title, basedOn: action.evidenceRefs, reasoning: action.reasoning,
        actionRef: action.id, result: null, newFacts: [],
      });
      const entry = timeline.append(caseId, "action_recorded", `Action (agent): ${action.title}`, action.id);
      emit({ type: "action_recorded", action });
      emit({ type: "timeline_appended", entry });
      return { ok: true, content: `已记录 Action ${action.id}: ${action.title}` };
    },
  };
}
```

- [ ] **Step 4: 扩展 `packages/extension/src/index.ts`**

```ts
export {
  makeRecordFactTool, makeRecordTaskTool, makeRecordActionTool,
  type FactWriter, type TaskWriter, type ActionWriter, type DecisionWriter, type TimelineWriter, type Emit,
} from "./case-tools.js";
```

- [ ] **Step 5: 运行确认通过 + tsc**

Run: `pnpm vitest run packages/extension && pnpm --filter @traceforge/extension exec tsc --noEmit -p tsconfig.json`
Expected: case-tools + case-tools-record + 既有 extension 测试全绿；tsc 退出码 0。

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(extension): add record_fact/task/action tools with timeline+event linkage and evidence rule

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: server —— WebSocket 确认门 + agent 路由

**Files:**
- Create: `apps/server/src/agent-approvals.ts`
- Modify: `apps/server/src/routes.ts`
- Modify: `apps/server/package.json`（确认已依赖 `@traceforge/extension`——Plan A 已加；若无则加）
- Test: `apps/server/src/routes-agent.test.ts`

**Interfaces:**
- Consumes: `AgentRuntime`/`ToolRegistry`/`ApprovalGate`/`makeListTrafficTool`/`makeGetTrafficTool`/`makeRecordFactTool`/`makeRecordTaskTool`/`makeRecordActionTool`/`makeHttpReplayTool`/`makeProposeScopeExpansionTool`（`@traceforge/extension`）、`loadLlmConfig`/`createProviderOrMock`（`@traceforge/llm`）、现有 stores、EventBus。
- Produces：
  - `ApprovalRegistry`（`agent-approvals.ts`）：管理挂起的 command 确认。`request(approvalId): Promise<"approved"|"rejected">`（挂起）、`resolve(approvalId, decision)`（解挂）。
  - `registerRoutes` 内构造 agent 装配函数 + 路由：
    - `POST /api/cases/:id/agent/run` body `{ goal }`：装配工具集 + ApprovalGate（用 ApprovalRegistry + emit approval_requested）→ AgentRuntime.run，onEvent emit 对应 RuntimeEvent → 返回 `{ ok: true }`。
    - `POST /api/agent/approvals/:approvalId` body `{ decision }`：`ApprovalRegistry.resolve` + emit approval_resolved → `{ ok: true }`。
  - provider 注入：路由用第 4 参 `provider`（registerRoutes 已有），无则 `createProviderOrMock(loadLlmConfig())`。

- [ ] **Step 1: 写 `apps/server/src/agent-approvals.ts`**

```ts
type Decision = "approved" | "rejected";

export class ApprovalRegistry {
  private pending = new Map<string, (d: Decision) => void>();

  request(approvalId: string): Promise<Decision> {
    return new Promise((resolve) => {
      this.pending.set(approvalId, resolve);
    });
  }

  resolve(approvalId: string, decision: Decision): boolean {
    const fn = this.pending.get(approvalId);
    if (!fn) return false;
    this.pending.delete(approvalId);
    fn(decision);
    return true;
  }
}
```

- [ ] **Step 2: 写失败测试 `apps/server/src/routes-agent.test.ts`**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createDb } from "./db/client.js";
import { EventBus } from "./event-bus.js";
import { registerRoutes } from "./routes.js";
import { MockProvider } from "@traceforge/llm";
import type { RuntimeEvent } from "@traceforge/shared";

let app: FastifyInstance;
let events: RuntimeEvent[];
let caseId: string;

beforeEach(async () => {
  app = Fastify();
  const db = createDb(":memory:");
  const bus = new EventBus();
  events = [];
  bus.subscribe((e) => events.push(e));
  // provider 注入预设 tool-calling 序列：先 record_fact，再 done
  const provider = new MockProvider({}, [
    { text: "记录发现", toolCalls: [{ id: "c1", name: "record_fact", input: { type: "api_endpoint", title: "order api", value: { url: "x" } } }], done: false },
    { text: "完成", toolCalls: [], done: true },
  ]);
  registerRoutes(app, db, bus, provider);
  await app.ready();
  caseId = (await app.inject({ method: "POST", url: "/api/cases", payload: { name: "d", allowHosts: ["t.com"] } })).json().id;
  events.length = 0;
});

describe("agent run route", () => {
  it("runs the agent which records a fact via tool, emitting events", async () => {
    const res = await app.inject({ method: "POST", url: `/api/cases/${caseId}/agent/run`, payload: { goal: "找接口" } });
    expect(res.statusCode).toBe(200);
    // fact 落库
    const facts = (await app.inject({ url: `/api/cases/${caseId}/facts` })).json();
    expect(facts).toHaveLength(1);
    expect(facts[0].source.type).toBe("ai");
    // agent 事件 + fact_created 都 emit 了
    expect(events.some((e) => e.type === "agent_started")).toBe(true);
    expect(events.some((e) => e.type === "fact_created")).toBe(true);
    expect(events.some((e) => e.type === "agent_done")).toBe(true);
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `pnpm vitest run apps/server/src/routes-agent.test.ts`
Expected: FAIL —— agent/run 路由不存在。

- [ ] **Step 4: 修改 `apps/server/src/routes.ts`**

顶部 import 增加：

```ts
import {
  ToolRegistry, ApprovalGate, AgentRuntime,
  makeListTrafficTool, makeGetTrafficTool,
  makeRecordFactTool, makeRecordTaskTool, makeRecordActionTool,
  makeHttpReplayTool, makeProposeScopeExpansionTool,
} from "@traceforge/extension";
import { ApprovalRegistry } from "./agent-approvals.js";
import { randomUUID } from "node:crypto";
```

在 `registerRoutes` 函数体内（现有 stores 初始化之后，`llm` 装配处复用现有 `const llm = ...`）追加 agent 装配 + 路由（放在文件末尾路由区，registerRoutes 闭合 `}` 之前）：

```ts
  const approvals = new ApprovalRegistry();

  app.post("/api/cases/:id/agent/run", async (req, reply) => {
    const { id } = req.params as { id: string };
    const c = cases.get(id);
    if (!c) return reply.code(404).send({ error: "case not found" });

    const registry = new ToolRegistry();
    registry.register(makeListTrafficTool(id, traffic));
    registry.register(makeGetTrafficTool(id, traffic));
    registry.register(makeRecordFactTool(id, factStore, timelineStore, (e) => bus.emit(e)));
    registry.register(makeRecordTaskTool(id, taskStore, timelineStore, (e) => bus.emit(e)));
    registry.register(makeRecordActionTool(id, factStore, actionStore, decisionStore, timelineStore, (e) => bus.emit(e)));
    registry.register(makeHttpReplayTool(c.scopeRules));
    registry.register(makeProposeScopeExpansionTool((host, reason) =>
      bus.emit({ type: "scope_expansion_proposed", caseId: id, host, reason })));

    // 确认门：command 类工具挂起等人工（本工具集无 command，但机制就位）
    const gate = new ApprovalGate(async (tool, input) => {
      const approvalId = `appr_${randomUUID()}`;
      bus.emit({ type: "approval_requested", caseId: id, approvalId, tool: tool.name, input: JSON.stringify(input) });
      const decision = await approvals.request(approvalId);
      bus.emit({ type: "approval_resolved", caseId: id, approvalId, decision });
      return decision;
    });

    const { goal } = req.body as { goal: string };
    const system = `你是 TraceForge 的授权渗透测试 agent。当前授权范围：${JSON.stringify(c.scopeRules)}。
你可以用工具查看流量、记录发现（Fact/Task/Action）、重放请求。证据驱动：记录动作前先记录支撑它的 Fact。
完成后用一句话总结。`;

    bus.emit({ type: "agent_started", caseId: id, goal });
    try {
      await new AgentRuntime(llm, registry, gate).run(system, goal, (e) => {
        if (e.type === "tool_call") bus.emit({ type: "agent_tool_call", caseId: id, tool: e.name ?? "", input: e.content });
        else if (e.type === "tool_result") bus.emit({ type: "agent_tool_result", caseId: id, tool: e.name ?? "", content: e.content });
        else if (e.type === "text") bus.emit({ type: "agent_text", caseId: id, content: e.content });
        else if (e.type === "done") bus.emit({ type: "agent_done", caseId: id, content: e.content });
      });
    } catch (err) {
      bus.emit({ type: "agent_error", caseId: id, content: (err as Error).message });
      return reply.code(500).send({ error: "agent run failed", reason: (err as Error).message });
    }
    return { ok: true };
  });

  app.post("/api/agent/approvals/:approvalId", async (req, reply) => {
    const { approvalId } = req.params as { approvalId: string };
    const { decision } = req.body as { decision: "approved" | "rejected" };
    const ok = approvals.resolve(approvalId, decision);
    if (!ok) return reply.code(404).send({ error: "approval not found" });
    return { ok: true };
  });
```

> 注：`llm` 变量复用 registerRoutes 内已有的 provider 装配（Plan 阶段3 加的 `const llm = provider ?? createProviderOrMock(loadLlmConfig())`）。`cases`/`traffic`/`factStore`/`taskStore`/`actionStore`/`decisionStore`/`timelineStore` 均已在函数体初始化。

- [ ] **Step 5: 运行确认通过**

Run: `pnpm vitest run apps/server/src/routes-agent.test.ts`
Expected: PASS（agent 跑通、fact 落库、事件齐）。

- [ ] **Step 6: tsc + 全量 server 测试**

Run: `pnpm --filter @traceforge/server exec tsc --noEmit -p tsconfig.json && pnpm vitest run apps/server`
Expected: tsc 退出码 0；server 全部测试通过（旧候选测试此刻仍在，下个任务才删）。

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(server): add agent run route with case toolset and websocket approval gate

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: 废弃旧候选模式（FactExtractor/ActionPlanner + 候选路由/模块/测试）

**Files:**
- Delete: `packages/reasoning-core/src/fact-extractor.ts` + `fact-extractor.test.ts`
- Delete: `packages/reasoning-core/src/action-planner.ts` + `action-planner.test.ts`
- Modify: `packages/reasoning-core/src/index.ts`（删 FactExtractor/ActionPlanner 导出）
- Delete: `apps/server/src/candidate-store.ts` + `apps/server/src/action-candidate-store.ts`
- Modify: `apps/server/src/routes.ts`（删 extract/plan-actions/候选 confirm/reject/action-candidate approve/reject 路由 + 相关 import 与初始化）
- Delete: `apps/server/src/routes-phase3.test.ts`（候选提取测试）+ `apps/server/src/routes-phase4.test.ts`（动作候选测试）

**Interfaces:**
- Consumes: 无新增。
- Produces：删除后 reasoning-core 仅余空 index（或保留未来推理模块占位）；server 路由仅余 agent 模式 + 基础 CRUD（cases/facts/tasks/timeline/actions/decisions/replay 等读路由保留）。

> 注：保留 `GET` 读路由（facts/tasks/timeline/actions/decisions 列表）——前端面板和 agent 路由测试都依赖它们。只删"候选写入/确认"这一套。Plan 阶段 5 的 replay/replay-compare 路由若存在则保留（与 agent 的 http_replay 工具不冲突，是不同入口）。本项目 server 当前未执行阶段 5 Task2-4，故无 replay 路由——无需处理。

- [ ] **Step 1: 删除 reasoning-core 旧模块**

Run:
```bash
cd "E:/learn/TraceForge" && rm packages/reasoning-core/src/fact-extractor.ts packages/reasoning-core/src/fact-extractor.test.ts packages/reasoning-core/src/action-planner.ts packages/reasoning-core/src/action-planner.test.ts
```

改 `packages/reasoning-core/src/index.ts` 为（清空导出，留占位注释）：

```ts
// reasoning-core: 推理逻辑模块。FactExtractor/ActionPlanner 已被 agent 工具模式取代（见扩展层）。
// 后续如有纯推理逻辑（如重评估引擎）在此重新导出。
export {};
```

- [ ] **Step 2: 删除 server 候选模块**

Run:
```bash
cd "E:/learn/TraceForge" && rm apps/server/src/candidate-store.ts apps/server/src/action-candidate-store.ts apps/server/src/routes-phase3.test.ts apps/server/src/routes-phase4.test.ts
```

- [ ] **Step 3: 清理 `apps/server/src/routes.ts` 的旧候选代码**

删除以下内容（用编辑器逐段删，保留 agent 路由与读路由）：
- import：`FactExtractor`/`ActionPlanner`（`@traceforge/reasoning-core`）、`CandidateStore`、`ActionCandidateStore`、`AnthropicProvider` 若仅候选用（保留 `loadLlmConfig`/`createProviderOrMock`）。
- 初始化：`extractor`、`candidateStore`、`planner`、`actionCandidateStore` 这几行。
- 路由：`POST /api/cases/:id/traffic/:trafId/extract`、`POST /api/candidates/:candId/confirm`、`POST /api/candidates/:candId/reject`、`POST /api/cases/:id/plan-actions`、`POST /api/action-candidates/:acandId/approve`、`POST /api/action-candidates/:acandId/reject`。
- **保留**：`GET /api/cases/:id/facts`、`/tasks`、`/timeline`、`/actions`、`/decisions`，以及 `POST /api/cases/:id/facts`、`/tasks`、`PATCH /api/tasks/:taskId`（人工手动 CRUD 仍有用，前端可保留）。agent 路由（Task 4）保留。

> `llm` 变量（provider 装配）保留——agent 路由用它。

- [ ] **Step 4: tsc + 全量测试（确认删除无残留引用）**

Run: `pnpm --filter @traceforge/server exec tsc --noEmit -p tsconfig.json && pnpm --filter @traceforge/reasoning-core exec tsc --noEmit -p tsconfig.json && pnpm test`
Expected: tsc 退出码 0（无悬空 import）；`pnpm test` 全绿（旧候选测试已删，agent 测试通过）。若 tsc 报某处仍 import 已删模块，按报错删除该引用。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "refactor: remove single-shot candidate mode (FactExtractor/ActionPlanner + candidate routes)

Replaced by agent tool-calling: record_fact/task/action tools persist directly.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: 阶段收尾 —— 全量校验、端到端、README

**Files:**
- Modify: `scripts/e2e-agent.mts`（扩展验证 agent 自主记 Fact）
- Modify: `README.md`

- [ ] **Step 1: 全量测试 + 构建**

Run: `pnpm test && pnpm -r build`
Expected: 全绿；各包构建无错误。

- [ ] **Step 2: 扩展端到端脚本验证 agent 自主记 Fact**

把 `scripts/e2e-agent.mts` 的 goal 改为引导 agent 记 Fact（需真实 LLM + config/llm.json）：

```ts
const goal = "请向 https://example.com/ 发一个 GET 请求查看响应，然后把这个端点记录为一个 Fact（用 record_fact 工具）。";
```

并在 registry 注册 record_fact 工具（用内存假 store 演示，或提示需 server 环境）。**注**：完整 agent 记 Fact 链路已由 Task 4 inject 测试用 MockProvider 覆盖；本脚本仅在配了真实 LLM 时手动验证。脚本顶部加注释说明。

- [ ] **Step 3: 更新 `README.md`**

"当前进度"追加：

```markdown
- agent 驱动交互（Plan E1 后端）：人给目标，AgentRuntime 自主多轮调工具（看流量/记 Fact-Task-Action/重放），写库直接落库，只有系统命令类才经确认门。取代旧的单轮候选确认模式。前端对话流 UI 见 Plan E2
```

把测试数量更新为实际值。

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "docs: update README and e2e script for agent-driven backend (Plan E1)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## 自检说明（写给计划作者，非执行步骤）

- **Spec 覆盖**：对应 agent 重构设计 spec 的 Plan E1 全部内容——case 工具集（Task 2/3：list/get_traffic + record_fact/task/action）、新事件类型（Task 1）、agent 路由 + WS 确认门（Task 4）、废弃旧候选（Task 5）。前端（E2）不在本计划。
- **类型一致性**：工具工厂的注入接口（FactWriter/TaskWriter/ActionWriter/DecisionWriter/TimelineWriter/TrafficReader）是结构类型，由 server 现有 store 满足——`FactStore.create(caseId, Omit<Fact,...>)`、`ActionCardStore.create(完整 ActionCard)`、`DecisionStore.create(caseId, input)`、`TimelineStore.append(caseId, eventType, detail, refId?)`、`TrafficStore.listByCase(caseId)` 均与 Task 2/3 接口签名一致（已核对 fact-store.ts）。新事件类型 Task 1 定义、Task 3/4 emit，一致。
- **安全约束落点**：(a) record_action evidenceRefs 非空 + 已知 fact_id，Task 3 两用例守住；(b) 写库工具三连联动（store+timeline+emit），Task 3 record_fact 用例断言；(c) ApprovalGate 接 WS（command 挂起等确认），Task 4 机制就位（本工具集无 command，故路由测试不触发，但 ApprovalRegistry request/resolve 逻辑由其纯逻辑保证）；(d) http_replay 经 Scope Guard（Plan A 已测）。
- **LLM 主导**：agent 路由把工具喂 AgentRuntime，LLM 自主调用（Task 4 用 MockProvider 注入 record_fact 调用验证落库）。
- **store 不改**：所有工具靠注入的现有 store，本计划不改任何 store 文件。
- **已知简化**：extension 不依赖 server（工具用结构类型注入 store）；agent 强制中断未做（MAX_TURNS 兜底）；人插话 `/agent/message` 在 spec 列了但 Plan E1 未实现路由（agent run 是一次性的，插话属 E2 交互范畴，本计划聚焦"给目标→自主跑→落库"闭环）。真实 LLM 不单测。
