import type { LlmProvider, ExtractJsonArgs, RunToolsArgs, StreamToolsHandlers, RunTurn } from "@traceforge/llm";

export class ProviderHolder implements LlmProvider {
  constructor(private getCurrent: () => LlmProvider) {}

  extractJson(args: ExtractJsonArgs): Promise<unknown> {
    return this.getCurrent().extractJson(args);
  }

  runTools(args: RunToolsArgs): Promise<RunTurn> {
    return this.getCurrent().runTools(args);
  }

  streamTools(args: RunToolsArgs, handlers: StreamToolsHandlers): Promise<RunTurn> {
    const p = this.getCurrent();
    if (!p.streamTools) throw new Error("current provider does not support streaming");
    return p.streamTools(args, handlers);
  }
}
