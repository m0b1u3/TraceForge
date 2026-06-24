import { describe, it, expect } from "vitest";
import type { RuntimeEvent } from "./events.js";

describe("browser events", () => {
  it("accepts browser lifecycle and control events", () => {
    const events: RuntimeEvent[] = [
      { type: "browser_started", caseId: "c" },
      { type: "browser_stopped", caseId: "c" },
      { type: "browser_control_changed", caseId: "c", controller: "human" },
      { type: "browser_navigated", caseId: "c", url: "https://t.com/" },
    ];
    expect(events).toHaveLength(4);
    expect(events[2].type).toBe("browser_control_changed");
  });
});
