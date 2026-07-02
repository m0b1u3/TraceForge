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
  const deadline = Date.now() + 30000;
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

describe("agent run route", () => {
  it("runs with the configured real LLM and emits terminal events", async () => {
    const res = await app.inject({ method: "POST", url: `/api/cases/${caseId}/agent/run`, payload: { goal: "用一句中文说明你已收到任务，不要编造任何扫描结果。" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().run.id).toMatch(/^run_/);
    await waitFor(() => events.some((e) => e.type === "agent_done"));
    expect(events.some((e) => e.type === "agent_started")).toBe(true);
    expect(events.some((e) => e.type === "agent_done")).toBe(true);
  });
});
