export interface UsageSnapshot {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ExtractJsonArgs {
  system: string;
  user: string;
  schema: Record<string, unknown>;
  signal?: AbortSignal;
  onUsage?: (usage: UsageSnapshot) => void;
  /** Only provider-public reasoning/summary text; never signatures or encrypted state. */
  onReasoningDelta?: (delta: string) => void;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface TurnMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  /** Runtime-only compaction hint; providers ignore it when serializing requests. */
  contextPriority?: "normal" | "pinned";
}

export interface RunTurn {
  text: string;
  reasoning?: string;
  toolCalls: ToolCall[];
  done: boolean;
}

/** Provider-facing schema only; tool execution ownership remains in the tool runtime. */
export interface LlmToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface RunToolsArgs {
  system: string;
  messages: TurnMessage[];
  tools: LlmToolDefinition[];
  onRetry?: (event: { attempt: number; maxAttempts: number; reason: string }) => void;
  onUsage?: (usage: UsageSnapshot) => void;
}

export interface StreamToolsHandlers {
  /** Display-only provider events. Partial arguments must never be executed. */
  onEvent?: (event: ModelStreamEvent) => void;
  onTextDelta?: (delta: string) => void;
  onReasoningDelta?: (delta: string) => void;
  signal?: AbortSignal;
  onRetry?: (event: { attempt: number; maxAttempts: number; reason: string }) => void;
  onUsage?: (usage: UsageSnapshot) => void;
}

export type ModelStreamEvent =
  | { type: "start" }
  | { type: "text_delta" | "reasoning_delta"; delta: string }
  | { type: "tool_call_delta"; index: number; id?: string; name?: string; delta: string }
  | { type: "complete"; turn: RunTurn }
  | { type: "error"; aborted: boolean };

export interface EmbedArgs {
  inputs: string[];
  signal?: AbortSignal;
}

export interface LlmProvider {
  readonly contextLimits?: { contextWindowTokens?: number; maxOutputTokens?: number; inputTokenMultiplier?: number };
  extractJson(args: ExtractJsonArgs): Promise<unknown>;
  runTools(args: RunToolsArgs): Promise<RunTurn>;
  streamTools?(args: RunToolsArgs, handlers: StreamToolsHandlers): Promise<RunTurn>;
  embed?(args: EmbedArgs): Promise<number[][]>;
}
