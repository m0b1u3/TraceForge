import { beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createDb } from "./db/client.js";
import { EventBus } from "./event-bus.js";
import { registerRoutes } from "./routes.js";

let app: FastifyInstance;

beforeEach(async () => {
  app = Fastify();
  registerRoutes(app, createDb(":memory:"), new EventBus());
  await app.ready();
});

describe("case summary routes", () => {
  it("aggregates real case metadata and finding severity", async () => {
    const created = await app.inject({ method: "POST", url: "/api/cases", payload: { name: "Payments API", allowHosts: ["api.example.test"] } });
    const caseId = created.json().id as string;
    await app.inject({ method: "POST", url: `/api/cases/${caseId}/facts`, payload: { type: "security_finding", title: "IDOR", value: { severity: "high" } } });

    const response = await app.inject({ url: "/api/cases/summary" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([expect.objectContaining({
      id: caseId,
      name: "Payments API",
      target: "api.example.test",
      findingCount: 1,
      trafficCount: 0,
      runStatus: "idle",
      severityCounts: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
    })]);
  });

  it("renames and changes case status", async () => {
    const created = await app.inject({ method: "POST", url: "/api/cases", payload: { name: "Old", allowHosts: [] } });
    const response = await app.inject({ method: "PATCH", url: `/api/cases/${created.json().id}`, payload: { name: "Renamed", status: "paused" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.objectContaining({ name: "Renamed", status: "paused" }));
  });
});
