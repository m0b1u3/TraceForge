import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createDb } from "./db/client.js";
import { EventBus } from "./event-bus.js";
import { registerRoutes } from "./routes.js";
import { McpManager, type McpClientFactory } from "@traceforge/extension";
import { MockProvider } from "@traceforge/llm";

let app: FastifyInstance;
let caseId: string;

// 一个连了假 client、暴露一个 normal 工具的 McpManager（normal 免确认门，便于 agent 直接调用）
async function fakeMcp(): Promise<McpManager> {
  const factory: McpClientFactory = async () => ({
    listTools: async () => ({ tools: [{ name: "read_file", description: "rf", inputSchema: { type: "object" } }] }),
    callTool: async () => ({ content: [{ type: "text", text: "file contents" }] }),
    close: async () => {},
  });
  const m = new McpManager(factory);
  await m.connectAll([{ name: "fs", command: "x", args: [], trustLevel: "normal" }]);
  return m;
}

beforeEach(async () => {
  app = Fastify();
  const db = createDb(":memory:");
  const bus = new EventBus();
  const provider = new MockProvider({}, [
    { text: "读文件", toolCalls: [{ id: "c1", name: "mcp__fs__read_file", input: { path: "/x" } }], done: false },
    { text: "完成", toolCalls: [], done: true },
  ]);
  registerRoutes(app, db, bus, provider, await fakeMcp());
  await app.ready();
  caseId = (await app.inject({ method: "POST", url: "/api/cases", payload: { name: "d", allowHosts: ["t.com"] } })).json().id;
});

describe("mcp routes", () => {
  it("GET /api/mcp/tools lists the namespaced tools", async () => {
    const res = await app.inject({ url: "/api/mcp/tools" });
    expect(res.statusCode).toBe(200);
    const tools = res.json();
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ serverName: "fs", toolName: "read_file" });
  });

  it("agent run can call an mcp tool (registered into the case registry)", async () => {
    const res = await app.inject({ method: "POST", url: `/api/cases/${caseId}/agent/run`, payload: { goal: "读文件" } });
    expect(res.statusCode).toBe(200);
  });
});
