import { describe, expect, it } from "vitest";
import { createDb } from "./db/client.js";
import { ActionCardStore } from "./stores/action-store.js";
import { AttackPathStore } from "./stores/attack-path-store.js";
import { FactStore } from "./stores/fact-store.js";
import { HypothesisStore } from "./stores/hypothesis-store.js";
import { IdentityStore } from "./stores/identity-store.js";
import { TaskStore } from "./stores/task-store.js";
import { buildSharedKnowledge } from "./shared-knowledge.js";

describe("cross-run shared knowledge with real SQLite", () => {
  it("injects trusted project knowledge and isolates conflicted, revoked, and current-run failures", () => {
    const db = createDb(":memory:");
    const facts = new FactStore(db);
    const hypotheses = new HypothesisStore(db);
    const tasks = new TaskStore(db);
    const actions = new ActionCardStore(db);
    const identities = new IdentityStore(db);
    const paths = new AttackPathStore(db);
    const evidence = facts.create("case_1", {
      sourceRunId: "run_1", type: "http_observation", title: "Cross-user order returned",
      value: { status: 200 }, source: { type: "traffic", ref: "traffic_1" }, confidence: 1, tags: ["idor"],
    });
    const hypothesis = hypotheses.create("case_1", { runId: "run_1", statement: "Ownership missing", basedOnFactIds: [evidence.id], status: "active" });
    const task = tasks.create("case_1", { runId: "run_1", title: "Replay", status: "done", reason: "done", blockedBy: [], triggerWhen: [], relatedFacts: [evidence.id], hypothesisIds: [hypothesis.id], priority: "high" });
    const action = actions.create({
      id: "action_1", caseId: "case_1", title: "Replay", goal: "Verify", evidenceRefs: [evidence.id], hypothesisRefs: [hypothesis.id], taskRefs: [task.id], reasoning: "control identity", steps: ["replay"], expectedResults: ["denied"], riskNotes: [], tool: "http_replay", priority: "high", requiresHumanApproval: false, status: "succeeded", createdAt: "now", updatedAt: "now",
    });
    const finding = facts.create("case_1", {
      sourceRunId: "run_1", type: "finding", title: "Verified order IDOR", value: { severity: "high" }, source: { type: "agent", ref: "run_1" }, confidence: 1, tags: ["idor"], findingStatus: "candidate", evidenceRefs: [evidence.id], hypothesisIds: [hypothesis.id], taskIds: [task.id], actionIds: [action.id], observations: [],
    });
    facts.update(finding.id, { findingStatus: "validating" });
    facts.update(finding.id, { findingStatus: "verified", verificationSummary: "Controlled cross-identity replay succeeded.", observations: [{ id: "obs_1", sourceType: "traffic", sourceRef: "traffic_1", runId: "run_1", condition: "user A", summary: "read user B order", observedAt: "now" }] });
    const unrelatedFinding = facts.create("case_1", { sourceRunId: "run_1", type: "finding", title: "Unrelated TLS configuration", value: { severity: "low" }, source: { type: "agent", ref: "run_1" }, confidence: 1, tags: ["tls"], findingStatus: "candidate", evidenceRefs: [evidence.id], hypothesisIds: [hypothesis.id], taskIds: [task.id], actionIds: [action.id], observations: [] });
    facts.update(unrelatedFinding.id, { findingStatus: "validating" });
    facts.update(unrelatedFinding.id, { findingStatus: "verified", verificationSummary: "TLS configuration observed.", observations: [{ id: "obs_tls", sourceType: "traffic", sourceRef: "traffic_1", runId: "run_1", condition: "TLS", summary: "configuration observed", observedAt: "now" }] });
    const conflicted = facts.create("case_1", { sourceRunId: "run_1", type: "credential", title: "Conflicted admin password", value: { password: "wrong" }, source: { type: "manual", ref: "note" }, confidence: 0.5, tags: [] });
    facts.update(conflicted.id, { validity: "conflicted" });
    const activeIdentity = identities.create("case_1", { name: "alice", kind: "user", status: "active", credentials: { username: "alice", password: "plain" }, headers: {}, cookies: [] });
    identities.create("case_1", { name: "unrelated-service", kind: "service", status: "active", credentials: {}, headers: {}, cookies: [] });
    identities.create("case_1", { name: "old", kind: "admin", status: "revoked", credentials: {}, headers: {}, cookies: [] });
    paths.create("case_1", { title: "User to order", objective: "Read another user's order", status: "exploring", confidence: 0.7, sourceRunId: "run_1", lastRunId: "run_1", entryIdentityId: activeIdentity.id, targetAssetFactId: evidence.id, findingFactIds: [], hypothesisIds: [hypothesis.id], evidenceRefs: [evidence.id], breakpoint: "Need write-impact check", steps: [{ id: "step_1", order: 0, kind: "access", title: "Authenticate", description: "", status: "observed", identityId: activeIdentity.id, trafficId: null, factIds: [evidence.id], taskId: null, actionId: null, prerequisiteStepIds: [], validation: "session observed" }] });
    paths.create("case_1", { title: "TLS inventory", objective: "Inventory TLS ciphers", status: "exploring", confidence: 0.9, sourceRunId: "run_1", lastRunId: "run_1", entryIdentityId: null, targetAssetFactId: evidence.id, findingFactIds: [], hypothesisIds: [hypothesis.id], evidenceRefs: [evidence.id], breakpoint: "Need cipher scan", steps: [{ id: "step_tls", order: 0, kind: "access", title: "Connect TLS", description: "", status: "observed", identityId: null, trafficId: null, factIds: [evidence.id], taskId: null, actionId: null, prerequisiteStepIds: [], validation: "connection observed" }] });

    const knowledge = buildSharedKnowledge({ facts: facts.listByCase("case_1"), identities: identities.listByCase("case_1"), attackPaths: paths.listByCase("case_1") }, "run_2", { goal: "validate order IDOR at /api/orders/42", phase: "validate", url: "/api/orders/42" });
    expect(knowledge.verifiedFindings[0]).toContain("Verified order IDOR");
    expect(knowledge.identities.join(" ")).toContain("alice");
    expect(knowledge.identities.join(" ")).not.toContain("old");
    expect(knowledge.identities[0]).toContain("alice");
    expect(knowledge.attackPaths[0]).toContain("User to order");
    expect(knowledge.excludedConflictCount).toBeGreaterThanOrEqual(1);
    expect(knowledge.injectedFactIds).toContain(finding.id);
    expect(knowledge.injectedKnowledgeRefs).toEqual(expect.arrayContaining([
      { id: finding.id, kind: "fact" },
      { id: activeIdentity.id, kind: "identity" },
    ]));

    const usageRanked = buildSharedKnowledge({
      facts: facts.listByCase("case_1"),
      identities: identities.listByCase("case_1"),
      attackPaths: paths.listByCase("case_1"),
      usageScores: new Map([[unrelatedFinding.id, {
        injected: 2,
        used: 2,
        positiveOutcome: 4,
        negativeOutcome: 0,
      }]]),
    }, "run_2");
    expect(usageRanked.verifiedFindings[0]).toContain("Unrelated TLS configuration");
  });
});
