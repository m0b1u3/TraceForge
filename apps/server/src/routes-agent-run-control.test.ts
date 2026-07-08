import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createDb } from "./db/client.js";
import { EventBus } from "./event-bus.js";
import { registerRoutes } from "./routes.js";
import type { LlmProvider, RunToolsArgs } from "@traceforge/llm";
import type { RuntimeEvent } from "@traceforge/shared";

let app: FastifyInstance;
let events: RuntimeEvent[];
let caseId: string;

function delayedProvider(): LlmProvider {
  return {
    extractJson: async () => ({ warnings: [] }),
    runTools: async (_args: RunToolsArgs) => {
      await new Promise((r) => setTimeout(r, 50));
      return { text: "done", toolCalls: [], done: true };
    },
  };
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("Timed out waiting for runtime event");
}

beforeEach(async () => {
  app = Fastify();
  const db = createDb(":memory:");
  const bus = new EventBus();
  events = [];
  bus.subscribe((e) => events.push(e));
  registerRoutes(app, db, bus, delayedProvider());
  await app.ready();
  const res = await app.inject({ method: "POST", url: "/api/cases", payload: { name: "demo", allowHosts: ["example.com"] } });
  caseId = res.json().id;
  events.length = 0;
});

describe("agent run control routes", () => {
  it("starts a background run and returns run immediately", async () => {
    const started = await app.inject({ method: "POST", url: `/api/cases/${caseId}/agent/run`, payload: { goal: "go" } });
    expect(started.statusCode).toBe(200);
    const run = started.json().run;
    expect(run.id).toMatch(/^run_/);
    expect(run.status).toBe("running");
    expect(events.some((e) => e.type === "agent_run_started")).toBe(true);
  });

  it("rejects a second active run for the same case", async () => {
    await app.inject({ method: "POST", url: `/api/cases/${caseId}/agent/run`, payload: { goal: "go" } });
    const second = await app.inject({ method: "POST", url: `/api/cases/${caseId}/agent/run`, payload: { goal: "again" } });
    expect(second.statusCode).toBe(409);
  });

  it("accepts steering for an active run", async () => {
    const run = (await app.inject({ method: "POST", url: `/api/cases/${caseId}/agent/run`, payload: { goal: "go" } })).json().run;
    const steer = await app.inject({ method: "POST", url: `/api/agent/runs/${run.id}/steer`, payload: { content: "look at orders" } });
    expect(steer.statusCode).toBe(200);
    expect(events.some((e) => e.type === "agent_steering_added" && e.content.includes("orders"))).toBe(true);
  });

  it("interrupts an active run", async () => {
    const run = (await app.inject({ method: "POST", url: `/api/cases/${caseId}/agent/run`, payload: { goal: "go" } })).json().run;
    const stopped = await app.inject({ method: "POST", url: `/api/agent/runs/${run.id}/interrupt`, payload: { reason: "stop" } });
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json().run.status).toBe("interrupting");
  });

  it("keeps an interrupted run interrupted after a non-aborting provider returns", async () => {
    const run = (await app.inject({ method: "POST", url: `/api/cases/${caseId}/agent/run`, payload: { goal: "go" } })).json().run;
    await app.inject({ method: "POST", url: `/api/agent/runs/${run.id}/interrupt`, payload: { reason: "stop" } });
    await new Promise((r) => setTimeout(r, 80));
    const active = await app.inject({ method: "GET", url: `/api/cases/${caseId}/agent/runs/active` });
    expect(active.json()).toBeNull();
    expect(events.some((e) => e.type === "agent_run_interrupted" && e.run.id === run.id)).toBe(true);
    expect(events.some((e) => e.type === "agent_run_completed" && e.run.id === run.id)).toBe(false);
  });

  it("returns the latest run after it has completed", async () => {
    await app.inject({ method: "POST", url: `/api/cases/${caseId}/agent/run`, payload: { goal: "go" } });
    await waitFor(() => events.some((e) => e.type === "agent_run_completed"));

    const latest = await app.inject({ method: "GET", url: `/api/cases/${caseId}/agent/runs/latest` });

    expect(latest.statusCode).toBe(200);
    expect(latest.json().status).toBe("completed");
    expect(latest.json().caseId).toBe(caseId);
  });

  it("emits retrying events from provider retry callbacks", async () => {
    const retryingProvider: LlmProvider = {
      extractJson: async () => ({ warnings: [] }),
      runTools: async (args: RunToolsArgs) => {
        args.onRetry?.({ attempt: 2, maxAttempts: 3, reason: "rate limited" });
        return { text: "done", toolCalls: [], done: true };
      },
    };
    const localApp = Fastify();
    const bus = new EventBus();
    const localEvents: RuntimeEvent[] = [];
    bus.subscribe((e) => localEvents.push(e));
    registerRoutes(localApp, createDb(":memory:"), bus, retryingProvider);
    await localApp.ready();
    const cid = (await localApp.inject({ method: "POST", url: "/api/cases", payload: { name: "retry", allowHosts: ["example.com"] } })).json().id;
    await localApp.inject({ method: "POST", url: `/api/cases/${cid}/agent/run`, payload: { goal: "go" } });
    await waitFor(() => localEvents.some((e) => e.type === "agent_run_completed"));

    expect(localEvents.some((e) => e.type === "agent_retrying" && e.attempt === 2 && e.reason === "rate limited")).toBe(true);
    await localApp.close();
  });

  it("emits agent_run_needs_continuation when the runtime budget is exhausted", async () => {
    const loopingProvider: LlmProvider = {
      extractJson: async () => ({ queries: [] }),
      runTools: async () => ({
        text: "searching again",
        toolCalls: [{ id: `tc_${Date.now()}`, name: "search_facts", input: { query: "trace" } }],
        done: false,
      }),
    };
    const localApp = Fastify();
    const bus = new EventBus();
    const localEvents: RuntimeEvent[] = [];
    bus.subscribe((e) => localEvents.push(e));
    registerRoutes(localApp, createDb(":memory:"), bus, loopingProvider);
    await localApp.ready();
    const cid = (await localApp.inject({ method: "POST", url: "/api/cases", payload: { name: "budget", allowHosts: ["example.com"] } })).json().id;

    const response = await localApp.inject({
      method: "POST",
      url: `/api/cases/${cid}/agent/run`,
      payload: {
        goal: "keep searching",
        budget: { maxTurns: 1, warningTurnsRemaining: 0 },
      },
    });

    expect(response.statusCode).toBe(200);
    await waitFor(() => localEvents.some((e) => e.type === "agent_run_needs_continuation"));

    const continuation = localEvents.find(
      (e): e is Extract<RuntimeEvent, { type: "agent_run_needs_continuation" }> =>
        e.type === "agent_run_needs_continuation",
    );
    expect(continuation?.run.status).toBe("needs_continuation");
    expect(continuation?.reason).toContain("run budget exhausted");
    expect(localEvents.some((e) => e.type === "agent_run_completed" && e.run.id === continuation?.run.id)).toBe(false);
    await localApp.close();
  });
});
