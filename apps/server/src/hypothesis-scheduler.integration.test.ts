import { describe, expect, it } from "vitest";
import { createDb } from "./db/client.js";
import { HypothesisScheduler, scoreHypothesis } from "./hypothesis-scheduler.js";
import { HypothesisStore } from "./stores/hypothesis-store.js";

describe("HypothesisScheduler with real SQLite", () => {
  it("scores evidence-rich, high-impact, low-cost hypotheses above weak expensive ones", () => {
    const strong = scoreHypothesis({
      impact: 95,
      evidenceStrength: 90,
      verificationCost: 20,
      operationRisk: 20,
      pathRelevance: 85,
      freshness: 90,
    });
    const weak = scoreHypothesis({
      impact: 35,
      evidenceStrength: 20,
      verificationCost: 90,
      operationRisk: 80,
      pathRelevance: 15,
      freshness: 30,
    });
    expect(strong).toBeGreaterThan(weak);
  });

  it("keeps the top five active and demotes a displaced hypothesis", () => {
    const store = new HypothesisStore(createDb(":memory:"));
    const scheduler = new HypothesisScheduler(store);
    const ids: string[] = [];

    for (let index = 0; index < 6; index += 1) {
      const hypothesis = store.create("case_1", {
        runId: "run_1",
        statement: `Hypothesis ${index}`,
        basedOnFactIds: [],
        status: "candidate",
        scoreFactors: {
          impact: 20 + index * 10,
          evidenceStrength: 50,
          verificationCost: 40,
          operationRisk: 30,
          pathRelevance: 50,
          freshness: 80,
        },
      });
      ids.push(hypothesis.id);
    }

    const initial = scheduler.rebalance("case_1", "run_1");
    expect(initial.active).toHaveLength(5);
    expect(initial.active.map((item) => item.id)).not.toContain(ids[0]);

    store.update(ids[0], {
      scoreFactors: {
        impact: 100,
        evidenceStrength: 100,
        verificationCost: 0,
        operationRisk: 0,
        pathRelevance: 100,
        freshness: 100,
      },
    });
    const rebalanced = scheduler.rebalance("case_1", "run_1");

    expect(rebalanced.active.map((item) => item.id)).toContain(ids[0]);
    expect(rebalanced.promoted).toContain(ids[0]);
    expect(rebalanced.demoted).toHaveLength(1);
    expect(store.listByCase("case_1").filter((item) => item.status === "active")).toHaveLength(5);
  });

  it("does not reactivate confirmed or archived hypotheses", () => {
    const store = new HypothesisStore(createDb(":memory:"));
    const scheduler = new HypothesisScheduler(store);
    const confirmed = store.create("case_1", {
      runId: "run_1",
      statement: "Already confirmed",
      basedOnFactIds: [],
      status: "candidate",
      priorityScore: 100,
    });
    store.update(confirmed.id, { status: "confirmed" });

    expect(scheduler.rebalance("case_1", "run_1").active).toHaveLength(0);
    expect(store.getById(confirmed.id)?.status).toBe("confirmed");
  });
});
