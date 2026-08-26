import { describe, expect, it } from "vitest";
import { cognitiveDecisionSummary, formatHeartbeatAge } from "./ScenarioCollaborationView.js";

describe("ScenarioCollaborationView projections", () => {
  it("summarizes Planner and Observer decisions without exposing hidden reasoning", () => {
    expect(cognitiveDecisionSummary({ action: "wait", rationale: "Existing Work covers the objective" }))
      .toBe("Existing Work covers the objective");
    expect(cognitiveDecisionSummary({ action: "terminate_run", reason: "Authorization is no longer valid" }))
      .toBe("Authorization is no longer valid");
  });

  it("formats heartbeat age at stable operational boundaries", () => {
    expect(formatHeartbeatAge(null)).toBe("时间异常");
    expect(formatHeartbeatAge(999)).toBe("刚刚");
    expect(formatHeartbeatAge(1_000)).toBe("1s 前");
    expect(formatHeartbeatAge(59_999)).toBe("59s 前");
    expect(formatHeartbeatAge(60_000)).toBe("1m 前");
  });
});
