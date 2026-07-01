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

## Result Log

- Provider/model: anthropic-compatible DeepSeek endpoint, `deepseek-chat`.
- Streaming mode observed: fallback stream events, because the configured Anthropic provider has no `streamTools` implementation. Observed `agent_stream_start`, `agent_stream_delta`, and `agent_stream_end`.
- Steering message: `补充要求：总结里明确写出 REAL_LLM_E2E_STEERED。`
- Steering result: real model output included `REAL_LLM_E2E_STEERED`; tool calls observed: `list_traffic`, then `record_task`.
- Interrupt result: `POST /api/agent/runs/:runId/interrupt` returned `interrupting`; terminal event became `agent_run_interrupted`; active run cleared.
- Bugs observed: initial verification was incorrectly reported before running this real LLM E2E. No runtime bug observed in the real E2E after running it.

## Native OpenAI-Compatible Streaming Result

- Provider/model: OpenAI-compatible DeepSeek endpoint, `deepseek-v4-flash`.
- Base URL: `https://api.deepseek.com`.
- Native streaming: provider exposed `streamTools`; observed 1 `agent_stream_start`, 67 `agent_stream_delta`, and 1 `agent_stream_end`.
- Delta shape: deltas arrived as small token/text fragments such as `第一`, `句`, `：`, `我`, proving this was native stream output rather than fallback whole-text streaming.
- Completion result: terminal event became `agent_run_completed`; active run cleared.
- Marker result: final real model output included `OPENAI_STREAM_E2E_OK`.
- Errors observed: none.
