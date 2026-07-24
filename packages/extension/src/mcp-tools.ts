import type { ToolDescriptor } from "./tool.js";

export interface McpToolHandle {
  serverName: string;
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  trustLevel: "command" | "normal";
}

export interface McpCaller {
  callTool(serverName: string, toolName: string, input: unknown): Promise<{ ok: boolean; content: string }>;
}

export function mcpToolToDescriptor(
  h: McpToolHandle,
  caller: McpCaller,
  options: { caseId?: string } = {},
): ToolDescriptor {
  return {
    name: h.toolName,
    description: h.description,
    inputSchema: h.inputSchema,
    risk: h.trustLevel,
    source: `mcp:${h.serverName}`,
    execute: (input) => {
      const record = typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
      const boundInput = options.caseId && ["exec_command", "write_file", "read_file", "list_dir"].includes(h.toolName)
        ? { ...record, caseId: options.caseId }
        : input;
      return caller.callTool(h.serverName, h.toolName, boundInput);
    },
  };
}
