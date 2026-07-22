import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createDb } from "./db/client.js";
import { EventBus } from "./event-bus.js";
import { registerRoutes } from "./routes.js";
import { FactStore } from "./stores/fact-store.js";
import { HypothesisStore } from "./stores/hypothesis-store.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("Hypothesis feedback route integration", () => {
  it("reacts to persisted evidence events and exposes the updated pool", async () => {
    const db = createDb(":memory:");
    const bus = new EventBus();
    app = Fastify();
    registerRoutes(app, db, bus);
    await app.ready();
    const createdCase = (await app.inject({ method: "POST", url: "/api/cases", payload: { name: "Feedback", allowHosts: [] } })).json();
    const facts = new FactStore(db);
    const hypotheses = new HypothesisStore(db);
    const fact = facts.create(createdCase.id, { type: "note", title: "Observed identifier", value: "42", source: { type: "traffic", ref: "req_1" }, confidence: 0.9, tags: [] });
    const hypothesis = hypotheses.create(createdCase.id, { runId: "run_1", statement: "Possible authorization bypass", basedOnFactIds: [fact.id] });
    const linked = facts.update(fact.id, { hypothesisIds: [hypothesis.id] });
    if (!linked) throw new Error("expected fact update");

    bus.emit({ type: "fact_updated", fact: linked });

    const response = await app.inject({ method: "GET", url: `/api/cases/${createdCase.id}/hypotheses` });
    expect(response.statusCode).toBe(200);
    const [updated] = response.json();
    expect(updated.scoreFactors.evidenceStrength).toBeGreaterThan(35);
    expect(updated.auditTrail.some((entry: { reason: string }) => entry.reason.includes("Automatic validation feedback"))).toBe(true);
    expect(updated.status).toBe("active");
  });
});
