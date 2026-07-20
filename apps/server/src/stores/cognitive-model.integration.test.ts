import { describe, expect, it } from "vitest";
import { createDb } from "../db/client.js";
import { FactStore } from "./fact-store.js";
import { HypothesisStore } from "./hypothesis-store.js";
import { SessionStateStore } from "./session-state-store.js";
import { TaskStore } from "./task-store.js";

describe("run-scoped cognitive model with real SQLite", () => {
  it("keeps run working state isolated while sharing verified case knowledge", () => {
    const db = createDb(":memory:");
    const facts = new FactStore(db);
    const hypotheses = new HypothesisStore(db);
    const sessions = new SessionStateStore(db);
    const tasks = new TaskStore(db);

    const fact = facts.create("case_1", {
      sourceRunId: "run_1",
      type: "security_signal",
      title: "Object ownership check is missing",
      value: { endpoint: "/api/orders/42" },
      source: { type: "traffic", ref: "traffic_1" },
      confidence: 0.8,
      tags: ["idor"],
      observations: [{
        id: "obs_1",
        sourceType: "traffic",
        sourceRef: "traffic_1",
        runId: "run_1",
        identityId: "user_a",
        condition: "authenticated as user A",
        summary: "User A received user B order",
        observedAt: "2026-07-20T00:00:00.000Z",
      }],
    });
    const hypothesis = hypotheses.create("case_1", {
      runId: "run_1",
      statement: "Order endpoint permits horizontal privilege escalation",
      basedOnFactIds: [fact.id],
      status: "active",
      priorityScore: 90,
    });
    const task = tasks.create("case_1", {
      runId: "run_1",
      title: "Replay order request as a second identity",
      status: "open",
      reason: "Controlled identity comparison",
      blockedBy: [],
      triggerWhen: [],
      relatedFacts: [fact.id],
      hypothesisIds: [hypothesis.id],
      priority: "high",
    });

    sessions.upsert("case_1", {
      currentGoal: "Validate IDOR",
      phase: "validate",
      activeHypothesisIds: [hypothesis.id],
    }, "run_1");
    sessions.upsert("case_1", {
      currentGoal: "Map payment API",
      phase: "map",
      activeHypothesisIds: [],
    }, "run_2");

    expect(facts.listByCase("case_1")).toHaveLength(1);
    expect(facts.getById(fact.id)?.observations?.[0]?.identityId).toBe("user_a");
    expect(hypotheses.getById(hypothesis.id)?.runId).toBe("run_1");
    expect(tasks.getById(task.id)?.hypothesisIds).toEqual([hypothesis.id]);
    expect(sessions.get("case_1", "run_1")?.phase).toBe("validate");
    expect(sessions.get("case_1", "run_2")?.phase).toBe("map");
  });

  it("places overflow active hypotheses into the candidate pool", () => {
    const db = createDb(":memory:");
    const hypotheses = new HypothesisStore(db);

    for (let index = 0; index < 5; index += 1) {
      hypotheses.create("case_1", {
        runId: "run_1",
        statement: `Active hypothesis ${index}`,
        basedOnFactIds: [],
        status: "active",
      });
    }
    hypotheses.create("case_1", {
      runId: "run_1",
      statement: "Candidate hypothesis",
      basedOnFactIds: [],
      status: "candidate",
    });

    const overflow = hypotheses.create("case_1", {
      runId: "run_1",
      statement: "Sixth active hypothesis",
      basedOnFactIds: [],
      status: "active",
    });
    expect(overflow.status).toBe("candidate");
    expect(hypotheses.listByCase("case_1").filter((item) => item.status === "active")).toHaveLength(5);
    expect(hypotheses.listByCase("case_1").filter((item) => item.status === "candidate")).toHaveLength(2);
  });
});
