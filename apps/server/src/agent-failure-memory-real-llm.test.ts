import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createDb } from "./db/client.js";
import { EventBus } from "./event-bus.js";
import { registerRoutes } from "./routes.js";
import { realLlmProviderForTest } from "./real-llm-test-provider.js";
import type { RuntimeEvent } from "@traceforge/shared";
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

  const mockClient: McpClient = {
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
  const mcp = new McpManager(async () => mockClient);
  await mcp.connectAll([{ name: "poc", command: "echo", args: [], trustLevel: "normal" } as McpServerConfig]);

  registerRoutes(app, db, bus, realLlmProviderForTest(), mcp);
  await app.ready();
  caseId = (await app.inject({ method: "POST", url: "/api/cases", payload: { name: "d", allowHosts: ["t.com"] } })).json().id;
  events.length = 0;
});

describe("agent failure memory with real LLM", () => {
  it("records a failed command attempt and skips a retry", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/cases/${caseId}/agent/run`,
      payload: { goal: "运行命令 'false'，失败后立刻再用完全相同的输入重试一次同一个命令，观察第二次调用是否被自动阻止。" },
    });
    expect(res.statusCode).toBe(200);
    const runId = res.json().run.id;

    await waitFor(() => events.some((e) => e.type === "agent_done" || e.type === "agent_run_failed"));

    const blocked = events.filter((e) => e.type === "agent_tool_blocked" && e.runId === runId);
    const toolResults = events.filter((e) => e.type === "agent_tool_result" && e.tool === "mcp__poc__exec_command");
    expect(toolResults.length).toBeGreaterThanOrEqual(1);
    expect(blocked.length).toBeGreaterThanOrEqual(1);
  }, 120000);
});
