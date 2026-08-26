export interface ToolResult {
  ok: boolean;
  content: string;
  meta?: Record<string, unknown>;
}

export type ToolExecutionMode = "parallel" | "serial";

export type ToolCapability =
  | "data.read"
  | "data.write"
  | "filesystem.read"
  | "filesystem.write"
  | "network.read"
  | "network.write"
  | "process.execute"
  | "secrets.read";

export type ToolImpactScope =
  | "none"
  | "case"
  | "authorized_target"
  | "external_service"
  | "host";

export interface ToolSecurityProfile {
  capabilities: readonly ToolCapability[];
  impactScope: ToolImpactScope;
  mutates: boolean;
  destructive: boolean;
  openWorld: boolean;
}

export const TOOL_SECURITY = {
  caseRead: {
    capabilities: ["data.read"], impactScope: "case", mutates: false, destructive: false, openWorld: false,
  },
  caseWrite: {
    capabilities: ["data.write"], impactScope: "case", mutates: true, destructive: false, openWorld: false,
  },
  authorizedTargetRead: {
    capabilities: ["network.read"], impactScope: "authorized_target", mutates: false, destructive: false, openWorld: false,
  },
  authorizedTargetWrite: {
    capabilities: ["network.write"], impactScope: "authorized_target", mutates: true, destructive: false, openWorld: false,
  },
  hostExecution: {
    capabilities: ["process.execute"], impactScope: "host", mutates: true, destructive: false, openWorld: false,
  },
} as const satisfies Record<string, ToolSecurityProfile>;

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  security: ToolSecurityProfile;
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
