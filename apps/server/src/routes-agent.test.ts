import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createDb } from "./db/client.js";
import { EventBus } from "./event-bus.js";
import { registerRoutes } from "./routes.js";
import { MockProvider } from "@traceforge/llm";
import type { RuntimeEvent } from "@traceforge/shared";

let app: FastifyInstance;
let events: RuntimeEvent[];
let caseId: string;

beforeEach(async () => {
  app = Fastify();
  const db = createDb(":memory:");
  const bus = new EventBus();
  events = [];
  bus.subscribe((e) => events.push(e));
  // provider 注入预设 tool-calling 序列：先 record_fact，再 done
  const provider = new MockProvider({}, [
    { text: "记录发现", toolCalls: [{ id: "c1", name: "record_fact", input: { type: "api_endpoint", title: "order api", value: { url: "x" } } }], done: false },
    { text: "完成", toolCalls: [], done: true },
  ]);
  registerRoutes(app, db, bus, provider);
  await app.ready();
  caseId = (await app.inject({ method: "POST", url: "/api/cases", payload: { name: "d", allowHosts: ["t.com"] } })).json().id;
  events.length = 0;
});

describe("agent run route", () => {
  it("runs the agent which records a fact via tool, emitting events", async () => {
    const res = await app.inject({ method: "POST", url: `/api/cases/${caseId}/agent/run`, payload: { goal: "找接口" } });
    expect(res.statusCode).toBe(200);
    const facts = (await app.inject({ url: `/api/cases/${caseId}/facts` })).json();
    expect(facts).toHaveLength(1);
    expect(facts[0].source.type).toBe("ai");
    expect(events.some((e) => e.type === "agent_started")).toBe(true);
    expect(events.some((e) => e.type === "fact_created")).toBe(true);
    expect(events.some((e) => e.type === "agent_done")).toBe(true);
  });
});
