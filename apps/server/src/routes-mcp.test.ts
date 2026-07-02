import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createDb } from "./db/client.js";
import { EventBus } from "./event-bus.js";
import { registerRoutes } from "./routes.js";
import { McpManager, type McpClientFactory } from "@traceforge/extension";
import { realLlmProviderForTest } from "./real-llm-test-provider.js";

let app: FastifyInstance;
let caseId: string;

async function waitForAgentHistory(): Promise<void> {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const res = await app.inject({ url: `/api/cases/${caseId}/agent/events` });
    if (res.json().some((e: { kind: string }) => e.kind === "done")) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out waiting for real LLM run");
}

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
  const provider = realLlmProviderForTest();
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

  it("agent run works with MCP tools registered in the case registry", async () => {
    const res = await app.inject({ method: "POST", url: `/api/cases/${caseId}/agent/run`, payload: { goal: "用一句中文说明 MCP 工具已在上下文中可用，不要调用工具。" } });
    expect(res.statusCode).toBe(200);
    await waitForAgentHistory();
  });
});
