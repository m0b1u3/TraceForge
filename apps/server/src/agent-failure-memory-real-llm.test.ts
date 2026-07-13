import { afterEach, describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createDb } from "./db/client.js";
import { EventBus } from "./event-bus.js";
import { registerRoutes } from "./routes.js";
import { realLlmProviderForTest } from "./real-llm-test-provider.js";
import type { Fact, RuntimeEvent } from "@traceforge/shared";
import { McpManager } from "@traceforge/extension";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let app: FastifyInstance;
let caseId: string;
let events: RuntimeEvent[];
let mcp: McpManager;
let workspace: string;

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timed out waiting for background agent run");
}

async function startRealMcp(workspaceRoot: string): Promise<McpManager> {
  const manager = new McpManager();
  await manager.connectAll([{
    name: "poc",
    command: process.execPath,
    args: [resolve("packages/mcp-poc-server/dist/main.js")],
    env: { TRACEFORGE_WORKSPACE: workspaceRoot },
    trustLevel: "normal",
  }]);
  return manager;
}

beforeEach(async () => {
  app = Fastify();
  const db = createDb(":memory:");
  const bus = new EventBus();
  events = [];
  bus.subscribe((e) => events.push(e));
  workspace = await mkdtemp(join(tmpdir(), "tf-failure-memory-"));
  mcp = await startRealMcp(workspace);

  registerRoutes(app, db, bus, realLlmProviderForTest(), mcp);
  await app.ready();
  caseId = (await app.inject({ method: "POST", url: "/api/cases", payload: { name: "d", allowHosts: ["t.com"] } })).json().id;
  events.length = 0;
});

afterEach(async () => {
  await app.close();
  await mcp.closeAll();
  await rm(workspace, { recursive: true, force: true });
});

describe("agent failure memory with real LLM", () => {
  it("records a failed command attempt from a real LLM tool call", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/cases/${caseId}/agent/run`,
      payload: { goal: "调用 exec_command，command 必须是 node -e \"process.exit(1)\"。观察真实失败结果并结束。" },
    });
    expect(res.statusCode).toBe(200);

    await waitFor(() => events.some((e) => e.type === "agent_tool_result" && e.tool === "exec_command"));

    const toolResults = events.filter((e) => e.type === "agent_tool_result" && e.tool === "exec_command");
    const factsRes = await app.inject({ method: "GET", url: `/api/cases/${caseId}/facts` });
    const failedAttempts = (factsRes.json() as Fact[]).filter((f) => f.type === "failed_attempt" && f.tags.includes("failure-memory"));

    expect(toolResults.length).toBeGreaterThanOrEqual(1);
    expect(failedAttempts.length).toBeGreaterThanOrEqual(1);
    expect(failedAttempts[0].value).toMatchObject({ tool: "exec_command" });
    await app.inject({ method: "POST", url: `/api/agent/runs/${res.json().run.id}/interrupt`, payload: { reason: "assertions complete" } });
  }, 120000);
});

describe("agent failure memory transient failures", () => {
  it("does not persist command timeouts as failed attempts", async () => {
    const localApp = Fastify();
    const db = createDb(":memory:");
    const bus = new EventBus();
    const localEvents: RuntimeEvent[] = [];
    bus.subscribe((e) => localEvents.push(e));
    const localWorkspace = await mkdtemp(join(tmpdir(), "tf-timeout-memory-"));
    const localMcp = await startRealMcp(localWorkspace);

    registerRoutes(localApp, db, bus, realLlmProviderForTest(), localMcp);
    await localApp.ready();
    const localCaseId = (await localApp.inject({ method: "POST", url: "/api/cases", payload: { name: "timeout", allowHosts: ["t.com"] } })).json().id;

    const res = await localApp.inject({
      method: "POST",
      url: `/api/cases/${localCaseId}/agent/run`,
      payload: { goal: "调用 exec_command，command 必须是 node -e \"setTimeout(() => {}, 5000)\"，timeoutMs 必须是 100。观察真实超时结果并结束。" },
    });
    expect(res.statusCode).toBe(200);
    await waitFor(() => localEvents.some((e) => e.type === "agent_tool_result" && e.tool === "exec_command"));

    const factsRes = await localApp.inject({ method: "GET", url: `/api/cases/${localCaseId}/facts` });
    const failedAttempts = (factsRes.json() as Fact[]).filter((f) => f.type === "failed_attempt" && f.tags.includes("failure-memory"));
    expect(failedAttempts).toHaveLength(0);
    await localApp.inject({ method: "POST", url: `/api/agent/runs/${res.json().run.id}/interrupt`, payload: { reason: "assertions complete" } });
    await localApp.close();
    await localMcp.closeAll();
    await rm(localWorkspace, { recursive: true, force: true });
  }, 120000);
});
