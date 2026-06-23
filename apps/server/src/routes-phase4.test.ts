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
let factId: string;

beforeEach(async () => {
  app = Fastify();
  const db = createDb(":memory:");
  const bus = new EventBus();
  events = [];
  bus.subscribe((e) => events.push(e));
  // function 形式：plan 路由调用时才求值，此时 factId 已就绪
  const provider = new MockProvider(() => ({
    actions: [{
      title: "SQLi probe", goal: "check", evidenceRefs: [factId],
      reasoning: "id is db param", steps: ["baseline"], tool: "http_replay", priority: "high",
    }],
  }));
  registerRoutes(app, db, bus, provider);
  await app.ready();

  caseId = (await app.inject({ method: "POST", url: "/api/cases", payload: { name: "d", allowHosts: ["t.com"] } })).json().id;
  const fact = await app.inject({
    method: "POST", url: `/api/cases/${caseId}/facts`,
    payload: { type: "api_endpoint", title: "order api", value: { url: "https://t.com/api/order" }, source: { type: "manual", ref: "m" } },
  });
  factId = fact.json().id;
  events.length = 0;
});

describe("plan-actions + approve flow", () => {
  it("generates action candidates without writing action_cards", async () => {
    const res = await app.inject({ method: "POST", url: `/api/cases/${caseId}/plan-actions` });
    expect(res.statusCode).toBe(200);
    const cands = res.json();
    expect(cands).toHaveLength(1);
    expect(cands[0].id).toMatch(/^acand_/);
    expect(cands[0].evidenceRefs).toEqual([factId]);
    expect((await app.inject({ url: `/api/cases/${caseId}/actions` })).json()).toHaveLength(0);
    expect(events.some((e) => e.type === "action_candidates_generated")).toBe(true);
  });

  it("approve persists the action and records a decision", async () => {
    const cands = (await app.inject({ method: "POST", url: `/api/cases/${caseId}/plan-actions` })).json();
    const acandId = cands[0].id;
    const res = await app.inject({ method: "POST", url: `/api/action-candidates/${acandId}/approve` });
    expect(res.statusCode).toBe(200);
    expect(res.json().action.status).toBe("approved");
    expect(res.json().decision.basedOn).toEqual([factId]);

    expect((await app.inject({ url: `/api/cases/${caseId}/actions` })).json()).toHaveLength(1);
    expect((await app.inject({ url: `/api/cases/${caseId}/decisions` })).json()).toHaveLength(1);
    expect(events.some((e) => e.type === "action_approved")).toBe(true);
    expect(events.some((e) => e.type === "decision_recorded")).toBe(true);

    expect((await app.inject({ method: "POST", url: `/api/action-candidates/${acandId}/approve` })).statusCode).toBe(404);
  });

  it("reject discards a candidate without persisting", async () => {
    const cands = (await app.inject({ method: "POST", url: `/api/cases/${caseId}/plan-actions` })).json();
    const acandId = cands[0].id;
    expect((await app.inject({ method: "POST", url: `/api/action-candidates/${acandId}/reject` })).statusCode).toBe(200);
    expect((await app.inject({ url: `/api/cases/${caseId}/actions` })).json()).toHaveLength(0);
  });
});
