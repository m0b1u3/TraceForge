import { describe, it, expect } from "vitest";
import { ToolRegistry } from "./registry.js";
import { TOOL_SECURITY, type ToolDescriptor } from "./tool.js";

function tool(name: string): ToolDescriptor {
  return {
    name, description: `does ${name}`, inputSchema: { type: "object", properties: {} },
    security: TOOL_SECURITY.caseRead, source: "builtin", execute: async () => ({ ok: true, content: "done" }),
  };
}

describe("ToolRegistry", () => {
  it("registers and retrieves a tool", () => {
    const r = new ToolRegistry();
    r.register(tool("http_replay"));
    expect(r.get("http_replay")?.name).toBe("http_replay");
    expect(r.list()).toHaveLength(1);
  });

  it("throws on duplicate name (no silent override)", () => {
    const r = new ToolRegistry();
    r.register(tool("x"));
    expect(() => r.register(tool("x"))).toThrow();
  });

  it("rejects dynamic tools without a security profile", () => {
    const r = new ToolRegistry();
    const unsafe = { ...tool("unsafe"), security: undefined } as unknown as ToolDescriptor;
    expect(() => r.register(unsafe)).toThrow(/security profile required/);
  });

  it("unregisters a tool (for MCP disconnect)", () => {
    const r = new ToolRegistry();
    r.register(tool("mcp__s__q"));
    r.unregister("mcp__s__q");
    expect(r.get("mcp__s__q")).toBeUndefined();
  });

  it("converts to native LLM tools (name/description/input_schema only)", () => {
    const r = new ToolRegistry();
    r.register(tool("http_replay"));
    const native = r.toLlmTools();
    expect(native).toEqual([
      { name: "http_replay", description: "does http_replay", input_schema: { type: "object", properties: {} } },
    ]);
  });
});
