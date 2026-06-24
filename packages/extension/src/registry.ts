import type { ToolDescriptor, NativeToolDef } from "./tool.js";

export class ToolRegistry {
  private tools = new Map<string, ToolDescriptor>();

  register(t: ToolDescriptor): void {
    if (this.tools.has(t.name)) throw new Error(`tool already registered: ${t.name}`);
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
