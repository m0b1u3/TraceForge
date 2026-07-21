import { describe, expect, it } from "vitest";
import type { ValidationWorkflowSnapshot } from "../../api.js";
import { validationWorkflowTone } from "./ValidationWorkflow.js";

const snapshot = (patch: Partial<ValidationWorkflowSnapshot> = {}): ValidationWorkflowSnapshot => ({
  caseId: "case-1", runId: null, generatedAt: "2026-07-21T00:00:00.000Z", runningLease: null, leader: null,
  exploration: { consecutiveValidationShifts: 0, explorationBoundariesRemaining: 0 }, items: [], auditIssues: [], ...patch,
});

describe("validation workflow presentation", () => {
  it("prioritizes consistency issues over other workflow signals", () => {
    expect(validationWorkflowTone(snapshot({ runningLease: "task-1", auditIssues: [{ taskId: "task-2", status: "open", issue: "inconsistent" }] }))).toBe("danger");
  });

  it("surfaces missing evidence before an active lease", () => {
    expect(validationWorkflowTone(snapshot({ runningLease: "task-1", items: [{
      findingId: "finding-1", findingTitle: "SQL injection", findingStatus: "candidate", consensusStatus: "contested",
      confidence: 0.7, taskId: "task-1", taskStatus: "running", priorityScore: 82, priorityReasons: [], completionReady: false,
      missingEvidence: ["independent reproduction"], feedback: null,
    }] }))).toBe("warning");
  });
});
