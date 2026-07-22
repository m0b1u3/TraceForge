import { describe, expect, it } from "vitest";
import type { Task, ValidationWorkflowSnapshot } from "@traceforge/shared";
import { deriveValidationPresentation } from "./validation-presentation.js";

const task = (id: string): Task => ({ id, caseId: "case_1", title: id, status: "running", reason: "", blockedBy: [], triggerWhen: [], relatedFacts: [], priority: "high", createdAt: "now", updatedAt: "now", updateCount: 0 });
const snapshot = (patch: Partial<ValidationWorkflowSnapshot> = {}): ValidationWorkflowSnapshot => ({
  caseId: "case_1", runId: "run_1", revision: 1, generatedAt: "now", runningLease: "task_1", leader: { taskId: "task_1", score: 80 },
  exploration: { consecutiveValidationShifts: 0, explorationBoundariesRemaining: 0 },
  items: [{ findingId: "finding_1", findingTitle: "IDOR", findingStatus: "validating", consensusStatus: "insufficient", confidence: .7, taskId: "task_1", taskStatus: "running", priorityScore: 80, priorityReasons: [], completionReady: false, missingEvidence: ["replay"], feedback: null }], auditIssues: [], ...patch,
});

describe("validation presentation selector", () => {
  it("keeps sync, diagnostic, evidence, and tone semantics in one derivation", () => {
    const presentation = deriveValidationPresentation(snapshot(), [task("task_1")], "live");
    expect(presentation).toEqual(expect.objectContaining({ syncLabel: "Live", tone: "warning", evidence: { ready: 0, total: 1, missing: 1 }, diagnostic: null, auditCount: 0 }));
  });

  it("prioritizes transport trust before referential and audit diagnostics", () => {
    const inconsistent = snapshot({ auditIssues: [{ taskId: "task_1", status: "running", issue: "inconsistent" }] });
    expect(deriveValidationPresentation(inconsistent, [], "stale").diagnostic?.kind).toBe("stale");
    expect(deriveValidationPresentation(inconsistent, [], "live").diagnostic?.kind).toBe("lease_missing");
    expect(deriveValidationPresentation(inconsistent, [task("task_1")], "live").diagnostic?.kind).toBe("audit");
  });
});
