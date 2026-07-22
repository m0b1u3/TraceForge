// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { ValidationWorkflowSnapshot } from "@traceforge/shared";
import { ValidationRunSummary, validationRunSummaryModel } from "./ValidationRunSummary.js";
import { useStore } from "../../store.js";

// @ts-expect-error enable React act in jsdom tests
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const initialState = useStore.getState();
const task = { id: "task_1", caseId: "case_1", title: "Verify order authorization", status: "running", reason: "", blockedBy: [], triggerWhen: [], relatedFacts: [], priority: "high", createdAt: "now", updatedAt: "now", updateCount: 0 } as const;
const snapshot: ValidationWorkflowSnapshot = {
  caseId: "case_1", runId: "run_1", revision: 3, generatedAt: "now", runningLease: "task_1", leader: { taskId: "task_1", score: 91 },
  exploration: { consecutiveValidationShifts: 2, explorationBoundariesRemaining: 3 },
  items: [{ findingId: "finding_1", findingTitle: "Order IDOR", findingStatus: "validating", consensusStatus: "insufficient", confidence: .8, taskId: "task_1", taskStatus: "running", priorityScore: 91, priorityReasons: [], completionReady: false, missingEvidence: ["independent replay"], feedback: null }], auditIssues: [],
};

afterEach(() => useStore.setState(initialState, true));

describe("ValidationRunSummary", () => {
  it("derives a compact operational summary from the current workflow", () => {
    expect(validationRunSummaryModel(snapshot, [task], "live")).toEqual({
      lease: { id: "task_1", label: "Verify order authorization" },
      leader: { id: "task_1", label: "Order IDOR", score: 91 },
      evidence: { ready: 0, total: 1, missing: 1 },
      explorationBoundaries: 3,
      syncStatus: "live",
    });
    expect(validationRunSummaryModel(null, [task], "stale")).toBeNull();
  });

  it("exposes progress semantics and locates the active lease", async () => {
    useStore.setState({ validationWorkflow: snapshot, validationSyncStatus: "live", tasks: [task] });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(createElement(ValidationRunSummary)));

    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("0");
    expect(container.textContent).toContain("Order IDOR");
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label^="Lease:"]')?.click());
    expect(useStore.getState().activeTab).toBe("tasks");
    expect(useStore.getState().knowledgeTarget).toEqual(expect.objectContaining({ id: "task_1" }));

    await act(async () => root.unmount());
    container.remove();
  });
});
