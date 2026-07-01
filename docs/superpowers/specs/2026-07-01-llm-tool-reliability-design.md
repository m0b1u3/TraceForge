# LLM + Tool Reliability Design

## Goal

Make agent runs resilient to transient LLM/API failures and recoverable tool failures without weakening interrupt behavior or moving security decisions into code.

## Scope

This phase covers three reliability gaps:

1. Retry transient LLM failures for `runTools`, `streamTools`, and `extractJson`.
2. Preserve user interrupt semantics: an aborted run must not retry or continue after Stop.
3. Convert tool execution exceptions into structured `tool_result` messages so the LLM can decide the next step.

This phase does not implement tool parallelism, dynamic turn limits, token/cost tracking, vector search, or persistent crash recovery.

## Architecture

Retry lives in `packages/llm`, close to provider API calls. A small helper classifies retryable failures and runs an async operation with bounded exponential backoff. Providers use the helper around outbound LLM requests. The helper accepts an `AbortSignal` and must exit immediately on abort.

Tool error recovery lives in `packages/extension/src/agent-runtime.ts`. Tool execution errors become normal tool results prefixed with a machine-readable marker. The runtime still emits `tool_result`, then appends the result to the conversation. The LLM remains responsible for deciding whether to retry a tool, choose another tool, record a blocked task, or stop.

Retry visibility uses one new runtime event:

```ts
type RetryEvent = {
  type: "retrying";
  name?: string;
  content: string;
  attempt: number;
  maxAttempts: number;
};
```

The server maps this to a shared websocket event:

```ts
{ type: "agent_retrying"; caseId: string; runId: string; attempt: number; maxAttempts: number; reason: string }
```

The web store displays it as a lightweight agent text/event row. No new complex run status is required in this phase.

## Retry Policy

Default policy:

- `maxAttempts`: 3 total attempts, meaning initial try plus 2 retries.
- `baseDelayMs`: 250.
- `maxDelayMs`: 2000.
- retryable errors:
  - HTTP status `408`, `409`, `425`, `429`, `500`, `502`, `503`, `504`.
  - network failures whose message includes `fetch failed`, `ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`, `ECONNREFUSED`, `socket hang up`, or `network`.
- non-retryable errors:
  - aborts and user interrupts.
  - schema/JSON parse failures.
  - validation failures.
  - HTTP `400`, `401`, `403`, `404`.

Delays are skipped in tests by passing a zero-delay policy.

## Interrupt Semantics

Abort must win over retry. If a signal is already aborted before a provider call, the provider throws immediately. If a signal aborts while waiting for retry delay or while streaming, retry stops and the runtime produces an interrupted run. A stopped run must not later become completed or failed.

## Tool Error Result Format

When a tool throws, the runtime returns:

```text
[tool_error] <tool_name>: <message>
```

The runtime also emits:

```ts
{ type: "tool_result", name: toolName, content: "[tool_error] ..." }
```

This keeps existing tool-call protocol intact. The LLM sees the error as tool output and can make the next reasoning decision. This is intentionally not a TypeScript rule saying what strategy to choose.

## Testing

Unit tests prove:

- retry succeeds after transient failures.
- retry stops after max attempts.
- abort errors are not retried.
- provider stream retry emits retry events before a successful stream.
- tool execution exceptions become `tool_result` and do not fail the whole runtime.

End-to-end validation must use the configured real LLM:

- OpenAI-compatible `deepseek-v4-flash` still emits native stream deltas.
- Stop/interrupt still clears active run and is not revived by retry.

Mock providers are allowed only for deterministic failure injection and unit tests. They are not evidence for real LLM behavior.
