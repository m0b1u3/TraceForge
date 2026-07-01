import type { NativeToolDef } from "./tool.js";

export interface ExtractJsonArgs {
  system: string;
  user: string;
  schema: Record<string, unknown>;
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
}

export interface RunTurn {
  text: string;
  toolCalls: ToolCall[];
  done: boolean;
}

export interface RunToolsArgs {
  system: string;
  messages: TurnMessage[];
  tools: NativeToolDef[];
}

export interface StreamToolsHandlers {
  onTextDelta?: (delta: string) => void;
  signal?: AbortSignal;
}

export interface LlmProvider {
  extractJson(args: ExtractJsonArgs): Promise<unknown>;
  runTools(args: RunToolsArgs): Promise<RunTurn>;
  streamTools?(args: RunToolsArgs, handlers: StreamToolsHandlers): Promise<RunTurn>;
}
