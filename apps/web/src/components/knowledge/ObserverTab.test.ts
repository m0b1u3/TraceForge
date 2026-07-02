import { describe, it, expect } from "vitest";
import { observerWarningContinueDisabled, observerWarningRunGoal, observerWarningStatusLabel } from "./ObserverTab.js";

describe("ObserverTab helpers", () => {
  it("labels observer warning workflow states", () => {
    expect(observerWarningStatusLabel("open")).toBe("待处理");
    expect(observerWarningStatusLabel("accepted")).toBe("已继续");
    expect(observerWarningStatusLabel("converted_to_task")).toBe("已转 Task");
    expect(observerWarningStatusLabel("dismissed")).toBe("已忽略");
  });

  it("uses suggestedGoal before falling back to suggestedAction", () => {
    expect(observerWarningRunGoal({
      suggestedGoal: "[Observer correction]\n继续测 X",
      suggestedAction: "继续测 X",
    })).toBe("[Observer correction]\n继续测 X");
    expect(observerWarningRunGoal({
      suggestedGoal: "",
      suggestedAction: "继续测 X",
    })).toBe("继续测 X");
  });

  it("disables continue while any agent run is active or busy", () => {
    expect(observerWarningContinueDisabled(null, false, null)).toBe(false);
    expect(observerWarningContinueDisabled({ status: "running" }, false, null)).toBe(true);
    expect(observerWarningContinueDisabled(null, true, null)).toBe(true);
    expect(observerWarningContinueDisabled(null, false, "warn_1:task")).toBe(true);
  });
});
