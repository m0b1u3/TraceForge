import { describe, expect, it } from "vitest";
import { nextObserverStatus, observerIntervention, validatedObserverLevel } from "./observer-policy.js";

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
    expect(nextObserverStatus("detected", "critical")).toBe("correcting");
    expect(nextObserverStatus("correcting", "critical")).toBe("escalated");
    expect(nextObserverStatus("escalated", "critical")).toBe("escalated");
    expect(nextObserverStatus("correcting", "warning")).toBe("detected");
  });

  it("maps lifecycle states to steering and pause decisions", () => {
    const warning = { title: "Unsafe destructive action", suggestedGoal: "Collect evidence first", suggestedAction: "Stop deletion" };
    expect(observerIntervention({ ...warning, status: "correcting" })).toEqual({ steering: "Collect evidence first" });
    expect(observerIntervention({ ...warning, status: "escalated" })).toEqual({
      pauseReason: "escalated observer warning: Unsafe destructive action",
    });
    expect(observerIntervention({ ...warning, status: "detected" })).toEqual({});
  });
});
