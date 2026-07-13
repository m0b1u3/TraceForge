import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { McpManager } from "@traceforge/extension";
import type { RuntimeEvent } from "@traceforge/shared";
import { createDb } from "./db/client.js";
import { EventBus } from "./event-bus.js";
import { realLlmProviderForTest } from "./real-llm-test-provider.js";
import { registerRoutes } from "./routes.js";

let app: FastifyInstance;
let mcp: McpManager;
let workspace: string;
let events: RuntimeEvent[];
let caseId: string;

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error("timed out waiting for the real agent run");
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "tf-approval-interrupt-"));
  mcp = new McpManager();
  await mcp.connectAll([{
    name: "poc",
    command: process.execPath,
    args: [resolve("packages/mcp-poc-server/dist/main.js")],
    env: { TRACEFORGE_WORKSPACE: workspace },
    trustLevel: "command",
  }]);

  app = Fastify();
  const bus = new EventBus();
  events = [];
  bus.subscribe((event) => events.push(event));
  registerRoutes(app, createDb(":memory:"), bus, realLlmProviderForTest(), mcp);
  await app.ready();
  caseId = (await app.inject({
    method: "POST",
    url: "/api/cases",
    payload: { name: "approval interrupt", allowHosts: ["example.com"] },
  })).json().id;
  events.length = 0;
});

afterEach(async () => {
  await app.close();
  await mcp.closeAll();
  await rm(workspace, { recursive: true, force: true });
});

describe("pending approval interruption with a real LLM", () => {
  it("clears the approval and finishes the run when the user stops it", async () => {
    const started = await app.inject({
      method: "POST",
      url: `/api/cases/${caseId}/agent/run`,
      payload: { goal: "必须调用 list_dir 查看当前 Case 工作区根目录。不要调用其他工具。" },
    });
    expect(started.statusCode).toBe(200);

    await waitFor(() => events.some((event) => event.type === "approval_requested"));
    const approval = events.find(
      (event): event is Extract<RuntimeEvent, { type: "approval_requested" }> => event.type === "approval_requested",
    );
    expect(approval?.tool).toBe("list_dir");

    const pendingBefore = await app.inject({
      method: "GET",
      url: `/api/cases/${caseId}/interventions/pending`,
    });
    expect(pendingBefore.json().approval?.approvalId).toBe(approval?.approvalId);

    const interrupted = await app.inject({
      method: "POST",
      url: `/api/agent/runs/${started.json().run.id}/interrupt`,
      payload: { reason: "user stopped while approval was pending" },
    });
    expect(interrupted.statusCode).toBe(200);
    expect(interrupted.json().run.status).toBe("interrupting");

    const pendingAfter = await app.inject({
      method: "GET",
      url: `/api/cases/${caseId}/interventions/pending`,
    });
    expect(pendingAfter.json().approval).toBeNull();

    await waitFor(() => events.some((event) => event.type === "agent_run_interrupted"));
    const staleApproval = await app.inject({
      method: "POST",
      url: `/api/agent/approvals/${approval?.approvalId}`,
      payload: { decision: "approved" },
    });
    expect(staleApproval.statusCode).toBe(404);
  }, 120_000);
});
