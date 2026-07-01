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

- Provider/model:
- Streaming mode observed:
- Steering message:
- Interrupt result:
- Bugs observed:
