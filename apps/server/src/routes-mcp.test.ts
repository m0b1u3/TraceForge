import { afterEach, describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createDb } from "./db/client.js";
import { EventBus } from "./event-bus.js";
import { registerRoutes } from "./routes.js";
import { McpManager } from "@traceforge/extension";
import { realLlmProviderForTest } from "./real-llm-test-provider.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let app: FastifyInstance;
let caseId: string;
let mcp: McpManager;
let workspace: string;

async function waitForAgentHistory(): Promise<void> {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const res = await app.inject({ url: `/api/cases/${caseId}/agent/events` });
    if (res.json().some((e: { kind: string }) => e.kind === "done")) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out waiting for real LLM run");
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "tf-routes-mcp-"));
  mcp = new McpManager();
  await mcp.connectAll([{
    name: "poc",
    command: process.execPath,
    args: [resolve("packages/mcp-poc-server/dist/main.js")],
    env: { TRACEFORGE_WORKSPACE: workspace },
    trustLevel: "normal",
  }]);
  app = Fastify();
  const db = createDb(":memory:");
  const bus = new EventBus();
  const provider = realLlmProviderForTest();
  registerRoutes(app, db, bus, provider, mcp);
  await app.ready();
  caseId = (await app.inject({ method: "POST", url: "/api/cases", payload: { name: "d", allowHosts: ["t.com"] } })).json().id;
});

afterEach(async () => {
  await app.close();
  await mcp.closeAll();
  await rm(workspace, { recursive: true, force: true });
});

describe("mcp routes", () => {
  it("GET /api/mcp/tools lists the namespaced tools", async () => {
    const res = await app.inject({ url: "/api/mcp/tools" });
    expect(res.statusCode).toBe(200);
    const tools = res.json();
    expect(tools).toHaveLength(4);
    expect(tools.some((tool: { serverName: string; toolName: string }) => tool.serverName === "poc" && tool.toolName === "read_file")).toBe(true);
  });

  it("agent run works with MCP tools registered in the case registry", async () => {
    const res = await app.inject({ method: "POST", url: `/api/cases/${caseId}/agent/run`, payload: { goal: "用一句中文说明 MCP 工具已在上下文中可用，不要调用工具。" } });
    expect(res.statusCode).toBe(200);
    await waitForAgentHistory();
  });
});
