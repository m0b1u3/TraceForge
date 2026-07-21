import { describe, expect, it } from "vitest";
import { AttackPathSchema, FactSchema, TaskSchema } from "@traceforge/shared";
import type { ValidationConsensusResult } from "./validation-consensus.js";
import { rankValidationTasks } from "./validation-task-priority.js";

const now = "2026-07-21T00:00:00.000Z";
const finding = (id: string, severity: string) => FactSchema.parse({
  id, caseId: "case_1", type: "finding", title: `${severity} finding`, value: { severity },
  source: { type: "agent", ref: "run_1" }, confidence: 1, tags: [], validity: "valid",
  findingStatus: "validating", evidenceRefs: [`evidence_${id}`], hypothesisIds: [`hyp_${id}`],
  taskIds: [`origin_${id}`], actionIds: [`action_${id}`], observations: [], createdAt: now, updatedAt: now,
});
const task = (id: string, title: string, priority: "low" | "medium" | "high") => TaskSchema.parse({
  id, caseId: "case_1", runId: "run_2", title, priority, status: "open", reason: "",
  blockedBy: [], triggerWhen: ["controlled replay"], relatedFacts: [], hypothesisIds: ["hyp"], createdAt: now, updatedAt: now,
});
const consensus = (findingId: string, status: ValidationConsensusResult["status"]): ValidationConsensusResult => ({
  findingId, status, independentSupports: 0, independentRefutes: 0, inconclusive: 0, duplicatesExcluded: 0,
  confidence: 0.5, recommendation: "collect_more", evidenceGroups: [], rationale: [],
});

describe("validation task priority", () => {
  it("ranks critical conflicted validation ahead of ordinary high-priority work", () => {
    const critical = finding("fact_critical", "critical");
    const ranked = rankValidationTasks({
      tasks: [task("ordinary", "Explore another endpoint", "high"), task("critical", `[Consensus:${critical.id}:conflicted] isolate variable`, "high")],
      facts: [critical], consensus: [consensus(critical.id, "conflicted")], paths: [],
    });
    expect(ranked.map((item) => item.task.id)).toEqual(["critical", "ordinary"]);
    expect(ranked[0].reasons).toContain("severity:critical");
    expect(ranked[0].reasons).toContain("consensus:conflicted");
  });

  it("uses active attack-path relevance to break otherwise equivalent validation priorities", () => {
    const linked = finding("fact_linked", "high");
    const unlinked = finding("fact_unlinked", "high");
    const path = AttackPathSchema.parse({
      id: "path_1", caseId: "case_1", title: "Account takeover", objective: "take over account",
      status: "validated", confidence: 0.9, findingFactIds: [linked.id], hypothesisIds: [],
      steps: [{ id: "step_1", order: 1, kind: "exploit", title: "Exploit IDOR" }], createdAt: now, updatedAt: now,
    });
    const ranked = rankValidationTasks({
      tasks: [task("unlinked", `[Consensus:${unlinked.id}:insufficient] collect evidence`, "high"), task("linked", `[Consensus:${linked.id}:insufficient] collect evidence`, "high")],
      facts: [linked, unlinked], consensus: [consensus(linked.id, "insufficient"), consensus(unlinked.id, "insufficient")], paths: [path],
    });
    expect(ranked[0].task.id).toBe("linked");
    expect(ranked[0].reasons).toContain("attack-path:validated");
  });
});
