import { describe, it, expect } from "vitest";
import {
  observerRecoveryRequiresDirection,
  observerWarningContinueDisabled,
  observerWarningGroup,
  observerWarningRunGoal,
  observerWarningStatusLabel,
} from "./ObserverTab.js";

describe("ObserverTab helpers", () => {
  it("labels observer warning workflow states", () => {
    expect(observerWarningStatusLabel("open")).toBe("Pending");
    expect(observerWarningStatusLabel("accepted")).toBe("Resumed");
    expect(observerWarningStatusLabel("converted_to_task")).toBe("Tasked");
    expect(observerWarningStatusLabel("dismissed")).toBe("Ignored");
  });

  it("uses suggestedGoal before falling back to suggestedAction", () => {
    expect(observerWarningRunGoal({
      suggestedGoal: "[Observer correction]\nContinue testing X",
      suggestedAction: "Continue testing X",
    })).toBe("[Observer correction]\nContinue testing X");
    expect(observerWarningRunGoal({
      suggestedGoal: "",
      suggestedAction: "Continue testing X",
    })).toBe("Continue testing X");
  });

  it("disables continue while any agent run is active or busy", () => {
    expect(observerWarningContinueDisabled(null, false, null)).toBe(false);
    expect(observerWarningContinueDisabled({ status: "running" }, false, null)).toBe(true);
    expect(observerWarningContinueDisabled(null, true, null)).toBe(true);
    expect(observerWarningContinueDisabled(null, false, "warn_1:task")).toBe(true);
  });

  it("requires explicit human direction only for stalled corrections", () => {
    expect(observerRecoveryRequiresDirection({ correctionOutcome: "stalled" })).toBe(true);
    expect(observerRecoveryRequiresDirection({ correctionOutcome: "persisted" })).toBe(false);
    expect(observerRecoveryRequiresDirection({ correctionOutcome: "pending" })).toBe(false);
  });

  it("groups warnings by intervention priority", () => {
    expect(observerWarningGroup("escalated")).toBe("action");
    expect(observerWarningGroup("open")).toBe("action");
    expect(observerWarningGroup("correcting")).toBe("monitoring");
    expect(observerWarningGroup("detected")).toBe("monitoring");
    expect(observerWarningGroup("resolved")).toBe("history");
    expect(observerWarningGroup("converted_to_task")).toBe("history");
  });
});
