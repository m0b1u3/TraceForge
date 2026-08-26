import type { ToolCapability, ToolDescriptor, ToolSecurityProfile } from "./tool.js";

export interface McpToolHandle {
  serverName: string;
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
}

export interface McpCaller {
  callTool(serverName: string, toolName: string, input: unknown): Promise<{ ok: boolean; content: string; meta?: Record<string, unknown> }>;
}

export function securityProfileForMcpTool(handle: McpToolHandle): ToolSecurityProfile {
  const readOnly = handle.annotations?.readOnlyHint === true;
  const openWorld = handle.annotations?.openWorldHint !== false;
  const capabilities: ToolCapability[] = [readOnly ? "data.read" : "data.write"];
  if (openWorld) capabilities.push(readOnly ? "network.read" : "network.write");
  return {
    capabilities,
    impactScope: openWorld ? "external_service" : "case",
    mutates: !readOnly,
    destructive: !readOnly && handle.annotations?.destructiveHint !== false,
    openWorld,
  };
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
    security: securityProfileForMcpTool(h),
    source: `mcp:${h.serverName}`,
    execute: (input) => {
      const record = typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
      const boundInput = options.caseId && ["write_file", "read_file", "list_dir"].includes(h.toolName)
        ? { ...record, caseId: options.caseId }
        : input;
      return caller.callTool(h.serverName, h.toolName, boundInput);
    },
  };
}
