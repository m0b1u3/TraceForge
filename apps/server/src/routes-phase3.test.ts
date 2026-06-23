import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createDb } from "./db/client.js";
import { EventBus } from "./event-bus.js";
import { registerRoutes } from "./routes.js";
import { TrafficStore } from "./stores/traffic-store.js";
import { MockProvider } from "@traceforge/llm";
import type { RuntimeEvent } from "@traceforge/shared";

let app: FastifyInstance;
let events: RuntimeEvent[];
let caseId: string;
let trafId: string;

beforeEach(async () => {
  app = Fastify();
  const db = createDb(":memory:");
  const bus = new EventBus();
  events = [];
  bus.subscribe((e) => events.push(e));
  const provider = new MockProvider({
    candidates: [{ type: "api_endpoint", title: "order api", value: { url: "x" }, reasoning: "r", confidence: 0.8 }],
  });
  registerRoutes(app, db, bus, provider);
  await app.ready();

  caseId = (await app.inject({ method: "POST", url: "/api/cases", payload: { name: "d", allowHosts: ["t.com"] } })).json().id;

  const traffic = new TrafficStore(db);
  trafId = "traf_test_1";
  traffic.add({
    id: trafId, caseId, url: "https://t.com/api/order", method: "GET",
    requestHeaders: {}, responseStatus: 200, responseBody: null, createdAt: "now",
  });
  events.length = 0;
});

describe("extract + confirm flow", () => {
  it("extracts candidates without writing facts", async () => {
    const res = await app.inject({ method: "POST", url: `/api/cases/${caseId}/traffic/${trafId}/extract` });
    expect(res.statusCode).toBe(200);
    const cands = res.json();
    expect(cands).toHaveLength(1);
    expect(cands[0].id).toMatch(/^cand_/);
    const facts = (await app.inject({ url: `/api/cases/${caseId}/facts` })).json();
    expect(facts).toHaveLength(0);
    expect(events.some((e) => e.type === "candidates_extracted")).toBe(true);
  });

  it("confirm turns a candidate into a fact with source.type=ai", async () => {
    const cands = (await app.inject({ method: "POST", url: `/api/cases/${caseId}/traffic/${trafId}/extract` })).json();
    const candId = cands[0].id;
    const confirmed = await app.inject({ method: "POST", url: `/api/candidates/${candId}/confirm` });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().source.type).toBe("ai");

    const facts = (await app.inject({ url: `/api/cases/${caseId}/facts` })).json();
    expect(facts).toHaveLength(1);
    expect(events.some((e) => e.type === "fact_created")).toBe(true);

    const again = await app.inject({ method: "POST", url: `/api/candidates/${candId}/confirm` });
    expect(again.statusCode).toBe(404);
  });

  it("reject discards a candidate without creating a fact", async () => {
    const cands = (await app.inject({ method: "POST", url: `/api/cases/${caseId}/traffic/${trafId}/extract` })).json();
    const candId = cands[0].id;
    const rej = await app.inject({ method: "POST", url: `/api/candidates/${candId}/reject` });
    expect(rej.statusCode).toBe(200);
    const facts = (await app.inject({ url: `/api/cases/${caseId}/facts` })).json();
    expect(facts).toHaveLength(0);
  });
});
