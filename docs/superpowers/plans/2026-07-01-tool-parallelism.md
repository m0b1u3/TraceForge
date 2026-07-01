# Tool Parallelism Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute explicitly read-only tool calls concurrently while keeping mutating, command-risk, and unknown tools serial.

**Architecture:** Add `executionMode?: "parallel" | "serial"` to `ToolDescriptor`. Mark safe built-in read tools as parallel. Update `AgentRuntime` to execute contiguous batches of parallel-safe tool calls with `Promise.all`, but emit and append results in original call order.

**Tech Stack:** TypeScript, Vitest, existing AgentRuntime and ToolRegistry.

---

## File Map

- Modify `packages/extension/src/tool.ts`: add `ToolExecutionMode`.
- Modify `packages/extension/src/case-tools.ts`: mark `list_traffic` and `get_traffic` parallel; leave record/update tools serial.
- Modify `packages/extension/src/memory-tools.ts`: mark search/detail/recall tools parallel.
- Modify `packages/extension/src/browser-tools.ts`: mark `extract_links` and `get_page_text` parallel; keep navigation/click/fill serial.
- Modify `packages/extension/src/agent-runtime.ts`: add batching and parallel-safe classification.
- Modify `packages/extension/src/agent-runtime.test.ts`: TDD for parallel execution, ordered results, serial fallback, command-risk override, parallel tool error recovery.
- Modify `docs/agent-gap-backlog.md`, `README.md`, `TraceForge_design.md`, and this plan after verification.

---

## Task 1: Tool Execution Metadata

**Files:**
- Modify: `packages/extension/src/tool.ts`
- Modify: `packages/extension/src/case-tools.ts`
- Modify: `packages/extension/src/memory-tools.ts`
- Modify: `packages/extension/src/browser-tools.ts`

- [ ] **Step 1: Write failing metadata assertions**

Add assertions to existing tool tests:

- In `packages/extension/src/case-tools.test.ts`, assert `makeListTrafficTool(...).executionMode === "parallel"` and `makeGetTrafficTool(...).executionMode === "parallel"`.
- In `packages/extension/src/memory-tools.test.ts`, assert `search_facts`, `get_fact_detail`, `search_traffic`, and `recall_conversation` return descriptors with `executionMode === "parallel"`.
- In `packages/extension/src/browser-tools.test.ts`, assert `extract_links` and `get_page_text` are parallel, while `navigate`, `click`, and `fill` are not parallel.

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
node_modules\.bin\vitest.cmd run packages/extension/src/case-tools.test.ts packages/extension/src/memory-tools.test.ts packages/extension/src/browser-tools.test.ts
```

Expected: FAIL because `executionMode` is missing.

- [ ] **Step 3: Add type and mark safe tools**

In `packages/extension/src/tool.ts`:

```ts
export type ToolExecutionMode = "parallel" | "serial";
```

Add optional field:

```ts
executionMode?: ToolExecutionMode;
```

Set `executionMode: "parallel"` on:

- `list_traffic`
- `get_traffic`
- `search_facts`
- `get_fact_detail`
- `search_traffic`
- `recall_conversation`
- `extract_links`
- `get_page_text`

Do not set the field on serial tools.

- [ ] **Step 4: Run tests to verify GREEN**

Run:

```bash
node_modules\.bin\vitest.cmd run packages/extension/src/case-tools.test.ts packages/extension/src/memory-tools.test.ts packages/extension/src/browser-tools.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/tool.ts packages/extension/src/case-tools.ts packages/extension/src/memory-tools.ts packages/extension/src/browser-tools.ts packages/extension/src/case-tools.test.ts packages/extension/src/memory-tools.test.ts packages/extension/src/browser-tools.test.ts
git commit -m "feat(tools): mark read-only tools parallel safe"
```

---

## Task 2: AgentRuntime Parallel Batching

**Files:**
- Modify: `packages/extension/src/agent-runtime.ts`
- Modify: `packages/extension/src/agent-runtime.test.ts`

- [ ] **Step 1: Write failing runtime tests**

Add tests to `packages/extension/src/agent-runtime.test.ts`:

1. **Parallel calls run concurrently**

Two parallel tools each wait 50ms. Measure elapsed time. Expected elapsed is below 90ms and both results appear.

2. **Results are emitted in original order**

Tool A waits 40ms and returns `A`; Tool B waits 5ms and returns `B`. Expected `tool_result:A` appears before `tool_result:B`.

3. **Serial tools still run one by one**

Two tools without `executionMode` each wait 30ms. Expected elapsed is at least 55ms.

4. **Command-risk tools are serial even if marked parallel**

Two command-risk tools with `executionMode: "parallel"` each wait 30ms. Expected elapsed is at least 55ms and ApprovalGate is checked for both.

5. **Parallel tool error is returned in order**

A parallel tool throws and another returns ok. Expected ordered results include `[tool_error]`.

- [ ] **Step 2: Run runtime tests to verify RED**

Run:

```bash
node_modules\.bin\vitest.cmd run packages/extension/src/agent-runtime.test.ts
```

Expected: FAIL because runtime still executes all tools serially and emits results as each tool finishes.

- [ ] **Step 3: Implement batching**

In `AgentRuntime`, replace direct `for (const call of turn.toolCalls)` execution with a batching helper:

```ts
for (const batch of this.groupToolCalls(turn.toolCalls)) {
  if (this.interrupted(options)) {
    this.emitInterrupted(onEvent);
    return;
  }
  const results = batch.parallel
    ? await Promise.all(batch.calls.map((call) => this.runOneTool(call, onEvent, { deferResultEvent: true })))
    : [await this.runOneTool(batch.calls[0], onEvent, { deferResultEvent: true })];

  for (let i = 0; i < batch.calls.length; i++) {
    const call = batch.calls[i];
    const result = results[i];
    onEvent({ type: "tool_result", name: call.name, content: result });
    messages.push({ role: "tool", content: result, toolCallId: call.id });
  }
}
```

Adjust `runOneTool` so it can emit `tool_call` immediately but defer `tool_result` until the ordered flush:

```ts
private async runOneTool(call: ToolCall, onEvent: ..., opts: { deferResultEvent?: boolean } = {}): Promise<string>
```

Add:

```ts
private isParallelSafe(call: ToolCall): boolean {
  const tool = this.registry.get(call.name);
  return tool?.risk !== "command" && tool?.executionMode === "parallel";
}
```

Group only contiguous parallel-safe calls. Unknown tools are serial.

- [ ] **Step 4: Run runtime tests to verify GREEN**

Run:

```bash
node_modules\.bin\vitest.cmd run packages/extension/src/agent-runtime.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/agent-runtime.ts packages/extension/src/agent-runtime.test.ts
git commit -m "feat(agent): run read-only tools in parallel"
```

---

## Task 3: Verification and Real LLM E2E

**Files:**
- Modify: `docs/agent-gap-backlog.md`
- Modify: `README.md`
- Modify: `TraceForge_design.md`
- Modify: `docs/superpowers/plans/2026-07-01-tool-parallelism.md`

- [ ] **Step 1: Run focused tests**

Run:

```bash
node_modules\.bin\vitest.cmd run packages/extension/src/agent-runtime.test.ts packages/extension/src/case-tools.test.ts packages/extension/src/memory-tools.test.ts packages/extension/src/browser-tools.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run full tests**

Run:

```bash
pnpm test
```

Expected: PASS.

- [ ] **Step 3: Run build**

Run:

```bash
pnpm -r build
```

Expected: PASS. Existing Vite warnings about `undici` browser externalization and large chunks may remain.

- [ ] **Step 4: Run real OpenAI-compatible E2E**

Use current `config/llm.json` and `.env`. Do not print API keys.

Expected:

- provider is `openai`.
- model is `deepseek-v4-flash`.
- provider exposes native `streamTools`.
- `/agent/run` returns a run id quickly.
- stream deltas arrive.
- final text includes `TOOL_PARALLELISM_E2E_OK`.
- no `agent_error`.

- [ ] **Step 5: Update docs**

Update:

- `docs/agent-gap-backlog.md`: mark #3 complete.
- `README.md`: add Tool Parallelism to current progress.
- `TraceForge_design.md`: add current-route item for Tool Parallelism.
- this plan: append `## Result Log` with focused tests, full tests, build, and real LLM E2E.

- [ ] **Step 6: Commit**

```bash
git add docs/agent-gap-backlog.md README.md TraceForge_design.md docs/superpowers/plans/2026-07-01-tool-parallelism.md
git commit -m "docs: record tool parallelism validation"
```

---

## Result Log

- Tool metadata RED: `node_modules\.bin\vitest.cmd run packages/extension/src/case-tools.test.ts packages/extension/src/memory-tools.test.ts packages/extension/src/browser-tools.test.ts` failed before `executionMode` existed, as expected.
- Tool metadata GREEN: same command passed after marking explicitly read-only tools parallel-safe.
- Runtime batching RED: `node_modules\.bin\vitest.cmd run packages/extension/src/agent-runtime.test.ts` failed the concurrency timing assertion while all tool calls were still serial.
- Runtime batching GREEN: same command passed after adding contiguous parallel-safe batching and ordered result flushing.
- Focused verification: `node_modules\.bin\vitest.cmd run packages/extension/src/agent-runtime.test.ts packages/extension/src/case-tools.test.ts packages/extension/src/memory-tools.test.ts packages/extension/src/browser-tools.test.ts` passed 4 files / 32 tests.
- Full verification: `pnpm test` passed 66 files / 267 tests.
- Build verification: `pnpm -r build` passed. Existing Vite warnings about `undici` browser externalization and large chunks remain.
- Real OpenAI-compatible E2E: used current `config/llm.json` and `.env` without printing API keys. Provider `openai`, model `deepseek-v4-flash`, baseUrl `https://api.deepseek.com`, native `streamTools=true`. `/agent/run` returned `run_0fa2d2cd-522c-4759-87b7-ddc0c6358440` in 5ms; terminal event was `agent_run_completed`; stream events were start=1, delta=28, end=1; final text included `TOOL_PARALLELISM_E2E_OK`; `agent_error` count was 0. This real LLM run verifies no streaming regression after batching. Deterministic multi-tool concurrency behavior is covered by the unit tests above.
