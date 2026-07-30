import { describe, expect, it } from "vitest";
import { ObserverCorrectionAttribution } from "./observer-correction-attribution.js";

function issue(tracker: ObserverCorrectionAttribution, relatedFacts: string[] = [], relatedTasks: string[] = []) {
  tracker.issue({ id: "warning_1", relatedFacts, relatedTasks });
}

describe("Observer correction attribution", () => {
  it("does not credit a warning disappearance without post-correction execution", () => {
    const tracker = new ObserverCorrectionAttribution();
    issue(tracker);

    expect(tracker.assess("warning_1")).toMatchObject({ attributed: false });
  });

  it("does not credit unrelated successful work", () => {
    const tracker = new ObserverCorrectionAttribution();
    issue(tracker, ["fact_relevant"]);
    tracker.observe({
      tool: "record_task",
      args: { id: "task_other" },
      ok: true,
      refs: { factIds: [], taskIds: ["task_other"], timelineEntryIds: ["timeline_1"] },
    });

    expect(tracker.assess("warning_1")).toMatchObject({ attributed: false });
  });

  it("credits a changed action that produces correction-linked evidence", () => {
    const tracker = new ObserverCorrectionAttribution();
    issue(tracker, [], ["task_relevant"]);
    tracker.observe({
      tool: "record_fact",
      args: { taskId: "task_relevant", title: "new observation" },
      ok: true,
      refs: { factIds: ["fact_new"], taskIds: ["task_relevant"], timelineEntryIds: ["timeline_1"] },
    });

    expect(tracker.assess("warning_1")).toMatchObject({ attributed: true });
  });

  it("credits recovery of an execution that failed after correction", () => {
    const tracker = new ObserverCorrectionAttribution();
    issue(tracker);
    const execution = { tool: "analysis_tool", args: { candidate: "first" }, refs: null };
    tracker.observe({ ...execution, ok: false });
    tracker.observe({ ...execution, ok: true });

    expect(tracker.assess("warning_1")).toMatchObject({ attributed: true });
  });

  it("requires a material result for a merely different successful action", () => {
    const tracker = new ObserverCorrectionAttribution();
    issue(tracker);
    tracker.observe({ tool: "analysis_tool", args: { candidate: "second" }, ok: true, refs: null });

    expect(tracker.assess("warning_1")).toMatchObject({ attributed: false });
  });

  it("does not credit one material result to multiple unrelated corrections", () => {
    const tracker = new ObserverCorrectionAttribution();
    tracker.issue({ id: "warning_1", relatedFacts: [], relatedTasks: [] });
    tracker.issue({ id: "warning_2", relatedFacts: [], relatedTasks: [] });
    tracker.observe({
      tool: "record_fact",
      args: { title: "one result" },
      ok: true,
      refs: { factIds: ["fact_1"], taskIds: [], timelineEntryIds: ["timeline_1"] },
    });

    expect(tracker.assess("warning_1")).toMatchObject({ attributed: true });
    expect(tracker.assess("warning_2")).toMatchObject({ attributed: false });
  });
});
