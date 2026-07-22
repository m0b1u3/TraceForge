import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createDb } from "./db/client.js";
import { EventBus } from "./event-bus.js";
import { registerRoutes } from "./routes.js";

let app: FastifyInstance;
let caseId: string;

beforeEach(async () => {
  app = Fastify();
  registerRoutes(app, createDb(":memory:"), new EventBus());
  await app.ready();
  caseId = (await app.inject({ method: "POST", url: "/api/cases", payload: { name: "Hypothesis route", allowHosts: [] } })).json().id;
});

afterEach(async () => {
  await app.close();
});

describe("hypothesis routes", () => {
  it("returns the persisted pool for an existing case", async () => {
    const response = await app.inject({ method: "GET", url: `/api/cases/${caseId}/hypotheses` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });

  it("does not expose a pool for a missing case", async () => {
    const response = await app.inject({ method: "GET", url: "/api/cases/missing/hypotheses" });
    expect(response.statusCode).toBe(404);
  });
});
