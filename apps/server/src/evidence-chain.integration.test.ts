import { describe, expect, it } from "vitest";
import { createDb } from "./db/client.js";
import { ActionCardStore } from "./stores/action-store.js";
import { FactStore } from "./stores/fact-store.js";
import { HypothesisStore } from "./stores/hypothesis-store.js";
import { TaskStore } from "./stores/task-store.js";

describe("evidence chain with real SQLite", () => {
  it("enforces candidate-to-validation-to-verified and downgrades conflicts", () => {
    const db = createDb(":memory:");
    const facts = new FactStore(db);
    const hypotheses = new HypothesisStore(db);
    const tasks = new TaskStore(db);
    const actions = new ActionCardStore(db);
    const evidence = facts.create("case_1", {
      sourceRunId: "run_1",
      type: "http_observation",
      title: "User A received user B order",
      value: { trafficId: "traffic_1", status: 200 },
      source: { type: "traffic", ref: "traffic_1" },
      confidence: 0.8,
      tags: ["idor"],
    });
    const hypothesis = hypotheses.create("case_1", {
      runId: "run_1",
      statement: "Order endpoint lacks an ownership check",
      basedOnFactIds: [evidence.id],
      status: "active",
    });
    const task = tasks.create("case_1", {
      runId: "run_1",
      title: "Compare the order request across two identities",
      status: "done",
      reason: "Controlled replay completed",
      blockedBy: [],
      triggerWhen: [],
      relatedFacts: [evidence.id],
      hypothesisIds: [hypothesis.id],
      priority: "high",
    });
    const action = actions.create({
      id: "action_1",
      caseId: "case_1",
      title: "Replay order request as user A",
      goal: "Validate horizontal privilege escalation",
      evidenceRefs: [evidence.id],
      hypothesisRefs: [hypothesis.id],
      taskRefs: [task.id],
      reasoning: "Identity is the controlled variable",
      steps: ["Replay the captured request with user A session"],
      expectedResults: ["Access should be denied"],
      riskNotes: [],
      tool: "http_replay",
      priority: "high",
      requiresHumanApproval: false,
      status: "succeeded",
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:00:00.000Z",
    });
    const finding = facts.create("case_1", {
      sourceRunId: "run_1",
      type: "finding",
      title: "Horizontal privilege escalation in order API",
      value: { endpoint: "/api/orders/42" },
      source: { type: "agent", ref: "run_1" },
      confidence: 0.8,
      tags: ["idor"],
      findingStatus: "candidate",
      evidenceRefs: [evidence.id],
      hypothesisIds: [hypothesis.id],
      taskIds: [task.id],
      actionIds: [action.id],
      observations: [],
    });

    expect(() => facts.update(finding.id, {
      findingStatus: "verified",
      verificationSummary: "Reproduced",
      observations: [{
        id: "obs_1",
        sourceType: "traffic",
        sourceRef: "traffic_1",
        runId: "run_1",
        identityId: "user_a",
        condition: "authenticated as user A",
        summary: "User A read user B order",
        observedAt: "2026-07-20T00:01:00.000Z",
      }],
    })).toThrow("invalid finding transition");

    facts.update(finding.id, { findingStatus: "validating" });
    const verified = facts.update(finding.id, {
      findingStatus: "verified",
      verificationSummary: "Baseline denied unrelated access; controlled cross-identity replay returned the protected order.",
      observations: [{
        id: "obs_1",
        sourceType: "traffic",
        sourceRef: "traffic_1",
        runId: "run_1",
        identityId: "user_a",
        condition: "authenticated as user A",
        summary: "User A read user B order",
        observedAt: "2026-07-20T00:01:00.000Z",
      }],
    });
    expect(verified?.findingStatus).toBe("verified");

    const conflicted = facts.update(finding.id, { validity: "conflicted" });
    expect(conflicted?.findingStatus).toBe("needs_review");
  });

  it("rejects a finding with dangling or incomplete references", () => {
    const facts = new FactStore(createDb(":memory:"));
    expect(() => facts.create("case_1", {
      sourceRunId: "run_1",
      type: "finding",
      title: "Unsupported finding",
      value: {},
      source: { type: "agent", ref: "run_1" },
      confidence: 0.2,
      tags: [],
      findingStatus: "candidate",
      evidenceRefs: ["fact_missing"],
      hypothesisIds: [],
      taskIds: [],
      actionIds: [],
      observations: [],
    })).toThrow("finding requires a Hypothesis reference");
  });
});
