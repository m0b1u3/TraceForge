import { describe, expect, it } from "vitest";
import { createDb } from "./db/client.js";
import { ActionCardStore } from "./stores/action-store.js";
import { FactStore } from "./stores/fact-store.js";
import { HypothesisStore } from "./stores/hypothesis-store.js";
import { TaskStore } from "./stores/task-store.js";
import { TimelineStore } from "./stores/timeline-store.js";
import { TrafficStore } from "./stores/traffic-store.js";
import { ValidationConclusionStore } from "./stores/validation-conclusion-store.js";
import { ValidationConsensusStore } from "./stores/validation-consensus-store.js";
import { makeRecordValidationConclusionTool } from "./validation-conclusion-tool.js";

describe("validation conclusion lifecycle with real SQLite", () => {
  it("persists every verdict, advances supported candidates, and reopens refuted verified findings", async () => {
    const db = createDb(":memory:");
    const facts = new FactStore(db);
    const hypotheses = new HypothesisStore(db);
    const tasks = new TaskStore(db);
    const actions = new ActionCardStore(db);
    const traffic = new TrafficStore(db);
    const conclusions = new ValidationConclusionStore(db);
    const consensus = new ValidationConsensusStore(db);
    const timeline = new TimelineStore(db);
    const evidence = facts.create("case_1", {
      type: "http_observation", title: "Order response", value: { orderId: 42 },
      source: { type: "traffic", ref: "baseline" }, confidence: 1, tags: ["idor"],
    });
    const hypothesis = hypotheses.create("case_1", {
      runId: "run_1", statement: "Order ownership is not enforced",
      basedOnFactIds: [evidence.id], status: "active",
    });
    const task = tasks.create("case_1", {
      runId: "run_1", title: "Compare identities", status: "done", reason: "captured",
      blockedBy: [], triggerWhen: [], relatedFacts: [evidence.id],
      hypothesisIds: [hypothesis.id], priority: "high",
    });
    const action = actions.create({
      id: "action_compare", caseId: "case_1", title: "Replay as Bob", goal: "Validate IDOR",
      evidenceRefs: [evidence.id], hypothesisRefs: [hypothesis.id], taskRefs: [task.id],
      reasoning: "single identity variable", steps: ["replay"], expectedResults: ["denied"],
      riskNotes: [], tool: "compare_identity_traffic", priority: "high",
      requiresHumanApproval: false, status: "succeeded", createdAt: "now", updatedAt: "now",
    });
    const finding = facts.create("case_1", {
      type: "finding", title: "Order IDOR", value: { severity: "high" },
      source: { type: "agent", ref: "run_1" }, confidence: 0.8, tags: ["idor"],
      evidenceRefs: [evidence.id], hypothesisIds: [hypothesis.id],
      taskIds: [task.id], actionIds: [action.id], observations: [],
    });
    const now = new Date().toISOString();
    for (const entry of [
      { id: "baseline", status: 200, body: "{\"order\":{\"id\":42,\"secret\":\"x\"}}" },
      { id: "variant", status: 200, body: "{\"order\":{\"id\":42,\"secret\":\"x\"}}" },
      { id: "denied", status: 403, body: "{\"error\":\"forbidden\"}" },
    ]) {
      traffic.add({
        id: entry.id, caseId: "case_1", identityId: entry.id === "baseline" ? "alice" : "bob",
        url: "https://target.test/api/orders/42", method: "GET", requestHeaders: {},
        requestBody: null, responseStatus: entry.status, responseBody: entry.body,
        responseSize: entry.body.length, createdAt: now,
      });
    }
    const events: string[] = [];
    const tool = makeRecordValidationConclusionTool({
      caseId: "case_1", runId: "run_2", facts, traffic, conclusions, consensus, timeline, tasks,
      emit: (event) => events.push(event.type),
    });

    const supported = await tool.execute({
      findingId: finding.id,
      gapId: `gap:${finding.id}:observation`,
      baselineTrafficId: "baseline",
      variantTrafficId: "variant",
      protectedFields: ["order.id", "order.secret"],
      identityId: "bob",
    });
    expect(supported.ok).toBe(true);
    expect(facts.getById(finding.id)?.findingStatus).toBe("validating");
    expect(facts.getById(finding.id)?.observations).toHaveLength(1);

    facts.update(finding.id, {
      findingStatus: "verified",
      verificationSummary: "Controlled identity comparison exposed the same protected order.",
    });
    const refuted = await tool.execute({
      findingId: finding.id,
      gapId: `gap:${finding.id}:recheck`,
      baselineTrafficId: "baseline",
      variantTrafficId: "denied",
      protectedFields: ["order.secret"],
      identityId: "bob",
    });
    expect(refuted.ok).toBe(true);
    expect(facts.getById(finding.id)?.findingStatus).toBe("needs_review");
    expect(conclusions.listByCase("case_1").map((item) => item.verdict)).toEqual(["supports", "refutes"]);
    expect(consensus.listByCase("case_1")[0].status).toBe("conflicted");
    const repeated = await tool.execute({
      findingId: finding.id,
      gapId: `gap:${finding.id}:recheck`,
      baselineTrafficId: "baseline",
      variantTrafficId: "denied",
      protectedFields: ["order.secret"],
      identityId: "bob",
    });
    expect(repeated.ok).toBe(true);
    const followups = tasks.listByCase("case_1").filter((item) => item.title.startsWith(`[Consensus:${finding.id}:`));
    expect(followups).toHaveLength(2);
    expect(followups.filter((item) => item.status === "open")).toHaveLength(1);
    expect(followups.find((item) => item.status === "open")?.title).toContain("conflicted");
    expect(events).toContain("fact_updated");
    expect(timeline.listByCase("case_1").filter((item) => item.eventType === "validation_conclusion_recorded")).toHaveLength(3);
  });
});
