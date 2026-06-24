import { describe, it, expect, vi } from "vitest";
import { McpManager, type McpClient, type McpClientFactory } from "./mcp-manager.js";
import type { McpServerConfig } from "./mcp-config.js";

function fakeClient(tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>): McpClient {
  return {
    listTools: async () => ({ tools }),
    callTool: async (args) => ({ content: [{ type: "text", text: `called ${args.name}` }] }),
    close: async () => {},
  };
}

const cfg = (over: Partial<McpServerConfig> = {}): McpServerConfig => ({
  name: "fs", command: "x", args: [], trustLevel: "command", ...over,
});

describe("McpManager", () => {
  it("connects and caches tools as handles with trustLevel from config", async () => {
    const factory: McpClientFactory = async () => fakeClient([
      { name: "read_file", description: "rf", inputSchema: { type: "object" } },
    ]);
    const m = new McpManager(factory);
    await m.connectAll([cfg()]);
    const handles = m.listTools();
    expect(handles).toHaveLength(1);
    expect(handles[0]).toMatchObject({ serverName: "fs", toolName: "read_file", description: "rf", trustLevel: "command" });
  });

  it("isolates a server whose connection fails (others still load)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const factory: McpClientFactory = async (c) => {
      if (c.name === "bad") throw new Error("spawn failed");
      return fakeClient([{ name: "ok_tool" }]);
    };
    const m = new McpManager(factory);
    await m.connectAll([cfg({ name: "bad" }), cfg({ name: "good" })]);
    expect(m.listTools().map((h) => h.serverName)).toEqual(["good"]);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("callTool forwards to the right client and returns text content", async () => {
    const factory: McpClientFactory = async () => fakeClient([{ name: "read_file" }]);
    const m = new McpManager(factory);
    await m.connectAll([cfg()]);
    const res = await m.callTool("fs", "read_file", { path: "/x" });
    expect(res).toEqual({ ok: true, content: "called read_file" });
  });

  it("callTool returns ok:false for an unknown server", async () => {
    const m = new McpManager(async () => fakeClient([]));
    const res = await m.callTool("nope", "t", {});
    expect(res.ok).toBe(false);
  });

  it("callTool returns ok:false when the client throws", async () => {
    const factory: McpClientFactory = async () => ({
      listTools: async () => ({ tools: [{ name: "boom" }] }),
      callTool: async () => { throw new Error("remote crash"); },
      close: async () => {},
    });
    const m = new McpManager(factory);
    await m.connectAll([cfg()]);
    const res = await m.callTool("fs", "boom", {});
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/remote crash/);
  });

  it("closeAll closes every client", async () => {
    const closed: string[] = [];
    const factory: McpClientFactory = async (c) => ({
      listTools: async () => ({ tools: [{ name: "t" }] }),
      callTool: async () => ({ content: [] }),
      close: async () => { closed.push(c.name); },
    });
    const m = new McpManager(factory);
    await m.connectAll([cfg({ name: "a" }), cfg({ name: "b" })]);
    await m.closeAll();
    expect(closed.sort()).toEqual(["a", "b"]);
  });
});
