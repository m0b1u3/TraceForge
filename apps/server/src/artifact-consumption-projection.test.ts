import { describe, expect, it } from "vitest";
import type { TimelineEntry } from "@traceforge/shared";
import { projectArtifactConsumptions } from "./artifact-consumption-projection.js";

function entry(
  id: string,
  eventType: string,
  detail: string,
  taskId = "task_1",
): TimelineEntry {
  return {
    id,
    caseId: "case_1",
    runId: "run_1",
    eventType,
    refId: taskId,
    detail,
    createdAt: `2026-01-01T00:00:0${id.at(-1)}.000Z`,
  };
}

describe("artifact consumption projection", () => {
  it("rebuilds pending, replan, and consumed states from persisted timeline events", () => {
    const linked = entry(
      "event_1",
      "artifact_evidence_linked",
      "Artifact=artifact_1; task=task_1; facts=fact_1,fact_2; findings=1",
    );
    const pending = projectArtifactConsumptions("case_1", [linked]);
    expect(pending).toEqual([expect.objectContaining({
      artifactId: "artifact_1",
      taskId: "task_1",
      factIds: ["fact_1", "fact_2"],
      status: "pending",
    })]);

    const replanned = projectArtifactConsumptions("case_1", [
      linked,
      entry(
        "event_2",
        "evidence_consumption_replan_requested",
        "Task=task_1; facts=fact_1,fact_2; missedActions=2",
      ),
    ]);
    expect(replanned[0]).toEqual(expect.objectContaining({
      status: "replan_requested",
      missedActions: 2,
    }));

    const consumed = projectArtifactConsumptions("case_1", [
      linked,
      entry(
        "event_2",
        "evidence_consumption_replan_requested",
        "Task=task_1; facts=fact_1,fact_2; missedActions=2",
      ),
      entry(
        "event_3",
        "evidence_consumed",
        "Task=task_1; tool=http_replay; facts=fact_2",
      ),
    ]);
    expect(consumed[0]).toEqual(expect.objectContaining({
      status: "consumed",
      usedByTool: "http_replay",
      lastEventId: "event_3",
    }));
  });

  it("closes only unresolved tracking and preserves a consumed result", () => {
    const linked = entry(
      "event_1",
      "artifact_evidence_linked",
      "Artifact=artifact_1; task=task_1; facts=fact_1; findings=1",
    );
    const closedPending = projectArtifactConsumptions("case_1", [
      linked,
      entry("event_2", "evidence_consumption_tracking_closed", "Task=task_1"),
    ]);
    expect(closedPending[0].status).toBe("closed");

    const consumed = projectArtifactConsumptions("case_1", [
      linked,
      entry("event_2", "evidence_consumed", "Task=task_1; tool=navigate; facts=fact_1"),
      entry("event_3", "evidence_consumption_tracking_closed", "Task=task_1"),
    ]);
    expect(consumed[0].status).toBe("consumed");
  });
});
