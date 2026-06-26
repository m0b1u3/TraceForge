import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createDb } from "./db/client.js";
import { EventBus } from "./event-bus.js";
import { registerRoutes } from "./routes.js";
import { CaseStore } from "./stores/case-store.js";

describe("CaseStore.addAllowHost", () => {
  it("adds a host to allowHosts (deduped) and returns updated case", () => {
    const store = new CaseStore(createDb(":memory:"));
    const c = store.create("c", [{ caseId: "pending", allowHosts: [], denyHosts: [] }]);
    const updated = store.addAllowHost(c.id, "1.2.3.4");
    expect(updated?.scopeRules[0].allowHosts).toEqual(["1.2.3.4"]);
    // 幂等去重
    const again = store.addAllowHost(c.id, "1.2.3.4");
    expect(again?.scopeRules[0].allowHosts).toEqual(["1.2.3.4"]);
  });

  it("returns undefined for a missing case", () => {
    const store = new CaseStore(createDb(":memory:"));
    expect(store.addAllowHost("nope", "x")).toBeUndefined();
  });
});

let app: FastifyInstance;
let caseId: string;
beforeEach(async () => {
  app = Fastify();
  registerRoutes(app, createDb(":memory:"), new EventBus());
  await app.ready();
  caseId = (await app.inject({ method: "POST", url: "/api/cases", payload: { name: "d", allowHosts: [] } })).json().id;
});

describe("POST /api/cases/:id/scope/approve", () => {
  it("adds the host to the case allowHosts", async () => {
    const res = await app.inject({ method: "POST", url: `/api/cases/${caseId}/scope/approve`, payload: { host: "5.6.7.8" } });
    expect(res.statusCode).toBe(200);
    const c = (await app.inject({ url: "/api/cases" })).json().find((x: { id: string }) => x.id === caseId);
    expect(c.scopeRules[0].allowHosts).toContain("5.6.7.8");
  });

  it("returns 404 for a missing case", async () => {
    const res = await app.inject({ method: "POST", url: `/api/cases/nope/scope/approve`, payload: { host: "x" } });
    expect(res.statusCode).toBe(404);
  });
});
