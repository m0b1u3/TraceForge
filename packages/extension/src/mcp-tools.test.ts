import { describe, it, expect } from "vitest";
import { mcpToolToDescriptor, type McpToolHandle, type McpCaller } from "./mcp-tools.js";

const handle: McpToolHandle = {
  serverName: "filesystem",
  toolName: "read_file",
  description: "Read a file",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  trustLevel: "command",
};

function caller(): McpCaller & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    callTool: async (s, t, input) => { calls.push([s, t, input]); return { ok: true, content: `ran ${s}/${t}` }; },
  };
}

describe("mcpToolToDescriptor", () => {
  it("uses the MCP tool name without a server prefix", () => {
    const d = mcpToolToDescriptor(handle, caller());
    expect(d.name).toBe("read_file");
  });

  it("carries description, schema, and source", () => {
    const d = mcpToolToDescriptor(handle, caller());
    expect(d.description).toBe("Read a file");
    expect(d.inputSchema).toEqual(handle.inputSchema);
    expect(d.source).toBe("mcp:filesystem");
  });

  it("risk follows trustLevel (command default)", () => {
    expect(mcpToolToDescriptor(handle, caller()).risk).toBe("command");
    expect(mcpToolToDescriptor({ ...handle, trustLevel: "normal" }, caller()).risk).toBe("normal");
  });

  it("execute forwards to caller.callTool with original tool name", async () => {
    const c = caller();
    const d = mcpToolToDescriptor(handle, c);
    const res = await d.execute({ path: "/etc/hosts" });
    expect(res).toEqual({ ok: true, content: "ran filesystem/read_file" });
    expect(c.calls).toEqual([["filesystem", "read_file", { path: "/etc/hosts" }]]);
  });
});
