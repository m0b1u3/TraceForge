/**
 * Compatibility exports for extension consumers. The provider contract is owned by
 * @traceforge/llm; this package only owns tool discovery and execution contracts.
 */
export type {
  LlmProvider, ExtractJsonArgs, ToolCall, TurnMessage, RunTurn, LlmToolDefinition,
  RunToolsArgs, StreamToolsHandlers, UsageSnapshot, EmbedArgs,
} from "@traceforge/llm";
