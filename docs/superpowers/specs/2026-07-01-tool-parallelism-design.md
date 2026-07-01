# Tool Parallelism Design

## Goal

Speed up agent turns when the LLM requests multiple independent read-only tools in one turn, while preserving safety, approval semantics, and deterministic message order.

## Scope

This phase implements parallel execution for explicitly marked read-only tools. It does not add sub-agents, planner-level task splitting, browser tab parallelism, or parallel command execution.

## Architecture

`ToolDescriptor` gains an optional execution hint:

```ts
executionMode?: "parallel" | "serial";
```

The default is `serial`. A tool is parallel-safe only when its descriptor explicitly says `executionMode: "parallel"`. This conservative default keeps all plugin/MCP/unknown tools serial until their owner marks them safe.

AgentRuntime changes from executing every tool call one by one to executing contiguous batches:

- A contiguous run of parallel-safe calls executes with `Promise.all`.
- Any serial call executes alone and preserves the current behavior.
- Results are appended to the LLM conversation in the same order as the original `turn.toolCalls`, even if parallel calls finish out of order.
- Interrupt checks run before and after each batch. If the user stops during a parallel batch, the runtime emits `interrupted` after the batch settles and does not start another LLM turn.

## Tool Classification

Mark as parallel:

- `list_traffic`
- `get_traffic`
- `search_facts`
- `get_fact_detail`
- `search_traffic`
- `recall_conversation`
- browser read-only tools: `extract_links`, `get_page_text`

Keep serial:

- `record_fact`
- `record_task`
- `record_action`
- `reopen_task`
- `revert_done_task`
- `http_replay`
- `propose_scope_expansion`
- browser mutating/navigation tools: `navigate`, `click`, `fill`
- all MCP tools unless explicitly changed later
- all command-risk tools

`risk: "command"` always forces serial execution, even if a descriptor accidentally says parallel.

## Ordering Guarantees

Parallel execution must not reorder the conversation sent back to the LLM. If the model asks for:

1. `search_facts`
2. `get_traffic`
3. `recall_conversation`

The runtime may execute them concurrently, but must append tool messages in the same 1-2-3 order and emit `tool_result` events in that same order. This keeps provider tool-call protocols deterministic.

## Error Handling

The existing tool error recovery remains unchanged. If a parallel tool throws, its result becomes:

```text
[tool_error] <tool_name>: <message>
```

Other parallel tools in the same batch still finish. The LLM receives every result in original order and decides the next step.

## Testing

Unit tests must prove:

- two parallel-safe tools execute concurrently, not sequentially.
- parallel tool results are emitted and appended in original tool-call order.
- serial tools still execute one by one.
- command-risk tools remain serial even if marked parallel.
- tool errors inside a parallel batch become ordered `tool_result` messages.

Real LLM validation must use the configured OpenAI-compatible model. Because a real model may choose any tool plan, the validation checks that normal streaming and interrupt behavior still pass after the runtime batching change. Deterministic concurrency behavior is proven by TDD unit tests.
