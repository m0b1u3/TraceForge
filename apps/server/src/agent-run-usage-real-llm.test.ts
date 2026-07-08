import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createDb } from "./db/client.js";
import { EventBus } from "./event-bus.js";
import { registerRoutes } from "./routes.js";
import { realLlmProviderForTest } from "./real-llm-test-provider.js";
import type { RuntimeEvent } from "@traceforge/shared";

let app: FastifyInstance;
let events: RuntimeEvent[];
let caseId: string;

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
  const provider = realLlmProviderForTest();
  registerRoutes(app, db, bus, provider);
  await app.ready();
  caseId = (await app.inject({ method: "POST", url: "/api/cases", payload: { name: "d", allowHosts: ["t.com"] } })).json().id;
  events.length = 0;
});

describe("agent run usage with real LLM", () => {
  it("emits agent_usage events with real token counts and increasing cumulative totals", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/cases/${caseId}/agent/run`,
      payload: { goal: "用一句中文说明你已收到任务，不要编造任何扫描结果。" },
    });
    expect(res.statusCode).toBe(200);
    const runId = res.json().run.id;

    await waitFor(() => events.some((e) => e.type === "agent_done"));

    const usageEvents = events.filter((e): e is Extract<RuntimeEvent, { type: "agent_usage" }> =>
      e.type === "agent_usage" && e.runId === runId
    );
    expect(usageEvents.length).toBeGreaterThan(0);

    let lastCumulative = 0;
    for (const e of usageEvents) {
      expect(e.totalTokens).toBeGreaterThan(0);
      expect(e.cumulativeTotalTokens).toBeGreaterThanOrEqual(lastCumulative);
      lastCumulative = e.cumulativeTotalTokens;
    }

    expect(events.some((e) => e.type === "agent_done")).toBe(true);
    expect(events.some((e) => e.type === "agent_run_needs_continuation")).toBe(false);
  }, 90000);
});
