# Agent Run Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade TraceForge agent runs from blocking one-shot HTTP calls into observable, interruptible, steerable background runs with streaming output.

**Architecture:** Add shared AgentRun schemas/events, a server-side in-memory AgentRunRegistry, optional provider streaming, signal-aware AgentRuntime options, background server run orchestration, and front-end run controls. OpenAI-compatible gets true streaming first; providers without streaming use a uniform fallback event sequence.

**Tech Stack:** TypeScript ESM, zod, Fastify, WebSocket RuntimeEvent bus, OpenAI SDK Chat Completions streaming, React 18, Zustand, Vitest.

---

## File Structure

- `packages/shared/src/schemas.ts`  
  Add `AgentRunStatusSchema`, `AgentRunSchema`, and exported types.

- `packages/shared/src/events.ts`  
  Extend `RuntimeEvent` with new run/stream/steering events while keeping old events.

- `packages/shared/src/agent-run.test.ts`  
  New shared schema/event tests for AgentRun and RuntimeEvent compatibility.

- `apps/server/src/agent-runs.ts`  
  New in-memory `AgentRunRegistry` with active-run conflict checks, steering queue, interrupt, complete, and fail transitions.

- `apps/server/src/agent-runs.test.ts`  
  Unit tests for `AgentRunRegistry`.

- `packages/extension/src/provider.ts`  
  Add optional `streamTools(args, handlers)` and handler/signal types.

- `packages/extension/src/agent-runtime.ts`  
  Add run options: abort signal, run id, steering supplier; emit streaming/interrupted events; fallback to `runTools`.

- `packages/extension/src/agent-runtime.test.ts`  
  Extend existing tests for fallback streaming, abort, and steering injection.

- `packages/llm/src/openai-provider.ts`  
  Implement real `streamTools` for OpenAI-compatible provider.

- `packages/llm/src/openai-stream-parse.test.ts`  
  Unit test stream assembly with the extracted OpenAI stream parser.

- `apps/server/src/routes.ts`  
  Convert `/api/cases/:id/agent/run` to start a background run and return immediately; add steer/interrupt/active routes; map runtime stream events to RuntimeEvent.

- `apps/server/src/routes-agent-run-control.test.ts`  
  Route-level tests for immediate run return, active run conflict, steering, interrupt, and event emission with an injected slow/fake provider.

- `apps/web/src/api.ts`  
  Change `runAgent` to return `AgentRun`; add `steerAgentRun`, `interruptAgentRun`, and `getActiveAgentRun`.

- `apps/web/src/store.ts`  
  Add `activeRun`, streaming-message state, and handlers for new RuntimeEvents.

- `apps/web/src/store.test.ts`  
  Add tests for stream delta concatenation, steering event recording, and run completion/interruption state cleanup.

- `apps/web/src/components/AgentPanel.tsx`  
  Replace `agentBusy`-only behavior with active run status, steering submit mode, and stop button.

- `docs/superpowers/specs/2026-06-30-agent-run-control-design.md`  
  Source spec; only update if implementation changes the design.

- `README.md` and `TraceForge_design.md`  
  Update current progress after implementation and verification.

---

### Task 1: shared AgentRun Schema and Runtime Events

**Files:**
- Modify: `packages/shared/src/schemas.ts`
- Modify: `packages/shared/src/events.ts`
- Create: `packages/shared/src/agent-run.test.ts`

- [ ] **Step 1: Write failing shared tests**

Create `packages/shared/src/agent-run.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { AgentRunSchema } from "./schemas.js";
import type { RuntimeEvent } from "./events.js";

describe("AgentRunSchema", () => {
  it("parses a running agent run with nullable terminal fields", () => {
    const run = AgentRunSchema.parse({
      id: "run_1",
      caseId: "case_1",
      goal: "inspect target",
      status: "running",
      createdAt: "2026-06-30T00:00:00.000Z",
    });
    expect(run.startedAt).toBeNull();
    expect(run.finishedAt).toBeNull();
    expect(run.interruptReason).toBeNull();
    expect(run.error).toBeNull();
  });

  it("rejects status values outside the system state machine", () => {
    expect(() => AgentRunSchema.parse({
      id: "run_1",
      caseId: "case_1",
      goal: "x",
      status: "thinking",
      createdAt: "t",
    })).toThrow();
  });
});

describe("agent run RuntimeEvent typing", () => {
  it("accepts the new streaming event shapes", () => {
    const event: RuntimeEvent = {
      type: "agent_stream_delta",
      caseId: "case_1",
      runId: "run_1",
      messageId: "msg_1",
      delta: "hello",
    };
    expect(event.delta).toBe("hello");
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `pnpm --filter @traceforge/shared exec vitest run src/agent-run.test.ts`

Expected: FAIL because `AgentRunSchema` is not exported and `agent_stream_delta` is not part of `RuntimeEvent`.

- [ ] **Step 3: Add AgentRun schema**

Append to `packages/shared/src/schemas.ts`:

```ts
export const AgentRunStatusSchema = z.enum([
  "queued",
  "running",
  "interrupting",
  "interrupted",
  "completed",
  "failed",
]);
export type AgentRunStatus = z.infer<typeof AgentRunStatusSchema>;

export const AgentRunSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  goal: z.string(),
  status: AgentRunStatusSchema,
  createdAt: z.string(),
  startedAt: z.string().nullable().default(null),
  finishedAt: z.string().nullable().default(null),
  interruptReason: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
});
export type AgentRun = z.infer<typeof AgentRunSchema>;
```

- [ ] **Step 4: Extend RuntimeEvent**

Update the import in `packages/shared/src/events.ts`:

```ts
import type { Case, TrafficEntry, Fact, Task, TimelineEntry, CandidateFact, ActionCard, Decision, ObserverWarning, AgentRun } from "./schemas.js";
```

Add these union members after the legacy `agent_error` event:

```ts
  | { type: "agent_run_started"; run: AgentRun }
  | { type: "agent_stream_start"; caseId: string; runId: string; messageId: string }
  | { type: "agent_stream_delta"; caseId: string; runId: string; messageId: string; delta: string }
  | { type: "agent_stream_end"; caseId: string; runId: string; messageId: string; content: string }
  | { type: "agent_steering_added"; caseId: string; runId: string; content: string }
  | { type: "agent_run_interrupted"; run: AgentRun }
  | { type: "agent_run_completed"; run: AgentRun; content: string }
  | { type: "agent_run_failed"; run: AgentRun; error: string }
```

- [ ] **Step 5: Verify shared tests pass**

Run: `pnpm --filter @traceforge/shared exec vitest run src/agent-run.test.ts`

Expected: PASS.

- [ ] **Step 6: Build shared**

Run: `pnpm --filter @traceforge/shared build`

Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/schemas.ts packages/shared/src/events.ts packages/shared/src/agent-run.test.ts
git commit -m "feat(shared): add AgentRun schema and streaming events"
```

---

### Task 2: server AgentRunRegistry

**Files:**
- Create: `apps/server/src/agent-runs.ts`
- Create: `apps/server/src/agent-runs.test.ts`

- [ ] **Step 1: Write failing registry tests**

Create `apps/server/src/agent-runs.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { AgentRunRegistry } from "./agent-runs.js";

describe("AgentRunRegistry", () => {
  it("starts one active run per case and rejects a second active run", () => {
    const reg = new AgentRunRegistry();
    const first = reg.start("case_1", "goal");
    expect(first.run.id).toMatch(/^run_/);
    expect(first.run.status).toBe("running");
    expect(reg.getActiveByCase("case_1")?.run.id).toBe(first.run.id);
    expect(() => reg.start("case_1", "other")).toThrow(/active run/);
  });

  it("queues and consumes steering messages", () => {
    const reg = new AgentRunRegistry();
    const { run } = reg.start("case_1", "goal");
    expect(reg.addSteering(run.id, "look at API")?.status).toBe("running");
    expect(reg.consumeSteering(run.id)).toEqual(["look at API"]);
    expect(reg.consumeSteering(run.id)).toEqual([]);
  });

  it("interrupt is idempotent and aborts the controller", () => {
    const reg = new AgentRunRegistry();
    const active = reg.start("case_1", "goal");
    const run = reg.interrupt(active.run.id, "user stop");
    expect(run?.status).toBe("interrupting");
    expect(run?.interruptReason).toBe("user stop");
    expect(active.abortController.signal.aborted).toBe(true);
    expect(reg.interrupt(active.run.id, "again")?.status).toBe("interrupting");
  });

  it("complete and fail clear the active case run", () => {
    const reg = new AgentRunRegistry();
    const { run } = reg.start("case_1", "goal");
    expect(reg.complete(run.id)?.status).toBe("completed");
    expect(reg.getActiveByCase("case_1")).toBeUndefined();

    const second = reg.start("case_1", "goal 2");
    expect(reg.fail(second.run.id, "boom")?.error).toBe("boom");
    expect(reg.getActiveByCase("case_1")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `pnpm --filter @traceforge/server exec vitest run src/agent-runs.test.ts`

Expected: FAIL because `agent-runs.ts` does not exist.

- [ ] **Step 3: Implement AgentRunRegistry**

Create `apps/server/src/agent-runs.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { AgentRun } from "@traceforge/shared";

export interface ActiveAgentRun {
  run: AgentRun;
  abortController: AbortController;
  steeringQueue: string[];
}

function now(): string {
  return new Date().toISOString();
}

function terminal(status: AgentRun["status"]): boolean {
  return status === "completed" || status === "failed" || status === "interrupted";
}

export class AgentRunRegistry {
  private runs = new Map<string, ActiveAgentRun>();
  private activeByCase = new Map<string, string>();

  start(caseId: string, goal: string): ActiveAgentRun {
    const existing = this.getActiveByCase(caseId);
    if (existing && !terminal(existing.run.status)) throw new Error(`case ${caseId} already has an active run`);
    const createdAt = now();
    const active: ActiveAgentRun = {
      run: {
        id: `run_${randomUUID()}`,
        caseId,
        goal,
        status: "running",
        createdAt,
        startedAt: createdAt,
        finishedAt: null,
        interruptReason: null,
        error: null,
      },
      abortController: new AbortController(),
      steeringQueue: [],
    };
    this.runs.set(active.run.id, active);
    this.activeByCase.set(caseId, active.run.id);
    return active;
  }

  get(runId: string): ActiveAgentRun | undefined {
    return this.runs.get(runId);
  }

  getActiveByCase(caseId: string): ActiveAgentRun | undefined {
    const id = this.activeByCase.get(caseId);
    return id ? this.runs.get(id) : undefined;
  }

  addSteering(runId: string, text: string): AgentRun | undefined {
    const active = this.runs.get(runId);
    if (!active || terminal(active.run.status)) return undefined;
    active.steeringQueue.push(text);
    return active.run;
  }

  consumeSteering(runId: string): string[] {
    const active = this.runs.get(runId);
    if (!active) return [];
    const queued = active.steeringQueue.splice(0);
    return queued;
  }

  interrupt(runId: string, reason = "user interrupted"): AgentRun | undefined {
    const active = this.runs.get(runId);
    if (!active) return undefined;
    if (terminal(active.run.status)) return active.run;
    active.run = { ...active.run, status: "interrupting", interruptReason: reason };
    active.abortController.abort(reason);
    active.run = active.run;
    return active.run;
  }

  markInterrupted(runId: string, reason = "user interrupted"): AgentRun | undefined {
    const active = this.runs.get(runId);
    if (!active) return undefined;
    active.run = { ...active.run, status: "interrupted", interruptReason: reason, finishedAt: now() };
    this.activeByCase.delete(active.run.caseId);
    return active.run;
  }

  complete(runId: string): AgentRun | undefined {
    const active = this.runs.get(runId);
    if (!active) return undefined;
    active.run = { ...active.run, status: "completed", finishedAt: now() };
    this.activeByCase.delete(active.run.caseId);
    return active.run;
  }

  fail(runId: string, error: string): AgentRun | undefined {
    const active = this.runs.get(runId);
    if (!active) return undefined;
    active.run = { ...active.run, status: "failed", error, finishedAt: now() };
    this.activeByCase.delete(active.run.caseId);
    return active.run;
  }
}
```

- [ ] **Step 4: Verify registry tests pass**

Run: `pnpm --filter @traceforge/server exec vitest run src/agent-runs.test.ts`

Expected: PASS.

- [ ] **Step 5: Build server**

Run: `pnpm --filter @traceforge/server build`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/agent-runs.ts apps/server/src/agent-runs.test.ts
git commit -m "feat(server): add in-memory agent run registry"
```

---

### Task 3: provider streaming interface and AgentRuntime fallback/steering

**Files:**
- Modify: `packages/extension/src/provider.ts`
- Modify: `packages/extension/src/agent-runtime.ts`
- Modify: `packages/extension/src/agent-runtime.test.ts`

- [ ] **Step 1: Add failing AgentRuntime tests**

Extend `packages/extension/src/agent-runtime.test.ts` with these tests:

```ts
it("emits stream events through fallback runTools when provider has no streamTools", async () => {
  const provider = {
    runTools: async () => ({ text: "hello", toolCalls: [], done: true }),
    extractJson: async () => ({}),
  };
  const events: AgentEvent[] = [];
  await new AgentRuntime(provider, new ToolRegistry(), new ApprovalGate(async () => "approved"))
    .run("sys", "goal", (e) => events.push(e));
  expect(events.map((e) => e.type)).toEqual(["stream_start", "stream_delta", "stream_end", "text", "done"]);
  expect(events.find((e) => e.type === "stream_delta")?.content).toBe("hello");
});

it("injects soft steering messages after tool results", async () => {
  const seen: string[][] = [];
  const provider = {
    extractJson: async () => ({}),
    runTools: async ({ messages }: RunToolsArgs) => {
      seen.push(messages.map((m) => m.content));
      if (seen.length === 1) {
        return { text: "need tool", toolCalls: [{ id: "tc_1", name: "read", input: {} }], done: false };
      }
      return { text: "steered", toolCalls: [], done: true };
    },
  };
  const registry = new ToolRegistry();
  registry.register({ name: "read", description: "read", inputSchema: { type: "object" }, risk: "normal", source: "test", execute: async () => ({ ok: true, content: "read ok" }) });
  await new AgentRuntime(provider, registry, new ApprovalGate(async () => "approved"))
    .run("sys", "goal", () => {}, { getSteeringMessages: () => ["look at orders"] });
  expect(seen[1].some((m) => m.includes("[Human steering]") && m.includes("look at orders"))).toBe(true);
});

it("stops before the next turn when signal is aborted", async () => {
  const ac = new AbortController();
  ac.abort("stop");
  const provider = {
    extractJson: async () => ({}),
    runTools: async () => { throw new Error("should not call provider"); },
  };
  const events: AgentEvent[] = [];
  await new AgentRuntime(provider, new ToolRegistry(), new ApprovalGate(async () => "approved"))
    .run("sys", "goal", (e) => events.push(e), { signal: ac.signal });
  expect(events.at(-1)?.type).toBe("interrupted");
});
```

If the file currently lacks imports, add:

```ts
import type { AgentEvent } from "./agent-runtime.js";
import type { RunToolsArgs } from "./provider.js";
```

- [ ] **Step 2: Run failing tests**

Run: `pnpm --filter @traceforge/extension exec vitest run src/agent-runtime.test.ts`

Expected: FAIL because AgentRuntime lacks options and stream event types.

- [ ] **Step 3: Extend provider interface**

Update `packages/extension/src/provider.ts`:

```ts
export interface StreamToolsHandlers {
  onTextDelta?: (delta: string) => void;
  signal?: AbortSignal;
}
```

Then extend `LlmProvider`:

```ts
  streamTools?(args: RunToolsArgs, handlers: StreamToolsHandlers): Promise<RunTurn>;
```

- [ ] **Step 4: Extend AgentRuntime event/options types**

Update `packages/extension/src/agent-runtime.ts`:

```ts
export interface AgentEvent {
  type: "tool_call" | "tool_result" | "tool_rejected" | "text" | "done" |
    "stream_start" | "stream_delta" | "stream_end" | "interrupted";
  name?: string;
  messageId?: string;
  content: string;
}

export interface AgentRunOptions {
  signal?: AbortSignal;
  runId?: string;
  getSteeringMessages?: () => string[];
}
```

- [ ] **Step 5: Add streaming helper and abort checks**

In `AgentRuntime`, add private helpers:

```ts
private interrupted(options?: AgentRunOptions): boolean {
  return options?.signal?.aborted === true;
}

private emitInterrupted(onEvent: (e: AgentEvent) => void): void {
  onEvent({ type: "interrupted", content: "agent run interrupted" });
}
```

Change `run` signature:

```ts
async run(
  system: string,
  initial: string | { role: "user" | "assistant"; content: string }[],
  onEvent: (e: AgentEvent) => void,
  options: AgentRunOptions = {},
): Promise<void>
```

Inside the turn loop, before provider call:

```ts
if (this.interrupted(options)) {
  this.emitInterrupted(onEvent);
  return;
}
```

Replace direct `this.provider.runTools(...)` with:

```ts
const messageId = `msg_${crypto.randomUUID()}`;
let streamed = "";
onEvent({ type: "stream_start", messageId, content: "" });
const turn = this.provider.streamTools
  ? await this.provider.streamTools(
      { system, messages, tools: this.registry.toLlmTools() },
      {
        signal: options.signal,
        onTextDelta: (delta) => {
          streamed += delta;
          onEvent({ type: "stream_delta", messageId, content: delta });
        },
      },
    )
  : await this.provider.runTools({ system, messages, tools: this.registry.toLlmTools() });
if (!this.provider.streamTools && turn.text) {
  streamed += turn.text;
  onEvent({ type: "stream_delta", messageId, content: turn.text });
}
onEvent({ type: "stream_end", messageId, content: streamed || turn.text });
```

Add `import { randomUUID } from "node:crypto";` and use `` `msg_${randomUUID()}` `` instead of `crypto.randomUUID()` for Node compatibility.

- [ ] **Step 6: Inject steering after tool results**

After the `for (const call of turn.toolCalls)` loop and before the next turn iteration:

```ts
const steering = options.getSteeringMessages?.() ?? [];
for (const text of steering) {
  messages.push({ role: "user", content: `[Human steering]\n用户运行中补充指令：${text}` });
}
```

Check `this.interrupted(options)` before each tool call and after each tool result; emit interrupted and return if aborted.

- [ ] **Step 7: Verify extension tests**

Run: `pnpm --filter @traceforge/extension exec vitest run src/agent-runtime.test.ts`

Expected: PASS.

- [ ] **Step 8: Build extension and llm packages**

Run: `pnpm --filter @traceforge/extension build`

Run: `pnpm --filter @traceforge/llm build`

Expected: both exit 0.

- [ ] **Step 9: Commit**

```bash
git add packages/extension/src/provider.ts packages/extension/src/agent-runtime.ts packages/extension/src/agent-runtime.test.ts
git commit -m "feat(agent): add streaming fallback and steering-aware runtime"
```

---

### Task 4: OpenAI-compatible true streamTools

**Files:**
- Modify: `packages/llm/src/openai-provider.ts`
- Create: `packages/llm/src/openai-stream-parse.test.ts`

- [ ] **Step 1: Extract stream parser contract test**

Create `packages/llm/src/openai-stream-parse.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { assembleOpenAIStreamChoice } from "./openai-provider.js";

describe("assembleOpenAIStreamChoice", () => {
  it("assembles text and fragmented tool call arguments", () => {
    const out = assembleOpenAIStreamChoice([
      { choices: [{ delta: { content: "hel" } }] },
      { choices: [{ delta: { content: "lo" } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "search", arguments: "{\"q\"" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ":\"x\"}" } }] }, finish_reason: "tool_calls" }] },
    ] as never);
    expect(out.text).toBe("hello");
    expect(out.toolCalls).toEqual([{ id: "call_1", name: "search", input: { q: "x" } }]);
    expect(out.done).toBe(false);
  });
});
```

- [ ] **Step 2: Run failing test**

Run: `pnpm --filter @traceforge/llm exec vitest run src/openai-stream-parse.test.ts`

Expected: FAIL because `assembleOpenAIStreamChoice` does not exist.

- [ ] **Step 3: Implement parser helper**

In `packages/llm/src/openai-provider.ts`, export helper near the top:

```ts
interface ToolAccumulator { id: string; name: string; args: string }

export function assembleOpenAIStreamChoice(chunks: Array<{ choices?: Array<{ delta?: { content?: string | null; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string | null }> }>): RunTurn {
  let text = "";
  let finish: string | null | undefined;
  const tools = new Map<number, ToolAccumulator>();
  for (const chunk of chunks) {
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finish = choice.finish_reason;
    const delta = choice.delta;
    if (!delta) continue;
    if (delta.content) text += delta.content;
    for (const tc of delta.tool_calls ?? []) {
      const cur = tools.get(tc.index) ?? { id: "", name: "", args: "" };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name = tc.function.name;
      if (tc.function?.arguments) cur.args += tc.function.arguments;
      tools.set(tc.index, cur);
    }
  }
  const toolCalls: ToolCall[] = [...tools.values()].map((tc) => ({
    id: tc.id,
    name: tc.name,
    input: JSON.parse(tc.args || "{}"),
  }));
  return { text, toolCalls, done: finish !== "tool_calls" };
}
```

- [ ] **Step 4: Implement `streamTools`**

Add method to `OpenAICompatibleProvider`:

```ts
async streamTools(args: RunToolsArgs, handlers: { onTextDelta?: (delta: string) => void; signal?: AbortSignal }): Promise<RunTurn> {
  const msgs = this.toOpenAIMessages(args);
  const chunks: unknown[] = [];
  const stream = await this.client.chat.completions.create({
    model: this.opts.model,
    messages: msgs as never,
    tools: args.tools.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.input_schema } })),
    stream: true,
  }, handlers.signal ? { signal: handlers.signal } : undefined);
  for await (const chunk of stream) {
    chunks.push(chunk);
    const delta = chunk.choices[0]?.delta?.content ?? "";
    if (delta) handlers.onTextDelta?.(delta);
  }
  return assembleOpenAIStreamChoice(chunks as never);
}
```

Refactor current `runTools` message conversion into a private `toOpenAIMessages(args: RunToolsArgs): Array<Record<string, unknown>>` and reuse it in both methods.

- [ ] **Step 5: Verify parser test and build**

Run: `pnpm --filter @traceforge/llm exec vitest run src/openai-stream-parse.test.ts`

Run: `pnpm --filter @traceforge/llm build`

Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add packages/llm/src/openai-provider.ts packages/llm/src/openai-stream-parse.test.ts
git commit -m "feat(llm): stream OpenAI-compatible tool calls"
```

---

### Task 5: server background run routes

**Files:**
- Modify: `apps/server/src/routes.ts`
- Create: `apps/server/src/routes-agent-run-control.test.ts`

- [ ] **Step 1: Write route tests**

Create `apps/server/src/routes-agent-run-control.test.ts` with a fake delayed provider:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createDb } from "./db/client.js";
import { EventBus } from "./event-bus.js";
import { registerRoutes } from "./routes.js";
import type { LlmProvider, RunToolsArgs } from "@traceforge/llm";
import type { RuntimeEvent } from "@traceforge/shared";

let app: FastifyInstance;
let events: RuntimeEvent[];
let caseId: string;

function delayedProvider(): LlmProvider {
  return {
    extractJson: async () => ({ warnings: [] }),
    runTools: async (_args: RunToolsArgs) => {
      await new Promise((r) => setTimeout(r, 50));
      return { text: "done", toolCalls: [], done: true };
    },
  };
}

beforeEach(async () => {
  app = Fastify();
  const db = createDb(":memory:");
  const bus = new EventBus();
  events = [];
  bus.subscribe((e) => events.push(e));
  registerRoutes(app, db, bus, delayedProvider());
  await app.ready();
  const res = await app.inject({ method: "POST", url: "/api/cases", payload: { name: "demo", allowHosts: ["example.com"] } });
  caseId = res.json().id;
  events.length = 0;
});

describe("agent run control routes", () => {
  it("starts a background run and returns run immediately", async () => {
    const started = await app.inject({ method: "POST", url: `/api/cases/${caseId}/agent/run`, payload: { goal: "go" } });
    expect(started.statusCode).toBe(200);
    const run = started.json().run;
    expect(run.id).toMatch(/^run_/);
    expect(run.status).toBe("running");
    expect(events.some((e) => e.type === "agent_run_started")).toBe(true);
  });

  it("rejects a second active run for the same case", async () => {
    await app.inject({ method: "POST", url: `/api/cases/${caseId}/agent/run`, payload: { goal: "go" } });
    const second = await app.inject({ method: "POST", url: `/api/cases/${caseId}/agent/run`, payload: { goal: "again" } });
    expect(second.statusCode).toBe(409);
  });

  it("accepts steering for an active run", async () => {
    const run = (await app.inject({ method: "POST", url: `/api/cases/${caseId}/agent/run`, payload: { goal: "go" } })).json().run;
    const steer = await app.inject({ method: "POST", url: `/api/agent/runs/${run.id}/steer`, payload: { content: "look at orders" } });
    expect(steer.statusCode).toBe(200);
    expect(events.some((e) => e.type === "agent_steering_added" && e.content.includes("orders"))).toBe(true);
  });

  it("interrupts an active run", async () => {
    const run = (await app.inject({ method: "POST", url: `/api/cases/${caseId}/agent/run`, payload: { goal: "go" } })).json().run;
    const stopped = await app.inject({ method: "POST", url: `/api/agent/runs/${run.id}/interrupt`, payload: { reason: "stop" } });
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json().run.status).toBe("interrupting");
  });
});
```

- [ ] **Step 2: Run failing route test**

Run: `pnpm --filter @traceforge/server exec vitest run src/routes-agent-run-control.test.ts`

Expected: FAIL because new routes and background behavior are not implemented.

- [ ] **Step 3: Instantiate AgentRunRegistry in routes**

In `apps/server/src/routes.ts`, import:

```ts
import { AgentRunRegistry } from "./agent-runs.js";
```

Near `const approvals = new ApprovalRegistry();`, add:

```ts
const runs = new AgentRunRegistry();
```

- [ ] **Step 4: Convert `/agent/run` to background run**

In `app.post("/api/cases/:id/agent/run", ...)`, after case lookup and before expensive setup:

```ts
const { goal } = req.body as { goal: string };
if (!goal?.trim()) return reply.code(400).send({ error: "goal required" });
let active;
try {
  active = runs.start(id, goal.trim());
} catch (err) {
  return reply.code(409).send({ error: "active run exists", reason: (err as Error).message });
}
bus.emit({ type: "agent_run_started", run: active.run });
bus.emit({ type: "agent_started", caseId: id, goal: active.run.goal });
setImmediate(() => {
  void runAgentInBackground(active.run.id).catch((err) => {
    const failed = runs.fail(active.run.id, (err as Error).message);
    if (failed) {
      bus.emit({ type: "agent_run_failed", run: failed, error: (err as Error).message });
      bus.emit({ type: "agent_error", caseId: id, content: (err as Error).message });
    }
  });
});
return { run: active.run };
```

Move the existing registry/tool/context/runtime body into a local async function:

```ts
const runAgentInBackground = async (runId: string) => {
  const running = runs.get(runId);
  if (!running) return;
  // existing body from after goal extraction through Observer/compressor.
};
```

Inside `AgentRuntime.run` event mapper, map new stream/interrupted events:

```ts
else if (e.type === "stream_start") bus.emit({ type: "agent_stream_start", caseId: id, runId, messageId: e.messageId ?? "" });
else if (e.type === "stream_delta") bus.emit({ type: "agent_stream_delta", caseId: id, runId, messageId: e.messageId ?? "", delta: e.content });
else if (e.type === "stream_end") bus.emit({ type: "agent_stream_end", caseId: id, runId, messageId: e.messageId ?? "", content: e.content });
else if (e.type === "interrupted") {
  const interrupted = runs.markInterrupted(runId, running.run.interruptReason ?? e.content);
  if (interrupted) bus.emit({ type: "agent_run_interrupted", run: interrupted });
}
```

Pass options to runtime:

```ts
{ signal: running.abortController.signal, runId, getSteeringMessages: () => runs.consumeSteering(runId) }
```

After successful runtime completion, if not interrupted:

```ts
const completed = runs.complete(runId);
if (completed) bus.emit({ type: "agent_run_completed", run: completed, content: trajectory.at(-1) ?? "" });
```

- [ ] **Step 5: Add steer/interrupt/active routes**

Append near approval route:

```ts
app.post("/api/agent/runs/:runId/steer", async (req, reply) => {
  const { runId } = req.params as { runId: string };
  const { content } = (req.body ?? {}) as { content?: string };
  if (!content?.trim()) return reply.code(400).send({ error: "content required" });
  const run = runs.addSteering(runId, content.trim());
  if (!run) return reply.code(404).send({ error: "run not found or not active" });
  agentEventStore.append(run.caseId, "user", `[steering] ${content.trim()}`);
  bus.emit({ type: "agent_steering_added", caseId: run.caseId, runId, content: content.trim() });
  return { run };
});

app.post("/api/agent/runs/:runId/interrupt", async (req, reply) => {
  const { runId } = req.params as { runId: string };
  const { reason } = (req.body ?? {}) as { reason?: string };
  const run = runs.interrupt(runId, reason);
  if (!run) return reply.code(404).send({ error: "run not found" });
  return { run };
});

app.get("/api/cases/:id/agent/runs/active", async (req) => {
  const { id } = req.params as { id: string };
  return runs.getActiveByCase(id)?.run ?? null;
});
```

- [ ] **Step 6: Verify route test**

Run: `pnpm --filter @traceforge/server exec vitest run src/routes-agent-run-control.test.ts`

Expected: PASS.

- [ ] **Step 7: Run existing agent route tests**

Run: `pnpm --filter @traceforge/server exec vitest run src/routes-agent.test.ts src/routes-agent-events.test.ts`

Expected: PASS, adjusting tests to expect `{ run }` from `/agent/run` if they previously expected `{ ok: true }`.

- [ ] **Step 8: Build server**

Run: `pnpm --filter @traceforge/server build`

Expected: exit 0.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/routes.ts apps/server/src/routes-agent-run-control.test.ts apps/server/src/routes-agent.test.ts apps/server/src/routes-agent-events.test.ts
git commit -m "feat(server): run agents as interruptible background jobs"
```

---

### Task 6: web API/store run state and stream handling

**Files:**
- Modify: `apps/web/src/api.ts`
- Modify: `apps/web/src/store.ts`
- Modify: `apps/web/src/store.test.ts`

- [ ] **Step 1: Write failing store tests**

Append to `apps/web/src/store.test.ts`:

```ts
describe("agent run control event handling", () => {
  it("tracks active run and concatenates streaming deltas", () => {
    const s = useStore.getState();
    s.setCase("case_1");
    useStore.getState().handleRuntimeEvent({ type: "agent_run_started", run: {
      id: "run_1", caseId: "case_1", goal: "go", status: "running", createdAt: "t",
      startedAt: "t", finishedAt: null, interruptReason: null, error: null,
    } });
    useStore.getState().handleRuntimeEvent({ type: "agent_stream_start", caseId: "case_1", runId: "run_1", messageId: "m1" });
    useStore.getState().handleRuntimeEvent({ type: "agent_stream_delta", caseId: "case_1", runId: "run_1", messageId: "m1", delta: "hel" });
    useStore.getState().handleRuntimeEvent({ type: "agent_stream_delta", caseId: "case_1", runId: "run_1", messageId: "m1", delta: "lo" });
    expect(useStore.getState().activeRun?.id).toBe("run_1");
    expect(useStore.getState().agentEvents.at(-1)?.text).toBe("hello");
  });

  it("records steering and clears active run on interruption", () => {
    useStore.getState().setCase("case_1");
    useStore.getState().handleRuntimeEvent({ type: "agent_steering_added", caseId: "case_1", runId: "run_1", content: "look at orders" });
    expect(useStore.getState().agentEvents.at(-1)?.kind).toBe("user");
    useStore.getState().handleRuntimeEvent({ type: "agent_run_interrupted", run: {
      id: "run_1", caseId: "case_1", goal: "go", status: "interrupted", createdAt: "t",
      startedAt: "t", finishedAt: "t2", interruptReason: "stop", error: null,
    } });
    expect(useStore.getState().activeRun).toBeNull();
  });
});
```

- [ ] **Step 2: Run failing store tests**

Run: `pnpm --filter @traceforge/web exec vitest run src/store.test.ts`

Expected: FAIL because `handleRuntimeEvent` and `activeRun` do not exist.

- [ ] **Step 3: Update web API**

In `apps/web/src/api.ts`, import `AgentRun`:

```ts
import type { Case, TrafficEntry, Fact, Task, TimelineEntry, ObserverWarning, AgentEvent, AgentRun } from "@traceforge/shared";
```

Change `runAgent`:

```ts
export async function runAgent(caseId: string, goal: string): Promise<AgentRun> {
  const r = await ensureOk(await fetch(`/api/cases/${caseId}/agent/run`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ goal }),
  }), "运行 Agent");
  return (await r.json()).run;
}
```

Add:

```ts
export async function steerAgentRun(runId: string, content: string): Promise<AgentRun> {
  const r = await ensureOk(await fetch(`/api/agent/runs/${runId}/steer`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content }),
  }), "补充指令");
  return (await r.json()).run;
}

export async function interruptAgentRun(runId: string, reason?: string): Promise<AgentRun> {
  const r = await ensureOk(await fetch(`/api/agent/runs/${runId}/interrupt`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason }),
  }), "停止 Agent");
  return (await r.json()).run;
}

export async function getActiveAgentRun(caseId: string): Promise<AgentRun | null> {
  return (await fetch(`/api/cases/${caseId}/agent/runs/active`)).json();
}
```

- [ ] **Step 4: Update store state**

In `apps/web/src/store.ts`, import `AgentRun` and add:

```ts
activeRun: AgentRun | null;
streamingMessages: Record<string, number>;
setActiveRun: (run: AgentRun | null) => void;
handleRuntimeEvent: (event: RuntimeEvent) => void;
```

Add initial state:

```ts
activeRun: null,
streamingMessages: {},
setActiveRun: (run) => set({ activeRun: run, agentBusy: run ? ["queued", "running", "interrupting"].includes(run.status) : false }),
```

Extract current `ws.onmessage` body into `handleRuntimeEvent`. In new event handling:

```ts
else if (event.type === "agent_run_started" && event.run.caseId === cid) {
  get().setActiveRun(event.run);
  get().addAgentEvent({ kind: "started", text: `开始：${event.run.goal}` });
}
else if (event.type === "agent_stream_start" && event.caseId === cid) {
  set((s) => ({ streamingMessages: { ...s.streamingMessages, [event.messageId]: s.agentEvents.length } }));
  get().addAgentEvent({ kind: "text", text: "" });
}
else if (event.type === "agent_stream_delta" && event.caseId === cid) {
  set((s) => {
    const index = s.streamingMessages[event.messageId];
    if (index === undefined) return {};
    const events = s.agentEvents.slice();
    const cur = events[index];
    events[index] = { ...cur, text: cur.text + event.delta };
    return { agentEvents: events };
  });
}
else if (event.type === "agent_steering_added" && event.caseId === cid) {
  get().addAgentEvent({ kind: "user", text: `[steering] ${event.content}` });
}
else if (event.type === "agent_run_completed" && event.run.caseId === cid) {
  get().setActiveRun(null);
  get().setAgentBusy(false);
}
else if (event.type === "agent_run_interrupted" && event.run.caseId === cid) {
  get().setActiveRun(null);
  get().setAgentBusy(false);
  get().addAgentEvent({ kind: "done", text: "Agent 已停止" });
}
else if (event.type === "agent_run_failed" && event.run.caseId === cid) {
  get().setActiveRun(null);
  get().setAgentBusy(false);
  get().addAgentEvent({ kind: "error", text: event.error });
}
```

Keep legacy handlers for `agent_started`, `agent_text`, `agent_done`, `agent_error`, but guard against duplicate UX later in Task 7 if needed.

- [ ] **Step 5: Verify store tests**

Run: `pnpm --filter @traceforge/web exec vitest run src/store.test.ts`

Expected: PASS.

- [ ] **Step 6: Build web**

Run: `pnpm --filter @traceforge/web build`

Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/api.ts apps/web/src/store.ts apps/web/src/store.test.ts
git commit -m "feat(web): track streaming agent run state"
```

---

### Task 7: AgentPanel steering and interrupt UI

**Files:**
- Modify: `apps/web/src/components/AgentPanel.tsx`
- Modify: `apps/web/src/app.css` if minor styling is needed

- [ ] **Step 1: Update imports**

In `AgentPanel.tsx`, change API import:

```ts
import { runAgent, resolveApproval, approveScope, steerAgentRun, interruptAgentRun } from "../api.js";
```

- [ ] **Step 2: Read active run from store**

Extend the store destructuring:

```ts
const {
  caseId, agentEvents, agentBusy, setAgentBusy, showToast, pendingApproval,
  pendingScope, setPendingScope, clearPendingApproval, resetAgent, addAgentEvent,
  activeRun, setActiveRun,
} = useStore();
```

- [ ] **Step 3: Change send behavior**

Replace `send` with:

```ts
const send = async () => {
  if (!goal.trim()) return;
  const g = goal.trim();
  setGoal("");
  try {
    if (activeRun) {
      addAgentEvent({ kind: "user", text: `[steering] ${g}` });
      const run = await steerAgentRun(activeRun.id, g);
      setActiveRun(run);
      return;
    }
    addAgentEvent({ kind: "user", text: g });
    setAgentBusy(true);
    const run = await runAgent(caseId, g);
    setActiveRun(run);
  } catch (e) {
    showToast((e as Error).message);
    if (!activeRun) setAgentBusy(false);
  }
};
```

- [ ] **Step 4: Add stop behavior**

Add:

```ts
const stopRun = async () => {
  if (!activeRun) return;
  try {
    const run = await interruptAgentRun(activeRun.id, "用户停止");
    setActiveRun(run);
  } catch (e) {
    showToast((e as Error).message);
  }
};
```

- [ ] **Step 5: Update composer UI**

Change placeholder and buttons:

```tsx
placeholder={activeRun ? "给当前 run 补充指令（Enter 发送）…" : agentBusy ? "Agent 运行中，请稍候…" : "给 agent 一个目标（Enter 发送，Shift+Enter 换行）…"}
```

Change button disabled:

```tsx
<button disabled={!goal.trim()} onClick={send}>
```

Add stop button next to submit when active:

```tsx
{activeRun && (
  <button className="tf-btn" type="button" onClick={stopRun}>
    停止
  </button>
)}
```

If `.composer` cannot fit two buttons, add a small CSS rule in `app.css`:

```css
.composer .tf-btn {
  height: 36px;
  white-space: nowrap;
}
```

- [ ] **Step 6: Build web**

Run: `pnpm --filter @traceforge/web build`

Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/AgentPanel.tsx apps/web/src/app.css
git commit -m "feat(web): allow steering and stopping active agent runs"
```

---

### Task 8: documentation, full verification, and real LLM e2e checklist

**Files:**
- Modify: `README.md`
- Modify: `TraceForge_design.md`
- Create: `docs/superpowers/plans/2026-06-30-agent-run-control-real-llm-check.md`

- [ ] **Step 1: Add real LLM validation checklist doc**

Create `docs/superpowers/plans/2026-06-30-agent-run-control-real-llm-check.md`:

```md
# Agent Run Control Real LLM Validation Checklist

This checklist must be run with a real configured LLM. Mock providers are allowed for unit tests only.

## Environment

- Load `.env` so the real provider API key is present.
- Start server with the non-watch command if Windows port reuse becomes unstable.
- Start web dev server.

## Steps

1. Create a Case with an allowed host.
2. Start an agent run with a goal that requires at least two turns.
3. Confirm `POST /agent/run` returns a `runId` quickly.
4. Confirm the UI receives `agent_stream_start`, at least one `agent_stream_delta`, and `agent_stream_end`.
5. While the run is active, send a steering message: `先列出已有资源，再决定下一步。`
6. Confirm the UI records the steering event.
7. Confirm a subsequent LLM turn follows or acknowledges the steering.
8. Start another long run and press Stop.
9. Confirm the run becomes `interrupted`, the UI input is usable, and a fresh run can start.

## Pass Criteria

- Streaming is visible with the configured real provider or fallback delta if that provider lacks true streaming.
- Steering changes the next LLM turn.
- Interrupt stops later turns and clears active run state.
```

- [ ] **Step 2: Update README current progress**

In `README.md`, extend the current progress heading to include `Agent Run Control` and add one bullet:

```md
- Agent Run Control（Streaming + Interrupt/Steering）：agent run 升级为可管理后台运行对象，启动后返回 runId；前端通过 stream 事件实时显示输出，运行中可追加 steering 指令并可停止当前 run。OpenAI-compatible provider 优先真流式，其它 provider 走统一 fallback；真实 LLM 验证见 `docs/superpowers/plans/2026-06-30-agent-run-control-real-llm-check.md`。
```

- [ ] **Step 3: Update design roadmap**

In `TraceForge_design.md` §31.3 after Pull 式记忆检索, add item 9:

```md
9. **Agent Run Control（Streaming + Interrupt/Steering）** — ✅ 已完成。把 agent/run 从阻塞长请求升级为可管理后台 run：AgentRun 状态模型、stream 事件、OpenAI-compatible 真流式、非流式 fallback、Abort interrupt、soft steering（下一轮注入人工补充指令）和前端停止/插话 UI。对应 `docs/agent-gap-backlog.md` #1/#2。
```

- [ ] **Step 4: Run focused test suite**

Run:

```bash
pnpm --filter @traceforge/shared exec vitest run src/agent-run.test.ts
pnpm --filter @traceforge/extension exec vitest run src/agent-runtime.test.ts
pnpm --filter @traceforge/llm exec vitest run src/openai-stream-parse.test.ts
pnpm --filter @traceforge/server exec vitest run src/agent-runs.test.ts src/routes-agent-run-control.test.ts src/routes-agent.test.ts src/routes-agent-events.test.ts
pnpm --filter @traceforge/web exec vitest run src/store.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Run full verification**

Run:

```bash
pnpm test
pnpm -r build
```

Expected: all tests pass and all packages build.

- [ ] **Step 6: Real LLM e2e**

Run the checklist in `docs/superpowers/plans/2026-06-30-agent-run-control-real-llm-check.md` with a real configured LLM. Record:

- provider/model used from `config/llm.json`
- whether true streaming or fallback streaming occurred
- steering message used
- interrupt result
- any observed bugs

Do not mark real LLM behavior verified unless this manual/e2e check has actually run.

- [ ] **Step 7: Commit docs and verification updates**

```bash
git add README.md TraceForge_design.md docs/superpowers/plans/2026-06-30-agent-run-control-real-llm-check.md
git commit -m "docs: mark agent run control complete"
```

---

## Plan Self-Review

- Spec coverage: covers AgentRun model, event protocol, provider fallback, OpenAI true streaming, interrupt, soft steering, server APIs, frontend UI, and real LLM validation.
- Scope: excludes persistence, hard steering, tool parallelism, dynamic turns, and Observer realtime as required by the spec.
- Type consistency: uses `AgentRun`, `RuntimeEvent`, `RunToolsArgs`, `AgentEvent`, `AgentRunRegistry` consistently.
- No domain hardcoding: no vulnerability payloads, scanners, or fixed vulnerability rules are introduced.
