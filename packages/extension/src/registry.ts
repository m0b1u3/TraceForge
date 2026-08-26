import type { ToolDescriptor, NativeToolDef } from "./tool.js";

const CAPABILITIES = new Set([
  "data.read", "data.write", "filesystem.read", "filesystem.write",
  "network.read", "network.write", "process.execute", "secrets.read",
]);
const IMPACT_SCOPES = new Set(["none", "case", "authorized_target", "external_service", "host"]);

export class ToolRegistry {
  private tools = new Map<string, ToolDescriptor>();

  register(t: ToolDescriptor): void {
    if (this.tools.has(t.name)) throw new Error(`tool already registered: ${t.name}`);
    if (!t.security || !Array.isArray(t.security.capabilities)) {
      throw new Error(`tool security profile required: ${t.name}`);
    }
    if (!IMPACT_SCOPES.has(t.security.impactScope)) {
      throw new Error(`invalid tool security impactScope: ${t.name}`);
    }
    if (t.security.capabilities.some((capability) => !CAPABILITIES.has(capability))) {
      throw new Error(`invalid tool security capability: ${t.name}`);
    }
    for (const field of ["mutates", "destructive", "openWorld"] as const) {
      if (typeof t.security[field] !== "boolean") {
        throw new Error(`tool security.${field} must be boolean: ${t.name}`);
      }
    }
    this.tools.set(t.name, t);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): ToolDescriptor | undefined {
    return this.tools.get(name);
  }

  list(): ToolDescriptor[] {
    return [...this.tools.values()];
  }

  toLlmTools(): NativeToolDef[] {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
  }
}
