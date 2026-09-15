import type { RunTurn, StreamToolsHandlers } from "./provider.js";

/** Uniform display events around native protocol streams, never a tool executor
 * or retry loop. Completion is emitted only after the adapter validates the end. */
export async function modelStreamEvents(handlers: StreamToolsHandlers,
  run: (handlers: StreamToolsHandlers) => Promise<RunTurn>): Promise<RunTurn> {
  try {
    handlers.signal?.throwIfAborted();
    handlers.onEvent?.({ type: "start" });
    const turn = await run({ ...handlers,
      onTextDelta(delta) { handlers.onTextDelta?.(delta); handlers.onEvent?.({ type: "text_delta", delta }); },
      onReasoningDelta(delta) { handlers.onReasoningDelta?.(delta); handlers.onEvent?.({ type: "reasoning_delta", delta }); },
    });
    handlers.signal?.throwIfAborted();
    handlers.onEvent?.({ type: "complete", turn });
    return turn;
  } catch (error) {
    handlers.onEvent?.({ type: "error", aborted: handlers.signal?.aborted === true });
    throw error;
  }
}
