import type { LlmProvider, ExtractJsonArgs, RunToolsArgs, StreamToolsHandlers, RunTurn } from "@traceforge/llm";

export class ProviderHolder implements LlmProvider {
  constructor(private getCurrent: () => LlmProvider) {}

  extractJson(args: ExtractJsonArgs): Promise<unknown> {
    return this.getCurrent().extractJson(args);
  }

  runTools(args: RunToolsArgs): Promise<RunTurn> {
    return this.getCurrent().runTools(args);
  }

  async streamTools(args: RunToolsArgs, handlers: StreamToolsHandlers): Promise<RunTurn> {
    const p = this.getCurrent();
    if (p.streamTools) return p.streamTools(args, handlers);
    if (handlers.signal?.aborted) throw abortError();
    const turn = await p.runTools({
      ...args,
      onRetry: handlers.onRetry ?? args.onRetry,
      onUsage: handlers.onUsage ?? args.onUsage,
    });
    if (handlers.signal?.aborted) throw abortError();
    if (turn.text) handlers.onTextDelta?.(turn.text);
    return turn;
  }
}

function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}
