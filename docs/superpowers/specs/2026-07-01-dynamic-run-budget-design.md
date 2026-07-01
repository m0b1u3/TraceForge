# Dynamic Run Budget Design

## 1. Goal

Replace the current hard-coded `MAX_TURNS = 25` stop in `AgentRuntime` with an explicit run budget model and a non-success terminal state for runs that need more user-approved continuation.

Today, when `AgentRuntime` exhausts 25 turns, it emits:

```text
done: max turns reached
```

The server then marks the run as `completed`, which hides the difference between:

- the agent finished the task;
- the user interrupted the run;
- the provider/tool failed;
- the run hit a protective budget and still has reasonable next steps.

This iteration makes budget exhaustion visible and recoverable without allowing unbounded loops.

## 2. Non-Goals

- Do not remove all runtime limits.
- Do not implement sub-agents or task decomposition.
- Do not implement token/cost accounting.
- Do not replace the current chars-based token estimator.
- Do not build a full continuation UI flow beyond a minimal status/event surface.
- Do not ask LLM to decide whether it may run forever.

## 3. Terminology

**Turn:** One LLM provider call plus any tool calls returned by that provider turn.

**Run budget:** A deterministic guardrail that limits how many turns a single background agent run may consume.

**Continuation:** A new user-approved run using the existing conversation history and case memory. This iteration only exposes the status and reason needed for continuation; the current `/agent/run` route can already start a new run after the prior one is terminal.

## 4. Architecture

### 4.1 AgentRuntime Budget

Add a budget object to `AgentRunOptions`:

```ts
export interface AgentRunBudget {
  maxTurns: number;
  warningTurnsRemaining: number;
}

export interface AgentRunOptions {
  signal?: AbortSignal;
  runId?: string;
  getSteeringMessages?: () => string[];
  budget?: AgentRunBudget;
}
```

Default behavior:

```ts
const DEFAULT_RUN_BUDGET = {
  maxTurns: 25,
  warningTurnsRemaining: 3,
};
```

This preserves the current protective limit while making it explicit and testable.

### 4.2 Runtime Events

Extend `AgentEvent.type` with:

```ts
| "budget_warning"
| "budget_exhausted"
```

Event content examples:

```text
budget_warning: 3 turns remaining
budget_exhausted: run budget exhausted after 25 turns
```

`budget_warning` fires once when the remaining turn count first reaches the configured threshold. It is for UI/debug visibility.

`budget_exhausted` fires when the runtime exits because the budget is exhausted. It replaces the current `done: "max turns reached"` behavior.

### 4.3 Near-Budget Prompting

When the runtime enters the warning window, append one user-style control message before the next provider call:

```text
[Run budget notice]
本次运行即将到达预算上限。请优先判断：
1. 如果任务已经完成，直接总结并结束。
2. 如果任务未完成但有明确下一步，请说明下一步和为什么需要继续。
3. 如果缺少证据、权限、输入或外部条件，请记录 blocked task 或明确说明阻塞原因。
不要为了消耗轮次而继续调用无关工具。
```

This is not a semantic rule engine. It is a lightweight steering hint that gives the LLM a chance to finish cleanly before the deterministic budget guard stops the run.

The notice should be injected once per run, not on every remaining turn.

### 4.4 AgentRun Status

Extend `AgentRunStatusSchema` with:

```ts
"needs_continuation"
```

This status is terminal. A case with a run in `needs_continuation` may start another `/agent/run`, the same as `completed`, `failed`, or `interrupted`.

The existing `AgentRun.error` field should not be used for this case. Add:

```ts
completionReason: string | null
```

Reason examples:

```text
completed normally
interrupted by user
failed: provider error
budget exhausted after 25 turns
```

This iteration must add `completionReason` directly. Do not overload `error` or `interruptReason` for budget exhaustion, because the UI and tests need to distinguish failure, interruption, normal completion, and continuation.

### 4.5 Server Mapping

Current server logic treats any non-interrupted return from `AgentRuntime.run` as completed:

```ts
if (afterRun && afterRun.status !== "interrupted") {
  const completed = runs.complete(runId);
  ...
}
```

Change this so the runtime event callback records the terminal runtime outcome:

- `done` -> `runs.complete(runId, reason)`
- `budget_exhausted` -> `runs.needsContinuation(runId, reason)`
- `interrupted` -> `runs.markInterrupted(runId, reason)`
- thrown error -> `runs.fail(runId, error)`

Then the post-run block should not blindly complete the run if it was already moved to `needs_continuation`.

Add runtime event:

```ts
| { type: "agent_run_needs_continuation"; run: AgentRun; reason: string }
```

The event lets the web app show a clear status without parsing `agent_done` text.

### 4.6 Frontend Minimal Handling

The first UI iteration only needs to:

- mark agent busy false on `agent_run_needs_continuation`;
- append a done-style message such as:

```text
Agent 已到达本次运行预算，需要继续运行。
```

No new button is required in this iteration. The user can already send another goal/message to start a new run. A dedicated "继续运行" button can be a later UI pass.

## 5. Data Flow

```text
User starts run
  -> AgentRunRegistry.start(status=running)
  -> AgentRuntime.run(..., budget={maxTurns:25, warningTurnsRemaining:3})
  -> before warning turn: emit budget_warning and inject budget notice
  -> if LLM finishes: emit done
      -> server marks completed
  -> if budget exhausts first: emit budget_exhausted
      -> server marks needs_continuation
      -> event bus emits agent_run_needs_continuation
      -> web UI clears busy and shows continuation status
```

## 6. Error Handling

- `maxTurns <= 0`: normalize to default budget.
- `warningTurnsRemaining < 0`: normalize to `0`.
- `warningTurnsRemaining >= maxTurns`: warning should fire before the first turn.
- Interrupt still wins over budget. If the abort signal is active, emit `interrupted`, not `budget_exhausted`.
- Provider/tool exceptions still become tool errors or failed runs according to existing reliability behavior.
- A rejected command-risk tool is not a budget failure; the LLM still receives the rejection result and may decide what to do.

## 7. Testing Strategy

### Unit Tests

`packages/extension/src/agent-runtime.test.ts`:

- custom budget `maxTurns: 2` emits `budget_exhausted` instead of `done: max turns reached`;
- warning fires once when remaining turns reaches threshold;
- warning notice is injected into provider messages before exhaustion;
- normal done before budget still emits `done` and no `budget_exhausted`;
- interrupt before next turn still emits `interrupted`, not `budget_exhausted`.

`apps/server/src/agent-runs.test.ts`:

- `needsContinuation(runId, reason)` marks terminal status and clears active case run;
- a new run can start after `needs_continuation`.

`packages/shared/src/agent-run.test.ts`:

- `AgentRunSchema` accepts `needs_continuation`;
- `completionReason` is nullable and accepted.

`apps/web/src/store.test.ts`:

- `agent_run_needs_continuation` clears busy and appends a visible status message.

### Integration Tests

`apps/server/src/routes-agent-run-control.test.ts`:

- provider that always requests a tool can exhaust a tiny budget;
- server emits `agent_run_needs_continuation`;
- active run becomes null;
- server does not emit `agent_run_completed` for that run.

### Real LLM E2E

Use the configured real OpenAI-compatible LLM.

Scenario:

1. Configure a very small budget for a test-only route path or exported runtime test harness.
2. Give the agent a goal that asks it to inspect several things and call tools.
3. Verify stream events still work.
4. Verify budget warning/exhaustion events are emitted if the task exceeds the budget.
5. Verify the run status is `needs_continuation`, not `completed`.

If the real model finishes before the budget, that validates the warning notice path but not exhaustion. For the exhaustion path, use deterministic provider integration tests; do not claim real LLM exhaustion unless the real run actually exhausts.

## 8. Rollout

Phase 1:

- Add runtime budget events and options.
- Add `needs_continuation` status.
- Map server runtime outcomes correctly.
- Add minimal web store handling.
- Update docs and backlog.

Phase 2:

- Add "continue run" UI button that pre-fills or submits a continuation prompt.
- Add configurable budget in server config or request body.
- Add token/cost budget after true tokenizer and usage tracking exist.

## 9. Acceptance Criteria

- `MAX_TURNS` is no longer a hidden hard-coded behavior; the default is expressed as `DEFAULT_RUN_BUDGET`.
- Budget exhaustion emits `budget_exhausted`.
- Budget exhaustion marks the run as `needs_continuation`.
- Budget exhaustion does not emit `agent_run_completed`.
- Existing completed, interrupted, failed, streaming, steering, retrying, and tool parallelism behavior still passes tests.
- The web store clears busy state on `agent_run_needs_continuation`.
- Full test suite and build pass.
- Real LLM validation is recorded without overstating what was tested.
