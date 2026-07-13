import { beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createDb } from "./db/client.js";
import { EventBus } from "./event-bus.js";
import { registerRoutes } from "./routes.js";
import { realLlmProviderForTest } from "./real-llm-test-provider.js";

let app: FastifyInstance;
let caseId: string;

beforeEach(async () => {
  app = Fastify();
  registerRoutes(app, createDb(":memory:"), new EventBus(), realLlmProviderForTest());
  await app.ready();
  caseId = (await app.inject({
    method: "POST",
    url: "/api/cases",
    payload: { name: "scope intervention", allowHosts: [] },
  })).json().id;
});

describe("scope intervention routes", () => {
  it("persists an approved scope outcome", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/cases/${caseId}/scope/approve`,
      payload: { host: "target.example" },
    });

    expect(response.statusCode).toBe(200);
    const events = (await app.inject({ url: `/api/cases/${caseId}/agent/events` })).json();
    expect(events.at(-1)).toMatchObject({ kind: "done", text: "Scope approved: target.example" });
  });

  it("persists a keep-blocked outcome without adding the host to scope", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/cases/${caseId}/scope/reject`,
      payload: { host: "target.example" },
    });

    expect(response.statusCode).toBe(200);
    const cases = (await app.inject({ url: "/api/cases" })).json();
    const current = cases.find((item: { id: string }) => item.id === caseId);
    expect(current.scopeRules.flatMap((rule: { allowHosts: string[] }) => rule.allowHosts)).not.toContain("target.example");
    const events = (await app.inject({ url: `/api/cases/${caseId}/agent/events` })).json();
    expect(events.at(-1)).toMatchObject({ kind: "done", text: "Scope kept blocked: target.example" });
  });
});
