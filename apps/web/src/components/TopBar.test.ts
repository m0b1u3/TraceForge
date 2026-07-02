import { describe, expect, it } from "vitest";
import { observerWarningTopBarState } from "./TopBar.js";

describe("observerWarningTopBarState", () => {
  it("counts only open warnings for top bar alert state", () => {
    const state = observerWarningTopBarState([
      { level: "critical", status: "dismissed" },
      { level: "warning", status: "converted_to_task" },
      { level: "warning", status: "open" },
    ]);

    expect(state.count).toBe(1);
    expect(state.className).toBe("is-alert");
  });

  it("uses critical class when an open critical warning exists", () => {
    const state = observerWarningTopBarState([
      { level: "critical", status: "open" },
      { level: "warning", status: "open" },
    ]);

    expect(state.count).toBe(2);
    expect(state.className).toBe("is-crit");
  });
});
