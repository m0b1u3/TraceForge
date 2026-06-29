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
    { text: "已提议纳入 a.com，等你批准", toolCalls: [], done: true },
    { text: "好的，基于你刚才的同意我开始", toolCalls: [], done: true },
  ]);
  registerRoutes(app, db, bus, provider);
  await app.ready();
  caseId = (await app.inject({ method: "POST", url: "/api/cases", payload: { name: "d", allowHosts: [] } })).json().id;
});

describe("cognitive context across runs", () => {
  it("second run sees first run conversation in history", async () => {
    await app.inject({ method: "POST", url: `/api/cases/${caseId}/agent/run`, payload: { goal: "测 a.com" } });
    await app.inject({ method: "POST", url: `/api/cases/${caseId}/agent/run`, payload: { goal: "同意" } });
    const events = (await app.inject({ url: `/api/cases/${caseId}/agent/events` })).json();
    const userTexts = events.filter((e: { kind: string }) => e.kind === "user").map((e: { text: string }) => e.text);
    expect(userTexts).toContain("测 a.com");
    expect(userTexts).toContain("同意");
    const doneTexts = events.filter((e: { kind: string }) => e.kind === "done").map((e: { text: string }) => e.text);
    expect(doneTexts.length).toBeGreaterThanOrEqual(2);
  });
});
