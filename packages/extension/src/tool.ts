export interface ToolResult {
  ok: boolean;
  content: string;
  meta?: Record<string, unknown>;
}

export type ToolExecutionMode = "parallel" | "serial";

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  risk: "command" | "normal";
  source: string;
  executionMode?: ToolExecutionMode;
  timeoutMs?: number;
  execute: (input: unknown) => Promise<ToolResult>;
}

export interface NativeToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}
