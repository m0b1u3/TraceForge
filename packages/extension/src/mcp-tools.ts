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

export function mcpToolToDescriptor(h: McpToolHandle, caller: McpCaller): ToolDescriptor {
  return {
    name: `mcp__${h.serverName}__${h.toolName}`,
    description: h.description,
    inputSchema: h.inputSchema,
    risk: h.trustLevel,
    source: `mcp:${h.serverName}`,
    execute: (input) => caller.callTool(h.serverName, h.toolName, input),
  };
}
