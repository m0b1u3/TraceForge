import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createDb } from "./db/client.js";
import { EventBus } from "./event-bus.js";
import { registerRoutes } from "./routes.js";
import { MockProvider } from "@traceforge/llm";

let app: FastifyInstance;
let caseId: string;

beforeEach(async () => {
  app = Fastify();
  const db = createDb(":memory:");
  const bus = new EventBus();
  const provider = new MockProvider({}, [
    { text: "记录发现", toolCalls: [{ id: "c1", name: "record_fact", input: { type: "api_endpoint", title: "order api", value: { url: "x" } } }], done: false },
    { text: "完成", toolCalls: [], done: true },
  ]);
  registerRoutes(app, db, bus, provider);
  await app.ready();
  caseId = (await app.inject({ method: "POST", url: "/api/cases", payload: { name: "d", allowHosts: ["t.com"] } })).json().id;
});

describe("agent events history", () => {
  it("persists agent events during a run and exposes them via the history endpoint", async () => {
    await app.inject({ method: "POST", url: `/api/cases/${caseId}/agent/run`, payload: { goal: "找接口" } });

    const res = await app.inject({ url: `/api/cases/${caseId}/agent/events` });
    expect(res.statusCode).toBe(200);
    const events = res.json();
    const kinds = events.map((e: { kind: string }) => e.kind);
    expect(kinds[0]).toBe("user"); // 先存用户这句目标
    expect(events[0].text).toBe("找接口");
    expect(kinds[1]).toBe("started");
    expect(kinds).toContain("tool_call");
    expect(kinds).toContain("tool_result");
    expect(kinds).toContain("done");

    const toolCall = events.find((e: { kind: string }) => e.kind === "tool_call");
    expect(toolCall.tool).toBe("record_fact");
  });

  it("isolates agent events by case", async () => {
    await app.inject({ method: "POST", url: `/api/cases/${caseId}/agent/run`, payload: { goal: "找接口" } });
    const other = (await app.inject({ method: "POST", url: "/api/cases", payload: { name: "o", allowHosts: ["t.com"] } })).json().id;
    const res = await app.inject({ url: `/api/cases/${other}/agent/events` });
    expect(res.json()).toHaveLength(0);
  });
});
