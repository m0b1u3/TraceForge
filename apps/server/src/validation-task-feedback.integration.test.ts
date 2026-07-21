import { describe, expect, it } from "vitest";
import { createDb } from "./db/client.js";
import { TimelineStore } from "./stores/timeline-store.js";
import { appendValidationFeedback, observeValidationOutcome, recoverValidationFeedback, summarizeValidationFeedbackHistory } from "./validation-task-feedback.js";

describe("validation task outcome feedback with real SQLite", () => {
  it("recognizes an updated existing evidence record without a count increase", () => {
    const observation = observeValidationOutcome({
      findingId: "fact_0", taskId: "task_0", tool: "record_fact", ok: true,
      before: { evidenceCount: 2, evidenceSignature: "fact:v1", consensusSignature: "same", attackPathSignature: "same" },
      after: { evidenceCount: 2, evidenceSignature: "fact:v2", consensusSignature: "same", attackPathSignature: "same" },
    });
    expect(observation.evidenceProduced).toBe(1);
    expect(observation.noProgress).toBe(false);
  });

  it("records, restores, and scores productive and repeated tool boundaries", () => {
    const productive = observeValidationOutcome({
      findingId: "fact_1", taskId: "task_1", tool: "record_validation_conclusion", ok: true,
      before: { evidenceCount: 2, evidenceSignature: "e2", consensusSignature: "insufficient", attackPathSignature: "v1" },
      after: { evidenceCount: 3, evidenceSignature: "e3", consensusSignature: "supported", attackPathSignature: "v1" },
    });
    const repeated = observeValidationOutcome({
      findingId: "fact_1", taskId: "task_1", tool: "replay_traffic", ok: true,
      before: { evidenceCount: 3, evidenceSignature: "e3", consensusSignature: "supported", attackPathSignature: "v1" },
      after: { evidenceCount: 3, evidenceSignature: "e3", consensusSignature: "supported", attackPathSignature: "v1" },
    });
    let history = appendValidationFeedback({}, productive);
    history = appendValidationFeedback(history, repeated);
    const db = createDb(":memory:");
    const timeline = new TimelineStore(db);
    for (const observation of history.fact_1) {
      timeline.append("case_1", "validation_feedback_recorded", JSON.stringify(observation), observation.taskId, "run_1");
    }

    const restored = recoverValidationFeedback(timeline.listByCase("case_1"));
    const summary = summarizeValidationFeedbackHistory(restored).fact_1;
    expect(summary.evidenceProduced).toBe(1);
    expect(summary.consensusAdvances).toBe(1);
    expect(summary.noProgress).toBe(1);
    expect(summary.scoreAdjustment).toBeGreaterThan(0);
  });

  it("penalizes repeated no-progress and failed validation work", () => {
    const observations = Array.from({ length: 6 }, (_, index) => observeValidationOutcome({
      findingId: "fact_2", taskId: "task_2", tool: `tool_${index}`, ok: index < 4,
      before: { evidenceCount: 1, evidenceSignature: "same", consensusSignature: "same", attackPathSignature: "same" },
      after: { evidenceCount: 1, evidenceSignature: "same", consensusSignature: "same", attackPathSignature: "same" },
    }));
    const history = observations.reduce(appendValidationFeedback, {});
    expect(summarizeValidationFeedbackHistory(history).fact_2.scoreAdjustment).toBeLessThan(0);
  });
});
