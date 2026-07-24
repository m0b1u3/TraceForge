import { describe, expect, it } from "vitest";
import { createDb } from "./db/client.js";
import { HYPOTHESIS_ACTIVATION_MARGIN, HYPOTHESIS_MIN_RESIDENCY_MS, HypothesisScheduler, isFastTrackHypothesis, scoreHypothesis } from "./hypothesis-scheduler.js";
import { HypothesisStore } from "./stores/hypothesis-store.js";
import { TaskStore } from "./stores/task-store.js";

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

  it("expands to five active slots when evidence maturity supports the demand", () => {
    const db = createDb(":memory:");
    const store = new HypothesisStore(db);
    const scheduler = new HypothesisScheduler(store);
    const ids: string[] = [];

    for (let index = 0; index < 6; index += 1) {
      const hypothesis = store.create("case_1", {
        runId: "run_1",
        statement: `Hypothesis ${index}`,
        basedOnFactIds: [],
        status: "candidate",
        scoreFactors: {
          impact: 60 + index * 5,
          evidenceStrength: 80,
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
    expect(initial.capacity).toBe(5);
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
    expect(store.getById(ids[0])?.auditTrail.some((entry) => entry.kind === "promoted" && entry.reason.includes("5-slot active set"))).toBe(true);
    const demoted = store.getById(rebalanced.demoted[0]);
    expect(demoted?.auditTrail.some((entry) => entry.kind === "demoted" && entry.reason.includes("activation boundary"))).toBe(true);
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

  it("holds a newly active set stable during its minimum residency", () => {
    const store = new HypothesisStore(createDb(":memory:"));
    let clock = Date.now();
    const scheduler = new HypothesisScheduler(store, { now: () => new Date(clock) });
    for (let index = 0; index < 5; index += 1) store.create("case_1", { runId: "run_1", statement: `Incumbent ${index}`, basedOnFactIds: [], priorityScore: 50 + index });
    scheduler.rebalance("case_1", "run_1");
    const promotedAt = Math.max(...store.listByCase("case_1").flatMap((item) => item.auditTrail.filter((entry) => entry.kind === "promoted").map((entry) => Date.parse(entry.createdAt))));
    const challenger = store.create("case_1", { runId: "run_1", statement: "Strong but not critical", basedOnFactIds: [], priorityScore: 70 });

    expect(scheduler.rebalance("case_1", "run_1").promoted).not.toContain(challenger.id);
    clock = promotedAt + HYPOTHESIS_MIN_RESIDENCY_MS + 1;
    expect(scheduler.rebalance("case_1", "run_1").promoted).toContain(challenger.id);
  });

  it("requires a meaningful score margin after residency to avoid boundary churn", () => {
    const store = new HypothesisStore(createDb(":memory:"));
    let clock = Date.now();
    const scheduler = new HypothesisScheduler(store, { now: () => new Date(clock) });
    for (let index = 0; index < 5; index += 1) store.create("case_1", { runId: "run_1", statement: `Incumbent ${index}`, basedOnFactIds: [], priorityScore: 50 + index });
    scheduler.rebalance("case_1", "run_1");
    const promotedAt = Math.max(...store.listByCase("case_1").flatMap((item) => item.auditTrail.filter((entry) => entry.kind === "promoted").map((entry) => Date.parse(entry.createdAt))));
    clock = promotedAt + HYPOTHESIS_MIN_RESIDENCY_MS + 1;
    const challenger = store.create("case_1", { runId: "run_1", statement: "Near boundary", basedOnFactIds: [], priorityScore: 50 + HYPOTHESIS_ACTIVATION_MARGIN - 1 });

    expect(scheduler.rebalance("case_1", "run_1").promoted).not.toContain(challenger.id);
  });

  it("lets strong evidence take a slot immediately through the fast track", () => {
    const store = new HypothesisStore(createDb(":memory:"));
    const scheduler = new HypothesisScheduler(store);
    for (let index = 0; index < 5; index += 1) store.create("case_1", { runId: "run_1", statement: `Incumbent ${index}`, basedOnFactIds: [], priorityScore: 60 + index });
    scheduler.rebalance("case_1", "run_1");
    const challenger = store.create("case_1", {
      runId: "run_1", statement: "Critical evidence", basedOnFactIds: ["fact_critical"],
      scoreFactors: { impact: 95, evidenceStrength: 95, verificationCost: 10, operationRisk: 10, pathRelevance: 90, freshness: 100 },
    });

    expect(isFastTrackHypothesis({ ...challenger, priorityScore: scoreHypothesis(challenger.scoreFactors ?? {}) })).toBe(true);
    const result = scheduler.rebalance("case_1", "run_1");
    expect(result.promoted).toContain(challenger.id);
    expect(store.getById(challenger.id)?.auditTrail.at(-1)?.reason).toContain("Fast-track");
  });

  it("keeps a small active set when hypotheses lack evidence and executable tasks", () => {
    const store = new HypothesisStore(createDb(":memory:"));
    const scheduler = new HypothesisScheduler(store);
    for (let index = 0; index < 5; index += 1) {
      store.create("case_1", { runId: "run_1", statement: `Early idea ${index}`, basedOnFactIds: [], priorityScore: 40 + index });
    }

    const result = scheduler.rebalance("case_1", "run_1");
    expect(result.capacity).toBe(2);
    expect(result.active).toHaveLength(2);
    expect(result.capacityReason).toContain("0 evidence- or task-supported");
  });

  it("contracts capacity under running-task and high-risk pressure", () => {
    const db = createDb(":memory:");
    const store = new HypothesisStore(db);
    const tasks = new TaskStore(db);
    const hypotheses = Array.from({ length: 5 }, (_, index) => store.create("case_1", {
      runId: "run_1",
      statement: `Mature idea ${index}`,
      basedOnFactIds: [`fact_${index}`],
      scoreFactors: {
        impact: 90,
        evidenceStrength: 90,
        verificationCost: 20,
        operationRisk: index < 2 ? 85 : 30,
        pathRelevance: 85,
        freshness: 90,
      },
    }));
    tasks.create("case_1", {
      runId: "run_1", title: "Execute controlled replay", status: "running", reason: "Validation in progress",
      blockedBy: [], triggerWhen: [], relatedFacts: ["fact_0"], hypothesisIds: [hypotheses[0].id], priority: "high",
    });
    const scheduler = new HypothesisScheduler(store, { tasks });

    const result = scheduler.rebalance("case_1", "run_1");
    expect(result.capacity).toBe(3);
    expect(result.active).toHaveLength(3);
    expect(result.capacityReason).toContain("running task");
    expect(result.capacityReason).toContain("high-risk hypotheses");
  });

  it("blocks a dependent hypothesis until every prerequisite is confirmed", () => {
    const store = new HypothesisStore(createDb(":memory:"));
    const prerequisite = store.create("case_1", {
      runId: "run_1", statement: "Authentication boundary is reachable", basedOnFactIds: ["fact_1"], priorityScore: 50,
    });
    const dependent = store.create("case_1", {
      runId: "run_1", statement: "Boundary can be bypassed", basedOnFactIds: ["fact_2"], priorityScore: 95,
      relations: { prerequisiteIds: [prerequisite.id], derivedFromIds: [prerequisite.id] },
    });
    const alternative = store.create("case_1", {
      runId: "run_1", statement: "Alternative path", basedOnFactIds: ["fact_3"], priorityScore: 60,
    });
    const scheduler = new HypothesisScheduler(store);

    expect(scheduler.rebalance("case_1", "run_1").active.map((item) => item.id)).not.toContain(dependent.id);
    expect(store.getById(dependent.id)?.auditTrail.some((entry) =>
      entry.kind === "relationship_blocked" && entry.reason.includes(prerequisite.id))).toBe(true);
    const blockedAuditLength = store.getById(dependent.id)?.auditTrail.length;
    scheduler.rebalance("case_1", "run_1");
    expect(store.getById(dependent.id)?.auditTrail).toHaveLength(blockedAuditLength ?? 0);
    store.update(prerequisite.id, { status: "confirmed" }, { reason: "Confirmed by evidence.", kind: "confirmed" });
    const afterConfirmation = scheduler.rebalance("case_1", "run_1");
    expect(afterConfirmation.active.map((item) => item.id)).toContain(dependent.id);
    expect(afterConfirmation.active.map((item) => item.id)).toContain(alternative.id);
    expect(store.getById(dependent.id)?.auditTrail.some((entry) =>
      entry.kind === "relationship_unblocked")).toBe(true);
  });

  it("never keeps mutually conflicting hypotheses active together", () => {
    const store = new HypothesisStore(createDb(":memory:"));
    const incumbent = store.create("case_1", {
      runId: "run_1", statement: "Token is scoped per tenant", basedOnFactIds: ["fact_1"], priorityScore: 70,
    });
    const challenger = store.create("case_1", {
      runId: "run_1", statement: "Token is globally reusable", basedOnFactIds: ["fact_2"], priorityScore: 95,
      relations: { conflictIds: [incumbent.id] },
    });
    const scheduler = new HypothesisScheduler(store);
    const result = scheduler.rebalance("case_1", "run_1");
    const activeIds = new Set(result.active.map((item) => item.id));

    expect(activeIds.has(incumbent.id) && activeIds.has(challenger.id)).toBe(false);
    expect(activeIds.has(challenger.id)).toBe(true);
  });

  it("blocks and safely resumes a linked task when its hypothesis gate changes", () => {
    const db = createDb(":memory:");
    const store = new HypothesisStore(db);
    const tasks = new TaskStore(db);
    const prerequisite = store.create("case_1", {
      runId: "run_1", statement: "Privileged route is reachable", basedOnFactIds: ["fact_1"],
    });
    const dependent = store.create("case_1", {
      runId: "run_1", statement: "Route permits an authorization bypass", basedOnFactIds: ["fact_2"],
      relations: { prerequisiteIds: [prerequisite.id] },
    });
    const task = tasks.create("case_1", {
      runId: "run_1", title: "Replay privileged request", status: "approved", reason: "Operator approved controlled replay.",
      blockedBy: [], triggerWhen: [], relatedFacts: ["fact_2"], hypothesisIds: [dependent.id], priority: "high",
    });
    const scheduler = new HypothesisScheduler(store, { tasks });

    const blocked = scheduler.rebalance("case_1", "run_1");
    expect(blocked.blockedTaskIds).toEqual([task.id]);
    expect(tasks.getById(task.id)).toMatchObject({
      status: "blocked",
      relationshipGate: { blockedHypothesisIds: [dependent.id], resumeStatus: "approved" },
    });

    store.update(prerequisite.id, { status: "confirmed" }, { kind: "confirmed", reason: "Route observed." });
    const resumed = scheduler.rebalance("case_1", "run_1");
    expect(resumed.resumedTaskIds).toEqual([task.id]);
    expect(tasks.getById(task.id)).toMatchObject({
      status: "approved",
      reason: "Operator approved controlled replay.",
      relationshipGate: null,
    });
  });

  it("waits for every linked hypothesis gate and never interrupts a running task", () => {
    const db = createDb(":memory:");
    const store = new HypothesisStore(db);
    const tasks = new TaskStore(db);
    const firstPrerequisite = store.create("case_1", {
      runId: "run_1", statement: "First boundary", basedOnFactIds: ["fact_1"],
    });
    const secondPrerequisite = store.create("case_1", {
      runId: "run_1", statement: "Second boundary", basedOnFactIds: ["fact_2"],
    });
    const firstDependent = store.create("case_1", {
      runId: "run_1", statement: "First dependent", basedOnFactIds: ["fact_3"],
      relations: { prerequisiteIds: [firstPrerequisite.id] },
    });
    const secondDependent = store.create("case_1", {
      runId: "run_1", statement: "Second dependent", basedOnFactIds: ["fact_4"],
      relations: { prerequisiteIds: [secondPrerequisite.id] },
    });
    const task = tasks.create("case_1", {
      runId: "run_1", title: "In-flight correlated validation", status: "running", reason: "Lease already acquired.",
      blockedBy: [], triggerWhen: [], relatedFacts: [], hypothesisIds: [firstDependent.id, secondDependent.id], priority: "high",
    });
    const scheduler = new HypothesisScheduler(store, { tasks });

    scheduler.rebalance("case_1", "run_1");
    expect(tasks.getById(task.id)).toMatchObject({
      status: "running",
      relationshipGate: { blockedHypothesisIds: [firstDependent.id, secondDependent.id], resumeStatus: null },
    });
    store.update(firstPrerequisite.id, { status: "confirmed" }, { kind: "confirmed", reason: "First confirmed." });
    scheduler.rebalance("case_1", "run_1");
    expect(tasks.getById(task.id)?.relationshipGate?.blockedHypothesisIds).toEqual([secondDependent.id]);
    expect(tasks.getById(task.id)?.status).toBe("running");
    store.update(secondPrerequisite.id, { status: "confirmed" }, { kind: "confirmed", reason: "Second confirmed." });
    scheduler.rebalance("case_1", "run_1");
    expect(tasks.getById(task.id)).toMatchObject({ status: "running", reason: "Lease already acquired.", relationshipGate: null });
  });
});
