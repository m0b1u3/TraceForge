import { describe, expect, it } from "vitest";
import { validationTimelineConsoleEvent } from "./validation-console.js";

describe("validation console events", () => {
  it("formats the operational validation events and ignores routine telemetry", () => {
    expect(validationTimelineConsoleEvent({ eventType: "validation_task_claimed", detail: "Task=task_1; consensus=insufficient" })).toEqual({ label: "Validation lease", text: "Claimed task_1 · consensus insufficient", target: { kind: "task", id: "task_1" } });
    expect(validationTimelineConsoleEvent({ eventType: "validation_task_completion_blocked", detail: "Task=task_1; missing=independent evidence" })?.text).toContain("missing independent evidence");
    expect(validationTimelineConsoleEvent({ eventType: "validation_priority_shifted", detail: "reason=score_hysteresis_exceeded; previous=task_1:70; next=task_2:88" })?.text).toContain("task_1:70 → task_2:88");
    expect(validationTimelineConsoleEvent({ eventType: "validation_priority_shifted", detail: "previous=task_1:70; next=task_2:88" })?.target).toEqual({ kind: "task", id: "task_2" });
    expect(validationTimelineConsoleEvent({ eventType: "validation_task_completed", detail: "Task=task_2; Finding=finding_4" })?.target).toEqual({ kind: "finding", id: "finding_4" });
    expect(validationTimelineConsoleEvent({ eventType: "validation_priority_deferred", detail: "validation=task_2; exploration=task_3; boundaries=3" })?.label).toBe("Exploration window");
    expect(validationTimelineConsoleEvent({ eventType: "validation_feedback_recorded", detail: "{}" })).toBeNull();
  });
});
