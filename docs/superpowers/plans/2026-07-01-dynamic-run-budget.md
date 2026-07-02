# Dynamic Run Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hidden hard-coded agent turn cap with an explicit run budget that warns before exhaustion and marks exhausted runs as needing continuation instead of falsely completed.

**Architecture:** Add shared continuation status/event schema first, then thread a normalized budget through `AgentRuntime`, server run registry/routes, and the web store. Budget exhaustion is a terminal state distinct from success; the UI can clear busy state now and a later feature can add a one-click continue flow.

**Tech Stack:** TypeScript, pnpm workspaces, Vitest, Zod, OpenAI-compatible agent runtime abstractions.

---

## File Structure

- Modify: `packages/shared/src/schemas.ts`
  - Add `needs_continuation` to `AgentRunStatusSchema`.
  - Add `completionReason: string | null` to `AgentRunSchema` with a schema default of `null`.
- Modify: `packages/shared/src/events.ts`
  - Add `agent_run_needs_continuation` to `RuntimeEvent`.
- Modify: `packages/shared/src/agent-run.test.ts`
  - Cover parsing the new status and defaulting `completionReason`.
- Modify: `packages/extension/src/agent-runtime.ts`
  - Add `AgentRunBudget`, `DEFAULT_RUN_BUDGET`, `normalizeRunBudget`, budget warning event, budget exhausted event, and warning notice injection.
- Modify: `packages/extension/src/agent-runtime.test.ts`
  - Cover warning, notice injection, exhaustion, normal completion, and interrupt precedence with deterministic fake providers.
- Modify: `apps/server/src/agent-runs.ts`
  - Store `completionReason`, treat `needs_continuation` as terminal, and add `needsContinuation()`.
- Modify: `apps/server/src/agent-runs.test.ts`
  - Cover continuation terminal behavior and ability to start a later run after exhaustion.
- Modify: `apps/server/src/routes.ts`
  - Accept optional `budget` in `/agent/run`, pass it to `AgentRuntime`, map runtime `budget_exhausted` to `agent_run_needs_continuation`, and avoid blind post-run completion when the registry is already terminal.
- Modify: `apps/server/src/routes-agent-run-control.test.ts`
  - Cover route-level continuation event with a tiny budget.
- Modify: `apps/web/src/store.ts`
  - Handle `agent_run_needs_continuation` by clearing busy state and appending a visible terminal event.
- Modify: `apps/web/src/store.test.ts`
  - Cover the web store handling and add `completionReason` to `AgentRun` fixtures.
- Modify: `docs/agent-gap-backlog.md`
  - Mark the run-budget milestone done and record remaining continuation UI work.
- Modify: `README.md`
  - Document optional run budget and continuation status at a high level.
- Modify: `TraceForge_design.md`
  - Update current agent runtime behavior.
- Modify: `docs/superpowers/plans/2026-07-01-dynamic-run-budget.md`
  - Fill Result Log after implementation and real validation.

## Task 1: Shared Run Status And Runtime Event

**Files:**
- Modify: `packages/shared/src/schemas.ts`
- Modify: `packages/shared/src/events.ts`
- Modify: `packages/shared/src/agent-run.test.ts`

- [ ] **Step 1: Write failing shared schema tests**

Add these tests to `packages/shared/src/agent-run.test.ts` near the existing run schema tests:

```ts
import { describe, expect, it } from "vitest";
import { AgentRunSchema, AgentRunStatusSchema } from "./schemas";

describe("AgentRunSchema", () => {
  it("accepts needs_continuation as an agent run status", () => {
    expect(AgentRunStatusSchema.parse("needs_continuation")).toBe("needs_continuation");
  });

  it("defaults completionReason to null for older run payloads", () => {
    const run = AgentRunSchema.parse({
      id: "run-1",
      caseId: "case-1",
      goal: "Investigate alert",
      status: "queued",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z"
    });

    expect(run.completionReason).toBeNull();
  });

  it("preserves completionReason when present", () => {
    const run = AgentRunSchema.parse({
      id: "run-1",
      caseId: "case-1",
      goal: "Investigate alert",
      status: "needs_continuation",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
      completionReason: "run budget exhausted after 2 turns"
    });

    expect(run.completionReason).toBe("run budget exhausted after 2 turns");
  });
});
```

If `packages/shared/src/agent-run.test.ts` already imports these symbols or has an existing `describe("AgentRunSchema")`, merge the test bodies into the existing structure instead of duplicating imports.

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
pnpm --filter @traceforge/shared exec vitest run src/agent-run.test.ts
```

Expected: FAIL. At least one failure should mention that `"needs_continuation"` is not accepted or `completionReason` is missing.

- [ ] **Step 3: Update shared schemas**

In `packages/shared/src/schemas.ts`, update the status enum and run schema to this shape:

```ts
export const AgentRunStatusSchema = z.enum([
  "queued",
  "running",
  "interrupting",
  "interrupted",
  "needs_continuation",
  "completed",
  "failed"
]);

export const AgentRunSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  goal: z.string(),
  status: AgentRunStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().optional(),
  completionReason: z.string().nullable().default(null),
  error: z.string().optional()
});
```

Preserve any existing fields not shown here if the current schema has grown, but keep `completionReason` nullable with `.default(null)`.

- [ ] **Step 4: Add runtime event type**

In `packages/shared/src/events.ts`, add this union member to `RuntimeEvent`:

```ts
| {
    type: "agent_run_needs_continuation";
    run: AgentRun;
    reason: string;
  }
```

Keep the event beside other agent-run lifecycle events such as `agent_run_completed`, `agent_run_failed`, and `agent_run_interrupted`.

- [ ] **Step 5: Run shared tests**

Run:

```bash
pnpm --filter @traceforge/shared exec vitest run src/agent-run.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit shared schema work**

Run:

```bash
git add packages/shared/src/schemas.ts packages/shared/src/events.ts packages/shared/src/agent-run.test.ts
git commit -m "feat(shared): add agent run continuation status"
```

## Task 2: Agent Runtime Budget Warning And Exhaustion

**Files:**
- Modify: `packages/extension/src/agent-runtime.ts`
- Modify: `packages/extension/src/agent-runtime.test.ts`

- [ ] **Step 1: Write failing budget tests**

Add these tests to `packages/extension/src/agent-runtime.test.ts`. Reuse existing fake provider helpers if present; otherwise add the helpers below near the top of the file.

```ts
import { describe, expect, it } from "vitest";
import { AgentRuntime, type AgentEvent, type LlmProvider } from "./agent-runtime";

function loopingProvider(): LlmProvider {
  return {
    async complete() {
      return {
        content: "Searching again",
        toolCalls: [
          {
            id: "tool-call-1",
            name: "search_facts",
            arguments: { query: "trace" }
          }
        ]
      };
    }
  };
}

function doneProvider(): LlmProvider {
  return {
    async complete() {
      return { content: "Done", toolCalls: [] };
    }
  };
}

function captureProvider(messagesByCall: unknown[][]): LlmProvider {
  return {
    async complete(messages) {
      messagesByCall.push(messages);
      return {
        content: "Need one more search",
        toolCalls: [
          {
            id: "tool-call-1",
            name: "search_facts",
            arguments: { query: "trace" }
          }
        ]
      };
    }
  };
}

function createRuntime(provider: LlmProvider) {
  return new AgentRuntime({
    provider,
    tools: {
      search_facts: {
        description: "Search facts",
        parameters: { type: "object", properties: { query: { type: "string" } } },
        execute: async () => "fact"
      }
    }
  });
}

describe("AgentRuntime run budget", () => {
  it("emits budget_exhausted instead of done when maxTurns is reached", async () => {
    const events: AgentEvent[] = [];
    const runtime = createRuntime(loopingProvider());

    await runtime.run({
      goal: "Keep searching",
      budget: { maxTurns: 2, warningTurnsRemaining: 0 },
      onEvent: (event) => events.push(event)
    });

    expect(events.some((event) => event.type === "budget_exhausted")).toBe(true);
    expect(events).not.toContainEqual({ type: "done", content: "max turns reached" });
  });

  it("emits one budget_warning when the warning threshold is reached", async () => {
    const events: AgentEvent[] = [];
    const runtime = createRuntime(loopingProvider());

    await runtime.run({
      goal: "Keep searching",
      budget: { maxTurns: 3, warningTurnsRemaining: 2 },
      onEvent: (event) => events.push(event)
    });

    expect(events.filter((event) => event.type === "budget_warning")).toHaveLength(1);
    expect(events.find((event) => event.type === "budget_warning")?.content).toContain("2");
  });

  it("injects the run budget notice before the provider call on the warning turn", async () => {
    const calls: unknown[][] = [];
    const runtime = createRuntime(captureProvider(calls));

    await runtime.run({
      goal: "Keep searching",
      budget: { maxTurns: 2, warningTurnsRemaining: 1 },
      onEvent: () => undefined
    });

    expect(JSON.stringify(calls[1])).toContain("[Run budget notice]");
    expect(JSON.stringify(calls[1])).toContain("本次运行即将到达预算上限");
  });

  it("does not emit budget_exhausted when the model completes before the budget is spent", async () => {
    const events: AgentEvent[] = [];
    const runtime = createRuntime(doneProvider());

    await runtime.run({
      goal: "Finish directly",
      budget: { maxTurns: 2, warningTurnsRemaining: 1 },
      onEvent: (event) => events.push(event)
    });

    expect(events.some((event) => event.type === "done")).toBe(true);
    expect(events.some((event) => event.type === "budget_exhausted")).toBe(false);
  });

  it("keeps interruption terminal when interrupt is requested before exhaustion", async () => {
    const events: AgentEvent[] = [];
    const runtime = createRuntime(loopingProvider());
    runtime.requestInterrupt("user stopped");

    await runtime.run({
      goal: "Keep searching",
      budget: { maxTurns: 1, warningTurnsRemaining: 0 },
      onEvent: (event) => events.push(event)
    });

    expect(events.some((event) => event.type === "interrupted")).toBe(true);
    expect(events.some((event) => event.type === "budget_exhausted")).toBe(false);
  });
});
```

Adapt constructor names to the current test file if it already has a `createRuntime()` helper. The assertions and event names must remain unchanged.

- [ ] **Step 2: Run runtime tests to verify failure**

Run:

```bash
pnpm --filter @traceforge/extension exec vitest run src/agent-runtime.test.ts
```

Expected: FAIL with TypeScript errors for missing `budget`, `budget_warning`, or `budget_exhausted`, or a runtime failure because the old code emits `done: max turns reached`.

- [ ] **Step 3: Add budget types and normalization**

In `packages/extension/src/agent-runtime.ts`, add these exports near the existing option/event types:

```ts
export interface AgentRunBudget {
  maxTurns: number;
  warningTurnsRemaining: number;
}

export const DEFAULT_RUN_BUDGET: AgentRunBudget = {
  maxTurns: 25,
  warningTurnsRemaining: 3
};

export function normalizeRunBudget(input?: Partial<AgentRunBudget>): AgentRunBudget {
  const maxTurns =
    Number.isFinite(input?.maxTurns) && input?.maxTurns !== undefined && input.maxTurns > 0
      ? Math.floor(input.maxTurns)
      : DEFAULT_RUN_BUDGET.maxTurns;

  const rawWarningTurnsRemaining =
    Number.isFinite(input?.warningTurnsRemaining) && input?.warningTurnsRemaining !== undefined
      ? Math.floor(input.warningTurnsRemaining)
      : DEFAULT_RUN_BUDGET.warningTurnsRemaining;

  return {
    maxTurns,
    warningTurnsRemaining: Math.max(0, rawWarningTurnsRemaining)
  };
}
```

Update `AgentRunOptions`:

```ts
export interface AgentRunOptions {
  goal: string;
  budget?: Partial<AgentRunBudget>;
  onEvent?: (event: AgentEvent) => void;
}
```

Update `AgentEvent`:

```ts
export type AgentEvent =
  | { type: "text"; content: string }
  | { type: "tool_call"; name: string; arguments: unknown }
  | { type: "tool_result"; name: string; content: string }
  | { type: "budget_warning"; content: string }
  | { type: "budget_exhausted"; content: string }
  | { type: "interrupted"; content: string }
  | { type: "done"; content: string };
```

Preserve any existing event members that are not listed here.

- [ ] **Step 4: Replace hard-coded max turn loop**

Remove the hidden `MAX_TURNS` loop from `AgentRuntime.run()` and use this structure:

```ts
const RUN_BUDGET_NOTICE = `[Run budget notice]
本次运行即将到达预算上限。请优先判断：
1. 如果任务已经完成，直接总结并结束。
2. 如果任务未完成但有明确下一步，请说明下一步和为什么需要继续。
3. 如果缺少证据、权限、输入或外部条件，请记录 blocked task 或明确说明阻塞原因。
不要为了消耗轮次而继续调用无关工具。`;
```

Inside `run()`:

```ts
const budget = normalizeRunBudget(options.budget);
let warned = false;

for (let turnCount = 0; turnCount < budget.maxTurns; turnCount += 1) {
  if (this.interruptRequested) {
    onEvent({ type: "interrupted", content: this.interruptReason ?? "interrupted" });
    return;
  }

  const turnsRemaining = budget.maxTurns - turnCount;
  if (!warned && turnsRemaining <= budget.warningTurnsRemaining) {
    warned = true;
    onEvent({
      type: "budget_warning",
      content: `${turnsRemaining} turns remaining before run budget exhaustion`
    });
    messages.push({ role: "user", content: RUN_BUDGET_NOTICE });
  }

  const response = await this.provider.complete(messages, tools);

  if (response.content) {
    onEvent({ type: "text", content: response.content });
    messages.push({ role: "assistant", content: response.content });
  }

  if (!response.toolCalls.length) {
    onEvent({ type: "done", content: response.content || "done" });
    return;
  }

  for (const toolCall of response.toolCalls) {
    if (this.interruptRequested) {
      onEvent({ type: "interrupted", content: this.interruptReason ?? "interrupted" });
      return;
    }

    // Keep the existing tool execution code here.
  }
}

onEvent({
  type: "budget_exhausted",
  content: `run budget exhausted after ${budget.maxTurns} turns`
});
```

Do not duplicate existing provider or tool-call code. Move only the loop guard and terminal event behavior. Keep interrupt checks before provider calls and before tool execution.

- [ ] **Step 5: Run runtime tests**

Run:

```bash
pnpm --filter @traceforge/extension exec vitest run src/agent-runtime.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit runtime budget work**

Run:

```bash
git add packages/extension/src/agent-runtime.ts packages/extension/src/agent-runtime.test.ts
git commit -m "feat(agent): add dynamic run budget"
```

## Task 3: Server Registry And Route Mapping

**Files:**
- Modify: `apps/server/src/agent-runs.ts`
- Modify: `apps/server/src/agent-runs.test.ts`
- Modify: `apps/server/src/routes.ts`
- Modify: `apps/server/src/routes-agent-run-control.test.ts`

- [ ] **Step 1: Write failing registry tests**

Add these tests to `apps/server/src/agent-runs.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { AgentRunRegistry } from "./agent-runs";

describe("AgentRunRegistry continuation", () => {
  it("marks needs_continuation as terminal and records completionReason", () => {
    const registry = new AgentRunRegistry();
    const run = registry.start("case-1", "Investigate alert");

    const updated = registry.needsContinuation(run.id, "run budget exhausted after 2 turns");

    expect(updated?.status).toBe("needs_continuation");
    expect(updated?.completedAt).toBeDefined();
    expect(updated?.completionReason).toBe("run budget exhausted after 2 turns");
    expect(registry.getActive("case-1")).toBeUndefined();
  });

  it("allows a later run after a previous run needs continuation", () => {
    const registry = new AgentRunRegistry();
    const first = registry.start("case-1", "Investigate alert");

    registry.needsContinuation(first.id, "run budget exhausted after 2 turns");
    const second = registry.start("case-1", "Continue investigation");

    expect(second.status).toBe("running");
    expect(second.id).not.toBe(first.id);
  });
});
```

Merge imports if the file already has a registry `describe`.

- [ ] **Step 2: Run registry tests to verify failure**

Run:

```bash
pnpm --filter @traceforge/server exec vitest run src/agent-runs.test.ts
```

Expected: FAIL because `needsContinuation()` does not exist or active run cleanup does not include `needs_continuation`.

- [ ] **Step 3: Implement registry continuation**

In `apps/server/src/agent-runs.ts`, ensure new run objects include `completionReason: null`:

```ts
const run: AgentRun = {
  id: randomUUID(),
  caseId,
  goal,
  status: "running",
  createdAt: now,
  updatedAt: now,
  completionReason: null
};
```

Add `needs_continuation` to the terminal status helper:

```ts
function isTerminalStatus(status: AgentRun["status"]): boolean {
  return ["interrupted", "needs_continuation", "completed", "failed"].includes(status);
}
```

Add or update terminal methods:

```ts
complete(runId: string, reason = "completed normally"): AgentRun | undefined {
  return this.finish(runId, { status: "completed", completionReason: reason });
}

needsContinuation(runId: string, reason: string): AgentRun | undefined {
  return this.finish(runId, { status: "needs_continuation", completionReason: reason });
}

markInterrupted(runId: string, reason = "interrupted"): AgentRun | undefined {
  return this.finish(runId, { status: "interrupted", completionReason: reason });
}

fail(runId: string, error: string): AgentRun | undefined {
  return this.finish(runId, { status: "failed", error, completionReason: error });
}
```

If the file does not have a `finish()` helper, add one:

```ts
private finish(
  runId: string,
  patch: Pick<AgentRun, "status"> & Partial<Pick<AgentRun, "error" | "completionReason">>
): AgentRun | undefined {
  const entry = this.get(runId);
  if (!entry) return undefined;

  const now = new Date().toISOString();
  const updated: AgentRun = {
    ...entry.run,
    ...patch,
    updatedAt: now,
    completedAt: now,
    completionReason: patch.completionReason ?? entry.run.completionReason ?? null
  };

  this.runs.set(runId, updated);
  if (isTerminalStatus(updated.status)) {
    this.activeByCase.delete(updated.caseId);
  }
  return updated;
}
```

Keep the current map names if they differ; do not rename the whole registry.

- [ ] **Step 4: Run registry tests**

Run:

```bash
pnpm --filter @traceforge/server exec vitest run src/agent-runs.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write failing route-level continuation test**

In `apps/server/src/routes-agent-run-control.test.ts`, add a test that starts an agent run with a tiny budget and a provider that always requests a tool call. Use the current test server harness names; the important event assertions are:

```ts
it("emits agent_run_needs_continuation when the runtime budget is exhausted", async () => {
  const events: RuntimeEvent[] = [];
  const app = await createTestApp({
    provider: {
      async complete() {
        return {
          content: "Searching again",
          toolCalls: [
            {
              id: "tool-call-1",
              name: "search_facts",
              arguments: { query: "trace" }
            }
          ]
        };
      }
    },
    onRuntimeEvent: (event) => events.push(event)
  });

  const response = await app.inject({
    method: "POST",
    url: "/cases/case-1/agent/run",
    payload: {
      goal: "Keep searching",
      budget: { maxTurns: 1, warningTurnsRemaining: 0 }
    }
  });

  expect(response.statusCode).toBe(202);
  await waitFor(() => events.some((event) => event.type === "agent_run_needs_continuation"));

  const continuation = events.find(
    (event): event is Extract<RuntimeEvent, { type: "agent_run_needs_continuation" }> =>
      event.type === "agent_run_needs_continuation"
  );

  expect(continuation?.run.status).toBe("needs_continuation");
  expect(continuation?.reason).toContain("run budget exhausted");
  expect(events.some((event) => event.type === "agent_run_completed")).toBe(false);
});
```

If the current test harness uses a different URL or app factory, keep that harness and preserve the payload and assertions.

- [ ] **Step 6: Run route test to verify failure**

Run:

```bash
pnpm --filter @traceforge/server exec vitest run src/routes-agent-run-control.test.ts
```

Expected: FAIL because the route ignores `budget` or maps exhaustion to completion.

- [ ] **Step 7: Accept optional request budget**

In `apps/server/src/routes.ts`, import the budget type if useful:

```ts
import type { AgentRunBudget } from "@traceforge/extension";
```

Parse optional budget from the request body:

```ts
const { goal, budget } = request.body as {
  goal: string;
  budget?: Partial<AgentRunBudget>;
};
```

Pass it into the runtime:

```ts
await runtime.run({
  goal,
  budget,
  onEvent: (event) => {
    // existing mapping plus budget handling
  }
});
```

Keep existing clients compatible: `budget` is optional and omitted clients still get the default 25-turn budget.

- [ ] **Step 8: Map budget runtime events to server events**

Inside the `AgentRuntime.run()` callback in `apps/server/src/routes.ts`, add these cases:

```ts
if (event.type === "budget_warning") {
  const content = `运行预算提醒：${event.content}`;
  agentEventStore.append(caseId, { kind: "text", text: content });
  bus.emit({
    type: "agent_text",
    caseId,
    text: content
  });
  trajectory.push(`[budget_warning] ${event.content}`);
  return;
}

if (event.type === "budget_exhausted") {
  const run = runs.needsContinuation(runId, event.content);
  if (run) {
    agentEventStore.append(caseId, {
      kind: "done",
      text: "Agent 已到达本次运行预算，需要继续运行。"
    });
    bus.emit({
      type: "agent_run_needs_continuation",
      run,
      reason: event.content
    });
    trajectory.push(`[budget_exhausted] ${event.content}`);
  }
  return;
}
```

Do not emit `agent_run_completed` or `agent_done` for budget exhaustion.

- [ ] **Step 9: Prevent blind completion after terminal runtime events**

At the end of the route's async run task, replace any unconditional completion with a status check:

```ts
const current = runs.get(runId)?.run;
if (current?.status === "running" || current?.status === "interrupting") {
  const completed = runs.complete(runId, "runtime completed without explicit terminal event");
  if (completed) {
    bus.emit({
      type: "agent_run_completed",
      run: completed,
      reason: completed.completionReason ?? "completed"
    });
  }
}
```

If the current code already completes on `done`, keep that behavior and only use this guard as a fallback.

- [ ] **Step 10: Run server tests**

Run:

```bash
pnpm --filter @traceforge/server exec vitest run src/agent-runs.test.ts src/routes-agent-run-control.test.ts
```

Expected: PASS.

- [ ] **Step 11: Commit server continuation work**

Run:

```bash
git add apps/server/src/agent-runs.ts apps/server/src/agent-runs.test.ts apps/server/src/routes.ts apps/server/src/routes-agent-run-control.test.ts
git commit -m "feat(server): mark budget exhaustion as continuation"
```

## Task 4: Web Store Continuation Handling

**Files:**
- Modify: `apps/web/src/store.ts`
- Modify: `apps/web/src/store.test.ts`

- [ ] **Step 1: Update existing AgentRun fixtures**

In `apps/web/src/store.test.ts`, update every hand-written `AgentRun` fixture to include:

```ts
completionReason: null
```

For terminal fixtures, use the actual reason:

```ts
completionReason: "run budget exhausted after 1 turns"
```

- [ ] **Step 2: Write failing web store test**

Add this test near the existing runtime event handling tests:

```ts
it("clears busy state and records a done event when an agent run needs continuation", () => {
  const run: AgentRun = {
    id: "run-1",
    caseId: "case-1",
    goal: "Investigate alert",
    status: "needs_continuation",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    completedAt: "2026-07-01T00:01:00.000Z",
    completionReason: "run budget exhausted after 1 turns"
  };

  useTraceForgeStore.setState({
    activeCaseId: "case-1",
    activeRun: {
      ...run,
      status: "running",
      completedAt: undefined,
      completionReason: null
    },
    agentBusy: true,
    agentEvents: []
  });

  useTraceForgeStore.getState().handleRuntimeEvent({
    type: "agent_run_needs_continuation",
    run,
    reason: "run budget exhausted after 1 turns"
  });

  const state = useTraceForgeStore.getState();
  expect(state.agentBusy).toBe(false);
  expect(state.activeRun).toBeNull();
  expect(state.agentEvents.at(-1)).toEqual({
    kind: "done",
    text: "Agent 已到达本次运行预算，需要继续运行。"
  });
});
```

- [ ] **Step 3: Run web store tests to verify failure**

Run:

```bash
pnpm --filter @traceforge/web exec vitest run src/store.test.ts
```

Expected: FAIL because `agent_run_needs_continuation` is not handled.

- [ ] **Step 4: Implement web store event handling**

In `apps/web/src/store.ts`, add this case to the runtime event handler:

```ts
if (event.type === "agent_run_needs_continuation") {
  if (event.run.caseId !== get().activeCaseId) return;

  set({
    agentBusy: false,
    activeRun: null
  });
  get().addAgentEvent({
    kind: "done",
    text: "Agent 已到达本次运行预算，需要继续运行。"
  });
  return;
}
```

Keep this beside the existing `agent_run_completed`, `agent_run_failed`, and `agent_run_interrupted` handlers.

- [ ] **Step 5: Run web store tests**

Run:

```bash
pnpm --filter @traceforge/web exec vitest run src/store.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit web store work**

Run:

```bash
git add apps/web/src/store.ts apps/web/src/store.test.ts
git commit -m "feat(web): show agent continuation status"
```

## Task 5: Documentation, Full Verification, And Real LLM Validation

**Files:**
- Modify: `docs/agent-gap-backlog.md`
- Modify: `README.md`
- Modify: `TraceForge_design.md`
- Modify: `docs/superpowers/plans/2026-07-01-dynamic-run-budget.md`

- [ ] **Step 1: Update backlog**

In `docs/agent-gap-backlog.md`, mark the hidden hard-coded max-turn cap item as done or partially done, depending on the current wording. Add this exact note:

```md
- Dynamic run budget is now explicit: the runtime warns near exhaustion and reports `needs_continuation` instead of `completed` when the budget is spent. Remaining work: add a first-class Continue button that starts a follow-up run from the previous trajectory.
```

- [ ] **Step 2: Update README**

Add a short section to `README.md` near the agent/runtime documentation:

```md
### Agent Run Budget

Agent runs use an explicit turn budget. If the model spends the budget before finishing, the run ends with `needs_continuation` instead of `completed`, and clients receive `agent_run_needs_continuation`. The optional `/agent/run` request field `budget` supports `maxTurns` and `warningTurnsRemaining`; omitted values use the runtime default.
```

- [ ] **Step 3: Update design doc**

In `TraceForge_design.md`, update the agent runtime section with:

```md
- Agent runs have an explicit turn budget. Near the budget threshold, the runtime injects a budget notice asking the model to finish, record a blocker, or explain the next step. Budget exhaustion is a non-success terminal state: `needs_continuation`.
```

- [ ] **Step 4: Run focused package tests**

Run:

```bash
pnpm --filter @traceforge/shared exec vitest run src/agent-run.test.ts
pnpm --filter @traceforge/extension exec vitest run src/agent-runtime.test.ts
pnpm --filter @traceforge/server exec vitest run src/agent-runs.test.ts src/routes-agent-run-control.test.ts
pnpm --filter @traceforge/web exec vitest run src/store.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Run full automated verification**

Run the repository's established verification commands. If `package.json` has root scripts, use these:

```bash
pnpm test
pnpm build
```

Expected: all PASS. If the repository does not have one of these root scripts, record the missing script in the Result Log and run the closest workspace-level test/build command that exists.

- [ ] **Step 6: Run real LLM validation**

Use the configured real OpenAI-compatible provider, not a mock provider. Start a server run with a tiny budget:

```bash
curl -s -X POST http://localhost:3000/cases/<existing-case-id>/agent/run ^
  -H "Content-Type: application/json" ^
  -d "{\"goal\":\"Search the available facts, then continue investigating until you need another step.\",\"budget\":{\"maxTurns\":1,\"warningTurnsRemaining\":1}}"
```

Watch the real runtime stream. Acceptable outcomes:

- If the model calls a tool and spends the one-turn budget, record that the stream emitted `budget_warning` and `agent_run_needs_continuation`.
- If the model completes directly within one turn, record that the real LLM completed before exhaustion and the deterministic tests cover exhaustion.

Do not claim a real exhaustion E2E occurred unless the observed stream actually emitted `agent_run_needs_continuation`.

- [ ] **Step 7: Fill Result Log**

Append this section to the bottom of this plan:

```md
## Result Log

- Shared schema tests:
- Runtime budget tests:
- Server continuation tests:
- Web store tests:
- Full test/build:
- Real LLM validation:
- Commits:
```

Fill every bullet with the exact command and observed result.

- [ ] **Step 8: Commit docs and validation record**

Run:

```bash
git add docs/agent-gap-backlog.md README.md TraceForge_design.md docs/superpowers/plans/2026-07-01-dynamic-run-budget.md
git commit -m "docs: record dynamic run budget validation"
```

## Result Log

- Plan authored: pending execution.
