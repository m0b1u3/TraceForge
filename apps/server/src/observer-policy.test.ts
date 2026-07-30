import { describe, expect, it } from "vitest";
import {
  initialObserverStatus,
  nextObserverStatus,
  observerFingerprint,
  observerIntervention,
  observerCorrectionStrategyIsNovel,
  validatedObserverLevel,
} from "./observer-policy.js";

describe("Observer critical evidence policy", () => {
  const base = {
    level: "critical" as const,
    evidence: "Fact fact_1 proves the dangerous action remains unsupported.",
    relatedFacts: ["fact_1"],
    relatedTasks: [],
  };

  it("requires evidence and at least one valid Fact or Task reference", () => {
    expect(validatedObserverLevel(base, new Set(["fact_1"]), new Set())).toBe("critical");
    expect(validatedObserverLevel({ ...base, relatedFacts: [] }, new Set(), new Set())).toBe("warning");
    expect(validatedObserverLevel({ ...base, evidence: "" }, new Set(["fact_1"]), new Set())).toBe("warning");
    expect(validatedObserverLevel(base, new Set(), new Set())).toBe("warning");
  });

  it("opens one correction window before escalation", () => {
    expect(initialObserverStatus("info")).toBe("detected");
    expect(initialObserverStatus("warning")).toBe("detected");
    expect(initialObserverStatus("critical")).toBe("correcting");
    expect(nextObserverStatus("detected", "critical")).toBe("correcting");
    expect(nextObserverStatus("correcting", "critical")).toBe("escalated");
    expect(nextObserverStatus("escalated", "critical")).toBe("escalated");
    expect(nextObserverStatus("correcting", "warning")).toBe("detected");
  });

  it("maps lifecycle states to steering and pause decisions", () => {
    const warning = {
      level: "critical" as const,
      title: "Unsafe destructive action",
      suggestedGoal: "[Observer correction]\nCollect evidence first",
      suggestedAction: "Stop deletion",
    };
    expect(observerIntervention({ ...warning, status: "correcting" })).toEqual({ steering: "Collect evidence first" });
    expect(observerIntervention({ ...warning, status: "escalated" })).toEqual({
      pauseReason: "escalated observer warning: Unsafe destructive action",
    });
    expect(observerIntervention({ ...warning, status: "escalated" }, { allowPause: false })).toEqual({
      steering: "Collect evidence first",
    });
    expect(observerIntervention({ ...warning, status: "detected" })).toEqual({
      steering: "Collect evidence first",
    });
    expect(observerIntervention({ ...warning, level: "info", status: "detected" })).toEqual({});
  });

  it("uses a generic structured identity instead of sample-specific title rewriting", () => {
    const first = {
      issueType: "repeated_failure" as const,
      subject: "task:task_1/tool:analyze",
      title: "First wording",
      relatedFacts: [],
      relatedTasks: ["task_1"],
    };
    expect(observerFingerprint(first)).toBe(observerFingerprint({ ...first, title: "Completely different wording" }));
    expect(observerFingerprint(first)).not.toBe(observerFingerprint({
      ...first,
      subject: "task:task_2/tool:analyze",
      relatedTasks: ["task_2"],
    }));
  });

  it("blocks repeated correction wording while allowing a materially different strategy", () => {
    expect(observerCorrectionStrategyIsNovel(
      "Inspect the current evidence chain before continuing.",
      "Inspect the current evidence chain before continuing.",
    )).toBe(false);
    expect(observerCorrectionStrategyIsNovel(
      "Inspect the current evidence chain before continuing.",
      "Inspect the current evidence chain before continuing, then record the result.",
    )).toBe(false);
    expect(observerCorrectionStrategyIsNovel(
      "Repeat the same execution with the same input.",
      "Create an independent causal check and compare the resulting evidence.",
    )).toBe(true);
  });
});
