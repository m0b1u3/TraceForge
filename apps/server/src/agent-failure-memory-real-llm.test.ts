import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createDb } from "./db/client.js";
import { EventBus } from "./event-bus.js";
import { registerRoutes } from "./routes.js";
import { realLlmProviderForTest } from "./real-llm-test-provider.js";
import type { Fact, RuntimeEvent } from "@traceforge/shared";
import { McpManager, type McpClient, type McpServerConfig } from "@traceforge/extension";

let app: FastifyInstance;
let caseId: string;
let events: RuntimeEvent[];

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timed out waiting for background agent run");
}

beforeEach(async () => {
  app = Fastify();
  const db = createDb(":memory:");
  const bus = new EventBus();
  events = [];
  bus.subscribe((e) => events.push(e));

  const failingMcpClient: McpClient = {
    listTools: async () => ({
      tools: [
        {
          name: "exec_command",
          description: "execute command",
          inputSchema: { type: "object", properties: { command: { type: "string" } } },
        },
      ],
    }),
    callTool: async () => ({ content: [{ type: "text", text: "command failed" }], isError: true }),
    close: async () => {},
  };
  const mcp = new McpManager(async () => failingMcpClient);
  await mcp.connectAll([{ name: "poc", command: "echo", args: [], trustLevel: "normal" } as McpServerConfig]);

  registerRoutes(app, db, bus, realLlmProviderForTest(), mcp);
  await app.ready();
  caseId = (await app.inject({ method: "POST", url: "/api/cases", payload: { name: "d", allowHosts: ["t.com"] } })).json().id;
  events.length = 0;
});

describe("agent failure memory with real LLM", () => {
  it("records a failed command attempt from a real LLM tool call", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/cases/${caseId}/agent/run`,
      payload: { goal: "调用 exec_command 运行命令 'false'，观察失败结果并结束。" },
    });
    expect(res.statusCode).toBe(200);

    await waitFor(() => events.some((e) => e.type === "agent_done" || e.type === "agent_run_failed"));

    const toolResults = events.filter((e) => e.type === "agent_tool_result" && e.tool === "exec_command");
    const factsRes = await app.inject({ method: "GET", url: `/api/cases/${caseId}/facts` });
    const failedAttempts = (factsRes.json() as Fact[]).filter((f) => f.type === "failed_attempt" && f.tags.includes("failure-memory"));

    expect(toolResults.length).toBeGreaterThanOrEqual(1);
    expect(failedAttempts.length).toBeGreaterThanOrEqual(1);
    expect(failedAttempts[0].value).toMatchObject({ tool: "exec_command" });
  }, 120000);
});

describe("agent failure memory transient failures", () => {
  it("does not persist command timeouts as failed attempts", async () => {
    const localApp = Fastify();
    const db = createDb(":memory:");
    const bus = new EventBus();
    const localEvents: RuntimeEvent[] = [];
    bus.subscribe((e) => localEvents.push(e));

    const timeoutClient: McpClient = {
      listTools: async () => ({
        tools: [
          {
            name: "exec_command",
            description: "execute command",
            inputSchema: { type: "object", properties: { command: { type: "string" } } },
          },
        ],
      }),
      callTool: async () => ({ content: [{ type: "text", text: "exit=timeout(1000ms)\n--- stdout ---\n\n--- stderr ---\n" }], isError: true }),
      close: async () => {},
    };
    const mcp = new McpManager(async () => timeoutClient);
    await mcp.connectAll([{ name: "poc", command: "echo", args: [], trustLevel: "normal" } as McpServerConfig]);

    registerRoutes(localApp, db, bus, realLlmProviderForTest(), mcp);
    await localApp.ready();
    const localCaseId = (await localApp.inject({ method: "POST", url: "/api/cases", payload: { name: "timeout", allowHosts: ["t.com"] } })).json().id;

    const res = await localApp.inject({
      method: "POST",
      url: `/api/cases/${localCaseId}/agent/run`,
      payload: { goal: "调用 exec_command 运行命令 'sleep 10'，观察结果并结束。" },
    });
    expect(res.statusCode).toBe(200);
    await waitFor(() => localEvents.some((e) => e.type === "agent_done" || e.type === "agent_run_failed"));

    const factsRes = await localApp.inject({ method: "GET", url: `/api/cases/${localCaseId}/facts` });
    const failedAttempts = (factsRes.json() as Fact[]).filter((f) => f.type === "failed_attempt" && f.tags.includes("failure-memory"));
    expect(failedAttempts).toHaveLength(0);
    await localApp.close();
  }, 120000);
});
