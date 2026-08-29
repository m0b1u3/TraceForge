import { createHash } from "node:crypto";
import type { ExecutionRisk, ExecutionToolSpec } from "./model.js";

export interface ToolProviderContractSnapshot {
  providerId: string;
  version: string;
  source: string;
  protocolVersion: number;
  capabilities: string[];
  permissions: {
    network: "deny" | "brokered";
    filesystem: "none" | "read_only" | "scoped_write";
    process: "sandboxed";
    secrets: "none" | "handles_only";
  };
  resources: {
    cpuTimeMs: number;
    memoryBytes: number;
    maximumProcesses: number;
    maximumWriteBytes: number;
  };
  platforms: string[];
  executionFingerprint: string;
  tools: ExecutionToolSpec[];
}

export type ToolProviderCompatibility = "compatible" | "requires_drain" | "breaking";

export interface ToolProviderContractChange {
  code: string;
  classification: ToolProviderCompatibility;
  path: string;
  summary: string;
}

export interface ToolProviderCompatibilityReport {
  schemaVersion: 1;
  providerId: string;
  fromVersion: string;
  toVersion: string;
  classification: ToolProviderCompatibility;
  changes: ToolProviderContractChange[];
  fromFingerprint: string;
  toFingerprint: string;
}

const severity: Record<ToolProviderCompatibility, number> = { compatible: 0, requires_drain: 1, breaking: 2 };
const riskRank: Record<ExecutionRisk, number> = { read_only: 0, bounded_write: 1, privileged: 2, destructive: 3 };
const permissionRanks = {
  network: { deny: 0, brokered: 1 },
  filesystem: { none: 0, read_only: 1, scoped_write: 2 },
  secrets: { none: 0, handles_only: 1 },
} as const;

export function assessToolProviderCompatibility(
  previousValue: ToolProviderContractSnapshot,
  nextValue: ToolProviderContractSnapshot,
): ToolProviderCompatibilityReport {
  const previous = normalizeContract(previousValue);
  const next = normalizeContract(nextValue);
  if (previous.providerId !== next.providerId) throw new Error("Tool Provider compatibility requires the same Provider identity");
  const changes: ToolProviderContractChange[] = [];
  const change = (code: string, classification: ToolProviderCompatibility, path: string, summary: string) => {
    changes.push({ code, classification, path, summary });
  };

  if (previous.source !== next.source) change("source_changed", "breaking", "source", "Provider source identity changed");
  if (previous.protocolVersion !== next.protocolVersion) change("protocol_changed", "breaking", "protocolVersion", "Provider protocol version changed");
  compareSet(previous.capabilities, next.capabilities, "capabilities", "provider_capability", change);
  compareSet(previous.platforms, next.platforms, "platforms", "platform", change);
  compareRankedPermission(previous.permissions.network, next.permissions.network, permissionRanks.network, "permissions.network", change);
  compareRankedPermission(previous.permissions.filesystem, next.permissions.filesystem, permissionRanks.filesystem, "permissions.filesystem", change);
  compareRankedPermission(previous.permissions.secrets, next.permissions.secrets, permissionRanks.secrets, "permissions.secrets", change);
  if (previous.permissions.process !== next.permissions.process) change("process_permission_changed", "breaking", "permissions.process", "Provider process permission changed");
  if (canonical(previous.resources) !== canonical(next.resources)) {
    change("resources_changed", "requires_drain", "resources", "Provider resource limits changed");
  }
  if (previous.executionFingerprint !== next.executionFingerprint) {
    change("execution_changed", "requires_drain", "executionFingerprint", "Provider execution package or entrypoint changed");
  }

  const previousTools = new Map(previous.tools.map((tool) => [tool.name, tool]));
  const nextTools = new Map(next.tools.map((tool) => [tool.name, tool]));
  for (const name of [...previousTools.keys()].sort()) {
    const oldTool = previousTools.get(name)!;
    const newTool = nextTools.get(name);
    if (!newTool) {
      change("tool_removed", "breaking", `tools.${name}`, "Previously available tool was removed");
      continue;
    }
    compareTool(oldTool, newTool, change);
  }
  for (const name of [...nextTools.keys()].sort()) {
    if (!previousTools.has(name)) change("tool_added", "compatible", `tools.${name}`, "New tool was added");
  }
  changes.sort((left, right) => left.path.localeCompare(right.path) || left.code.localeCompare(right.code));
  const classification = changes.reduce<ToolProviderCompatibility>(
    (result, item) => severity[item.classification] > severity[result] ? item.classification : result,
    "compatible",
  );
  return {
    schemaVersion: 1,
    providerId: previous.providerId,
    fromVersion: previous.version,
    toVersion: next.version,
    classification,
    changes,
    fromFingerprint: contractFingerprint(previous),
    toFingerprint: contractFingerprint(next),
  };
}

export function contractFingerprint(value: ToolProviderContractSnapshot): string {
  return createHash("sha256").update(canonical(normalizeContract(value))).digest("hex");
}

export function executionToolContractFingerprint(tool: ExecutionToolSpec): string {
  const {
    name, source, version, inputSchema, providedCapabilities, dependencyCapabilities,
    permissionRequirements, risk, timeoutMs,
  } = tool;
  return createHash("sha256").update(canonical({
    name, source, version, inputSchema, providedCapabilities: [...providedCapabilities].sort(),
    dependencyCapabilities: [...dependencyCapabilities].sort(), permissionRequirements, risk, timeoutMs,
  })).digest("hex");
}

export function toolInvocationInputFingerprint(toolName: string, input: unknown): string {
  return createHash("sha256").update(canonical({ toolName, input })).digest("hex");
}

function compareTool(
  previous: ExecutionToolSpec,
  next: ExecutionToolSpec,
  change: (code: string, classification: ToolProviderCompatibility, path: string, summary: string) => void,
): void {
  const path = `tools.${previous.name}`;
  if (previous.source !== next.source) change("tool_source_changed", "breaking", `${path}.source`, "Tool source identity changed");
  if (!isBackwardCompatibleSchema(previous.inputSchema, next.inputSchema)) {
    change("input_schema_breaking", "breaking", `${path}.inputSchema`, "Tool input Schema is not provably backward compatible");
  } else if (canonical(previous.inputSchema) !== canonical(next.inputSchema)) {
    change("input_schema_extended", "compatible", `${path}.inputSchema`, "Tool input Schema was extended compatibly");
  }
  compareSet(previous.providedCapabilities, next.providedCapabilities, `${path}.providedCapabilities`, "tool_capability", change);
  const addedDependency = difference(next.dependencyCapabilities, previous.dependencyCapabilities);
  const removedDependency = difference(previous.dependencyCapabilities, next.dependencyCapabilities);
  if (addedDependency.length) change("dependency_added", "breaking", `${path}.dependencyCapabilities`, "Tool added dependency capabilities");
  if (removedDependency.length) change("dependency_removed", "compatible", `${path}.dependencyCapabilities`, "Tool removed dependency capabilities");
  if (canonical(previous.permissionRequirements) !== canonical(next.permissionRequirements)) {
    change("permission_requirements_changed", "breaking", `${path}.permissionRequirements`, "Tool permission requirements changed and require explicit review");
  }
  if (riskRank[next.risk] > riskRank[previous.risk]) change("risk_increased", "breaking", `${path}.risk`, "Tool execution risk increased");
  else if (riskRank[next.risk] < riskRank[previous.risk]) change("risk_reduced", "requires_drain", `${path}.risk`, "Tool execution risk was reduced");
  if (previous.timeoutMs !== next.timeoutMs) change("timeout_changed", "requires_drain", `${path}.timeoutMs`, "Tool timeout changed");
}

function isBackwardCompatibleSchema(previous: Record<string, unknown>, next: Record<string, unknown>): boolean {
  if (canonical(previous) === canonical(next)) return true;
  if (!isRecord(previous) || !isRecord(next)) return false;
  if (!supportedSchemaShape(previous) || !supportedSchemaShape(next)) return false;
  const previousType = previous.type;
  const nextType = next.type;
  if (previousType !== nextType) return false;
  if (Array.isArray(previous.enum) || Array.isArray(next.enum)) {
    if (!Array.isArray(previous.enum) || !Array.isArray(next.enum)) return false;
    const previousEnum = previous.enum as unknown[];
    const nextEnum = next.enum as unknown[];
    if (previousEnum.some((item) => !nextEnum.some((candidate) => canonical(candidate) === canonical(item)))) return false;
  }
  const previousRequired = stringSet(previous.required);
  const nextRequired = stringSet(next.required);
  if ([...nextRequired].some((name) => !previousRequired.has(name))) return false;
  const previousProperties = isRecord(previous.properties) ? previous.properties : {};
  const nextProperties = isRecord(next.properties) ? next.properties : {};
  for (const [name, schema] of Object.entries(previousProperties)) {
    const candidate = nextProperties[name];
    if (!isRecord(schema) || !isRecord(candidate) || !isBackwardCompatibleSchema(schema, candidate)) return false;
  }
  for (const name of Object.keys(nextProperties)) {
    if (!(name in previousProperties) && nextRequired.has(name)) return false;
  }
  const ignored = new Set(["properties", "required", "enum", "description", "title", "$comment", "examples", "default"]);
  const previousRest = Object.fromEntries(Object.entries(previous).filter(([key]) => !ignored.has(key)));
  const nextRest = Object.fromEntries(Object.entries(next).filter(([key]) => !ignored.has(key)));
  return canonical(previousRest) === canonical(nextRest);
}

function supportedSchemaShape(value: Record<string, unknown>): boolean {
  if ("required" in value && (!Array.isArray(value.required) || value.required.some((item) => typeof item !== "string"))) return false;
  if ("properties" in value && !isRecord(value.properties)) return false;
  if (isRecord(value.properties) && Object.values(value.properties).some((schema) => !isRecord(schema))) return false;
  if ("enum" in value && !Array.isArray(value.enum)) return false;
  return true;
}

function compareSet(
  previous: string[],
  next: string[],
  path: string,
  prefix: string,
  change: (code: string, classification: ToolProviderCompatibility, path: string, summary: string) => void,
): void {
  if (difference(previous, next).length) change(`${prefix}_removed`, "breaking", path, "Previously declared values were removed");
  if (difference(next, previous).length) change(`${prefix}_added`, "compatible", path, "New declared values were added");
}

function compareRankedPermission<T extends string>(
  previous: T,
  next: T,
  ranks: Record<T, number>,
  path: string,
  change: (code: string, classification: ToolProviderCompatibility, path: string, summary: string) => void,
): void {
  if (previous === next) return;
  if (ranks[next] > ranks[previous]) change("provider_permission_increased", "breaking", path, "Provider permission increased");
  else change("provider_permission_reduced", "requires_drain", path, "Provider permission was reduced");
}

function normalizeContract(value: ToolProviderContractSnapshot): ToolProviderContractSnapshot {
  if (!value.providerId.trim() || !value.version.trim() || !value.source.trim()) throw new Error("Tool Provider contract identity is required");
  if (!Number.isSafeInteger(value.protocolVersion) || value.protocolVersion < 1) throw new Error("Tool Provider contract protocol version is invalid");
  if (new Set(value.tools.map((tool) => tool.name)).size !== value.tools.length) throw new Error("Tool Provider contract contains duplicate tool names");
  return {
    ...structuredClone(value),
    capabilities: [...new Set(value.capabilities)].sort(),
    platforms: [...new Set(value.platforms)].sort(),
    tools: value.tools.map((tool) => ({
      ...structuredClone(tool),
      version: "<contract-version>",
      providedCapabilities: [...new Set(tool.providedCapabilities)].sort(),
      dependencyCapabilities: [...new Set(tool.dependencyCapabilities)].sort(),
    })).sort((left, right) => left.name.localeCompare(right.name)),
  };
}

function difference(left: string[], right: string[]): string[] {
  const values = new Set(right);
  return [...new Set(left)].filter((item) => !values.has(item)).sort();
}
function stringSet(value: unknown): Set<string> {
  return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
}
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
