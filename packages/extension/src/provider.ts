import type { NativeToolDef } from "./tool.js";

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

export interface RunToolsArgs {
  system: string;
  messages: TurnMessage[];
  tools: NativeToolDef[];
  onRetry?: (event: { attempt: number; maxAttempts: number; reason: string }) => void;
  onUsage?: (usage: UsageSnapshot) => void;
}

export interface StreamToolsHandlers {
  onTextDelta?: (delta: string) => void;
  signal?: AbortSignal;
  onRetry?: (event: { attempt: number; maxAttempts: number; reason: string }) => void;
  onUsage?: (usage: UsageSnapshot) => void;
}

export interface EmbedArgs {
  inputs: string[];
  signal?: AbortSignal;
}

export interface LlmProvider {
  extractJson(args: ExtractJsonArgs): Promise<unknown>;
  runTools(args: RunToolsArgs): Promise<RunTurn>;
  streamTools?(args: RunToolsArgs, handlers: StreamToolsHandlers): Promise<RunTurn>;
  embed?(args: EmbedArgs): Promise<number[][]>;
}
