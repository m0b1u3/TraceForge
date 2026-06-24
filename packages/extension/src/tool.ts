export interface ToolResult {
  ok: boolean;
  content: string;
  meta?: Record<string, unknown>;
}

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  risk: "command" | "normal";
  source: string;
  execute: (input: unknown) => Promise<ToolResult>;
}

export interface NativeToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}
