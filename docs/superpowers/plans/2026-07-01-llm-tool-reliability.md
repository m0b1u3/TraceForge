# LLM + Tool Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add transient LLM retry, interrupt-safe retry cancellation, and tool error recovery for Agent Run.

**Architecture:** Retry is implemented once in `packages/llm` and used by OpenAI-compatible and Anthropic providers. AgentRuntime converts tool exceptions into normal tool results and emits retry events upward. The server maps retry events to websocket events and the web store renders them as lightweight agent status rows.

**Tech Stack:** TypeScript, Vitest, Fastify inject tests, Zustand store tests, existing LLM providers.

---

## File Map

- Create `packages/llm/src/retry.ts`: retry policy, retryable error classifier, interrupt-aware sleep, `withRetry`.
- Create `packages/llm/src/retry.test.ts`: TDD coverage for retry success, max attempts, non-retryable status, abort behavior.
- Modify `packages/extension/src/provider.ts`: add optional `onRetry` callback to `RunToolsArgs` and `StreamToolsHandlers`.
- Modify `packages/extension/src/agent-runtime.ts`: emit `retrying`; pass retry callbacks into providers; catch tool execution exceptions as `[tool_error]`.
- Modify `packages/extension/src/agent-runtime.test.ts`: tests for retry event pass-through and tool error result.
- Modify `packages/llm/src/openai-provider.ts`: wrap `extractJson`, `runTools`, `streamTools` in `withRetry`.
- Modify `packages/llm/src/anthropic-provider.ts`: wrap `extractJson`, `runTools` in `withRetry`.
- Modify `packages/llm/src/index.ts`: export retry helper types only if needed by tests.
- Modify `packages/shared/src/events.ts`: add `agent_retrying` runtime event.
- Modify `apps/server/src/routes.ts`: map runtime `retrying` to `agent_retrying`.
- Modify `apps/server/src/routes-agent-run-control.test.ts`: verify retry event websocket bus mapping through injected provider.
- Modify `apps/web/src/store.ts`: render `agent_retrying`.
- Modify `apps/web/src/store.test.ts`: verify retry event adds status row.
- Modify `docs/agent-gap-backlog.md`: mark #1/#2 complete, #4 in progress or complete after verification.
- Modify `docs/superpowers/plans/2026-07-01-llm-tool-reliability.md`: record real LLM validation results after execution.

---

## Task 1: Retry Helper

**Files:**
- Create: `packages/llm/src/retry.ts`
- Create: `packages/llm/src/retry.test.ts`

- [ ] **Step 1: Write failing retry tests**

Create `packages/llm/src/retry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isRetryableError, withRetry } from "./retry.js";

describe("withRetry", () => {
  it("retries transient failures and returns the successful result", async () => {
    let attempts = 0;
    const result = await withRetry("unit", async () => {
      attempts += 1;
      if (attempts < 3) {
        const err = new Error("temporarily unavailable") as Error & { status?: number };
        err.status = 503;
        throw err;
      }
      return "ok";
    }, { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 });

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("stops after max attempts and rethrows the final error", async () => {
    let attempts = 0;
    await expect(withRetry("unit", async () => {
      attempts += 1;
      const err = new Error("rate limited") as Error & { status?: number };
      err.status = 429;
      throw err;
    }, { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 })).rejects.toThrow("rate limited");

    expect(attempts).toBe(2);
  });

  it("does not retry non-retryable client failures", async () => {
    let attempts = 0;
    await expect(withRetry("unit", async () => {
      attempts += 1;
      const err = new Error("bad request") as Error & { status?: number };
      err.status = 400;
      throw err;
    }, { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 })).rejects.toThrow("bad request");

    expect(attempts).toBe(1);
  });

  it("does not retry aborted operations", async () => {
    const controller = new AbortController();
    controller.abort();
    let attempts = 0;

    await expect(withRetry("unit", async () => {
      attempts += 1;
      throw new DOMException("aborted", "AbortError");
    }, { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, signal: controller.signal })).rejects.toThrow("aborted");

    expect(attempts).toBe(0);
  });
});

describe("isRetryableError", () => {
  it("classifies retryable HTTP and network failures", () => {
    expect(isRetryableError(Object.assign(new Error("fetch failed"), { status: 503 }))).toBe(true);
    expect(isRetryableError(Object.assign(new Error("bad auth"), { status: 401 }))).toBe(false);
    expect(isRetryableError(new Error("ECONNRESET while reading"))).toBe(true);
    expect(isRetryableError(new SyntaxError("Unexpected token"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify RED**

Run:

```bash
node_modules\.bin\vitest.cmd run packages/llm/src/retry.test.ts
```

Expected: FAIL because `packages/llm/src/retry.ts` does not exist.

- [ ] **Step 3: Implement retry helper**

Create `packages/llm/src/retry.ts`:

```ts
export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  signal?: AbortSignal;
  onRetry?: (event: RetryNotice) => void;
}

export interface RetryNotice {
  label: string;
  attempt: number;
  maxAttempts: number;
  reason: string;
}

export const DEFAULT_RETRY_POLICY: Omit<RetryPolicy, "signal" | "onRetry"> = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 2000,
};

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const NETWORK_PATTERNS = [
  "fetch failed",
  "econnreset",
  "etimedout",
  "enotfound",
  "econnrefused",
  "socket hang up",
  "network",
];

export function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  const maybe = error as { name?: unknown; code?: unknown; message?: unknown };
  return maybe.name === "AbortError" || maybe.code === "ABORT_ERR" || String(maybe.message ?? "").toLowerCase().includes("aborted");
}

export function isRetryableError(error: unknown): boolean {
  if (isAbortError(error)) return false;
  if (error instanceof SyntaxError) return false;
  const maybe = error as { status?: unknown; statusCode?: unknown; code?: unknown; message?: unknown };
  const status = typeof maybe.status === "number" ? maybe.status : typeof maybe.statusCode === "number" ? maybe.statusCode : undefined;
  if (status !== undefined) return RETRYABLE_STATUS.has(status);
  const message = String(maybe.message ?? maybe.code ?? "").toLowerCase();
  return NETWORK_PATTERNS.some((pattern) => message.includes(pattern));
}

export async function withRetry<T>(
  label: string,
  operation: () => Promise<T>,
  policy: Partial<RetryPolicy> = {},
): Promise<T> {
  const merged: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...policy };
  if (merged.signal?.aborted) throw new DOMException("aborted", "AbortError");

  let lastError: unknown;
  for (let attempt = 1; attempt <= merged.maxAttempts; attempt++) {
    if (merged.signal?.aborted) throw new DOMException("aborted", "AbortError");
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (merged.signal?.aborted || !isRetryableError(error) || attempt >= merged.maxAttempts) throw error;
      merged.onRetry?.({ label, attempt: attempt + 1, maxAttempts: merged.maxAttempts, reason: errorReason(error) });
      await sleep(delayFor(attempt, merged), merged.signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function delayFor(failedAttempt: number, policy: RetryPolicy): number {
  return Math.min(policy.baseDelayMs * 2 ** Math.max(0, failedAttempt - 1), policy.maxDelayMs);
}

function errorReason(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}
```

- [ ] **Step 4: Run test to verify GREEN**

Run:

```bash
node_modules\.bin\vitest.cmd run packages/llm/src/retry.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/llm/src/retry.ts packages/llm/src/retry.test.ts
git commit -m "feat(llm): add interrupt-aware retry helper"
```

---

## Task 2: Provider Retry Integration

**Files:**
- Modify: `packages/extension/src/provider.ts`
- Modify: `packages/llm/src/openai-provider.ts`
- Modify: `packages/llm/src/anthropic-provider.ts`
- Create: `packages/llm/src/provider-retry.test.ts`

- [ ] **Step 1: Write failing provider retry test**

Create `packages/llm/src/provider-retry.test.ts`. Instantiate `OpenAICompatibleProvider`, replace its runtime `client.chat.completions.create` function through `(provider as unknown as { client: ... }).client`, then call `runTools`.

Use this test body:

```ts
import { describe, expect, it } from "vitest";
import { OpenAICompatibleProvider } from "./openai-provider.js";

describe("OpenAICompatibleProvider retry integration", () => {
  it("retries transient runTools failures and reports retry notices", async () => {
    const provider = new OpenAICompatibleProvider({ apiKey: "test", model: "m", baseUrl: "https://example.invalid" });
    const holder = provider as unknown as {
      client: { chat: { completions: { create: (args: unknown) => Promise<unknown> } } };
    };
    let attempts = 0;
    holder.client.chat.completions.create = async () => {
      attempts += 1;
      if (attempts === 1) {
        const err = new Error("rate limited") as Error & { status?: number };
        err.status = 429;
        throw err;
      }
      return { choices: [{ message: { content: "ok", tool_calls: [] }, finish_reason: "stop" }] };
    };

    const notices: Array<{ attempt: number; maxAttempts: number; reason: string }> = [];
    const result = await provider.runTools({
      system: "sys",
      messages: [{ role: "user", content: "go" }],
      tools: [],
      onRetry: (notice) => notices.push(notice),
    });

    expect(result.text).toBe("ok");
    expect(attempts).toBe(2);
    expect(notices).toEqual([{ attempt: 2, maxAttempts: 3, reason: "rate limited" }]);
  });
});
```

- [ ] **Step 2: Run provider retry test to verify RED**

Run:

```bash
node_modules\.bin\vitest.cmd run packages/llm/src/provider-retry.test.ts
```

Expected: FAIL because callback wiring is missing.

- [ ] **Step 3: Extend provider types**

Modify `packages/extension/src/provider.ts` so `RunToolsArgs` includes:

```ts
onRetry?: (event: { attempt: number; maxAttempts: number; reason: string }) => void;
```

Modify `StreamToolsHandlers` so it includes the same `onRetry` callback.

- [ ] **Step 4: Wrap provider API calls**

In `packages/llm/src/openai-provider.ts`, import `withRetry` and wrap:

- `extractJson`: `withRetry("openai.extractJson", () => this.client.chat.completions.create(...))`
- `runTools`: `withRetry("openai.runTools", () => this.client.chat.completions.create(...), { onRetry: args.onRetry })`
- `streamTools`: wrap creation and iteration in one `withRetry("openai.streamTools", async () => { ... }, { signal: handlers.signal, onRetry: handlers.onRetry })`

In `packages/llm/src/anthropic-provider.ts`, wrap:

- `extractJson`: `withRetry("anthropic.extractJson", () => this.client.messages.create(...))`
- `runTools`: `withRetry("anthropic.runTools", () => this.client.messages.create(...), { onRetry: args.onRetry })`

- [ ] **Step 5: Run focused provider tests**

Run:

```bash
node_modules\.bin\vitest.cmd run packages/llm/src/retry.test.ts packages/llm/src/openai-stream-parse.test.ts packages/llm/src/config.test.ts packages/llm/src/factory.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/extension/src/provider.ts packages/llm/src/openai-provider.ts packages/llm/src/anthropic-provider.ts packages/llm/src/provider-retry.test.ts
git commit -m "feat(llm): retry transient provider failures"
```

---

## Task 3: Runtime Retry Events and Tool Error Recovery

**Files:**
- Modify: `packages/extension/src/agent-runtime.ts`
- Modify: `packages/extension/src/agent-runtime.test.ts`

- [ ] **Step 1: Write failing runtime tests**

Add tests:

```ts
it("emits retrying events from provider retry callbacks", async () => {
  const provider = {
    runTools: async (args) => {
      args.onRetry?.({ attempt: 2, maxAttempts: 3, reason: "rate limited" });
      return { text: "ok", toolCalls: [], done: true };
    },
  };
  const events: string[] = [];
  await new AgentRuntime(provider, new ToolRegistry(), new ApprovalGate(async () => "approved"))
    .run("sys", "go", (e) => events.push(`${e.type}:${e.content}`));
  expect(events).toContain("retrying:rate limited");
});

it("returns tool execution exceptions to the LLM as tool_result", async () => {
  const provider = new SeqProvider([
    { text: "", toolCalls: [{ id: "t1", name: "boom", input: {} }], done: false },
    { text: "handled", toolCalls: [], done: true },
  ]);
  const registry = new ToolRegistry();
  registry.register({ name: "boom", description: "boom", input_schema: {}, risk: "normal", execute: async () => { throw new Error("tool exploded"); } });
  const events: string[] = [];
  await new AgentRuntime(provider, registry, autoGate).run("sys", "go", (e) => events.push(`${e.type}:${e.content}`));
  expect(events).toContain("tool_result:[tool_error] boom: tool exploded");
  expect(events).toContain("done:handled");
});
```

- [ ] **Step 2: Run runtime tests to verify RED**

Run:

```bash
node_modules\.bin\vitest.cmd run packages/extension/src/agent-runtime.test.ts
```

Expected: FAIL because `retrying` event type and tool catch are missing.

- [ ] **Step 3: Implement runtime changes**

Update `AgentEvent.type` union to include `"retrying"` and add `attempt?: number; maxAttempts?: number`.

Pass `onRetry` into provider calls:

```ts
onRetry: (event) => onEvent({
  type: "retrying",
  content: event.reason,
  attempt: event.attempt,
  maxAttempts: event.maxAttempts,
})
```

Wrap `tool.execute`:

```ts
try {
  const res = await tool.execute(call.input);
  onEvent({ type: "tool_result", name: call.name, content: res.content });
  return res.content;
} catch (error) {
  const content = `[tool_error] ${call.name}: ${(error as Error).message}`;
  onEvent({ type: "tool_result", name: call.name, content });
  return content;
}
```

- [ ] **Step 4: Run runtime tests to verify GREEN**

Run:

```bash
node_modules\.bin\vitest.cmd run packages/extension/src/agent-runtime.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/agent-runtime.ts packages/extension/src/agent-runtime.test.ts
git commit -m "feat(agent): surface retries and recover tool errors"
```

---

## Task 4: Server and Web Retry Event Wiring

**Files:**
- Modify: `packages/shared/src/events.ts`
- Modify: `apps/server/src/routes.ts`
- Modify: `apps/server/src/routes-agent-run-control.test.ts`
- Modify: `apps/web/src/store.ts`
- Modify: `apps/web/src/store.test.ts`

- [ ] **Step 1: Write failing server/web tests**

Add a server route test using an injected provider that calls `args.onRetry`. Subscribe to `EventBus`, run the agent, wait for completion, and assert an event:

```ts
expect(events.some((e) => e.type === "agent_retrying" && e.attempt === 2)).toBe(true);
```

Add a web store test:

```ts
useStore.getState().handleRuntimeEvent({
  type: "agent_retrying",
  caseId: "c1",
  runId: "r1",
  attempt: 2,
  maxAttempts: 3,
  reason: "rate limited",
});
expect(useStore.getState().agentEvents.at(-1)).toEqual({ kind: "text", text: "正在重试 LLM 调用 2/3：rate limited" });
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
node_modules\.bin\vitest.cmd run apps/server/src/routes-agent-run-control.test.ts apps/web/src/store.test.ts
```

Expected: FAIL because `agent_retrying` is not in shared event union or handlers.

- [ ] **Step 3: Add shared event and mappings**

Add to `RuntimeEvent`:

```ts
| { type: "agent_retrying"; caseId: string; runId: string; attempt: number; maxAttempts: number; reason: string }
```

In `routes.ts`, map runtime event:

```ts
else if (e.type === "retrying") bus.emit({
  type: "agent_retrying",
  caseId: id,
  runId,
  attempt: e.attempt ?? 1,
  maxAttempts: e.maxAttempts ?? 1,
  reason: e.content,
});
```

In `store.ts`, render:

```ts
else if (event.type === "agent_retrying" && event.caseId === cid) {
  get().addAgentEvent({ kind: "text", text: `正在重试 LLM 调用 ${event.attempt}/${event.maxAttempts}：${event.reason}` });
}
```

- [ ] **Step 4: Run tests to verify GREEN**

Run:

```bash
node_modules\.bin\vitest.cmd run apps/server/src/routes-agent-run-control.test.ts apps/web/src/store.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/events.ts apps/server/src/routes.ts apps/server/src/routes-agent-run-control.test.ts apps/web/src/store.ts apps/web/src/store.test.ts
git commit -m "feat(app): show agent retry events"
```

---

## Task 5: Verification, Real LLM E2E, and Docs

**Files:**
- Modify: `docs/agent-gap-backlog.md`
- Modify: `docs/superpowers/plans/2026-07-01-llm-tool-reliability.md`

- [ ] **Step 1: Run focused tests**

Run:

```bash
node_modules\.bin\vitest.cmd run packages/llm/src/retry.test.ts packages/extension/src/agent-runtime.test.ts apps/server/src/routes-agent-run-control.test.ts apps/web/src/store.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run full test suite**

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

Expected: PASS. Existing Vite warnings about `undici` browser externalization and chunk size may remain.

- [ ] **Step 4: Run real OpenAI-compatible streaming E2E**

Use current `config/llm.json` and `.env`. Do not print API keys.

Expected:

- provider is `openai`.
- model is `deepseek-v4-flash`.
- provider exposes `streamTools`.
- `/agent/run` returns a run id quickly.
- more than one `agent_stream_delta` event arrives.
- final text includes a marker such as `RELIABILITY_STREAM_OK`.
- no `agent_error`.

- [ ] **Step 5: Run real interrupt E2E**

Start a real LLM run and immediately call interrupt.

Expected:

- interrupt route returns status `interrupting`.
- terminal event is `agent_run_interrupted`.
- active run is `null`.
- no later completion event for the same run.

- [ ] **Step 6: Update docs**

Update `docs/agent-gap-backlog.md`:

- mark #1 and #2 complete.
- mark #4 complete if verification passes.

Append verification results to this plan under a `## Result Log` section.

- [ ] **Step 7: Commit**

```bash
git add docs/agent-gap-backlog.md docs/superpowers/plans/2026-07-01-llm-tool-reliability.md
git commit -m "docs: record llm reliability validation"
```
