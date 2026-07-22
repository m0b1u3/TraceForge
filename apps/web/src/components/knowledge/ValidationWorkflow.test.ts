import { describe, expect, it } from "vitest";
import type { Task, ValidationWorkflowItem, ValidationWorkflowSnapshot } from "@traceforge/shared";
import { groupValidationWorkflowItems, validationNavigationTarget, visibleValidationGroupItems } from "./ValidationWorkflow.js";
import { deriveValidationPresentation, validationSyncLabel } from "../../lib/validation-presentation.js";

const snapshot = (patch: Partial<ValidationWorkflowSnapshot> = {}): ValidationWorkflowSnapshot => ({
  caseId: "case-1", runId: null, revision: 0, generatedAt: "2026-07-21T00:00:00.000Z", runningLease: null, leader: null,
  exploration: { consecutiveValidationShifts: 0, explorationBoundariesRemaining: 0 }, items: [], auditIssues: [], ...patch,
});
const item = (findingId: string, patch: Partial<ValidationWorkflowItem> = {}): ValidationWorkflowItem => ({
  findingId, findingTitle: findingId, findingStatus: "candidate", consensusStatus: "insufficient", confidence: 0.5,
  taskId: `task-${findingId}`, taskStatus: "open", priorityScore: 50, priorityReasons: [], completionReady: false,
  missingEvidence: [], feedback: null, ...patch,
});
const task = (id: string): Task => ({ id, caseId: "case-1", title: id, status: "open", reason: "", blockedBy: [], triggerWhen: [], relatedFacts: [], priority: "medium", createdAt: "now", updatedAt: "now", updateCount: 0 });

describe("validation workflow presentation", () => {
  it("prioritizes consistency issues over other workflow signals", () => {
    expect(deriveValidationPresentation(snapshot({ runningLease: "task-1", auditIssues: [{ taskId: "task-2", status: "open", issue: "inconsistent" }] }), [task("task-1")], "live").tone).toBe("danger");
  });

  it("surfaces missing evidence before an active lease", () => {
    expect(deriveValidationPresentation(snapshot({ runningLease: "task-1", items: [{
      findingId: "finding-1", findingTitle: "SQL injection", findingStatus: "candidate", consensusStatus: "contested",
      confidence: 0.7, taskId: "task-1", taskStatus: "running", priorityScore: 82, priorityReasons: [], completionReady: false,
      missingEvidence: ["independent reproduction"], feedback: null,
    }] }), [task("task-1")], "live").tone).toBe("warning");
  });

  it("resolves finding navigation without inventing missing task ids", () => {
    expect(validationNavigationTarget({ findingId: "finding-1", taskId: "task-1" }, "finding")).toEqual({ kind: "finding", id: "finding-1" });
    expect(validationNavigationTarget({ findingId: "finding-1", taskId: null }, "task")).toBeNull();
  });

  it("uses explicit transport trust labels", () => {
    expect([validationSyncLabel("live"), validationSyncLabel("recovering"), validationSyncLabel("stale")]).toEqual(["Live", "Recovering", "Stale"]);
  });

  it("groups operational states before evidence and completion work", () => {
    const groups = groupValidationWorkflowItems([
      item("ready", { completionReady: true }),
      item("gap", { missingEvidence: ["reproduction"] }),
      item("lead", { priorityScore: 90 }),
      item("run", { taskStatus: "running" }),
    ], "task-run", "task-lead");
    expect(groups.map((group) => group.key)).toEqual(["running", "leader", "evidence", "ready"]);
  });

  it("keeps equal-priority items stable when confidence changes", () => {
    const before = groupValidationWorkflowItems([item("b", { confidence: 0.2 }), item("a", { confidence: 0.8 })], null)[0].items.map((entry) => entry.findingId);
    const after = groupValidationWorkflowItems([item("b", { confidence: 0.99 }), item("a", { confidence: 0.1 })], null)[0].items.map((entry) => entry.findingId);
    expect(after).toEqual(before);
    expect(after).toEqual(["a", "b"]);
  });

  it("never hides active work and preserves changed findings in collapsed groups", () => {
    const items = [item("a"), item("b"), item("c")];
    expect(visibleValidationGroupItems("running", items, { collapsed: true, limit: 1, changedFindingIds: [] })).toEqual(items);
    expect(visibleValidationGroupItems("monitoring", items, { collapsed: true, limit: 1, changedFindingIds: ["c"] }).map((entry) => entry.findingId)).toEqual(["c"]);
    expect(visibleValidationGroupItems("evidence", items, { collapsed: false, limit: 1, changedFindingIds: ["c"] }).map((entry) => entry.findingId)).toEqual(["a", "c"]);
  });
});
