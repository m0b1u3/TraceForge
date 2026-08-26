import { describe, expect, it } from "vitest";
import { agentProtocolItemLabel } from "./AgentRuntimeTimeline.js";

describe("AgentRuntimeTimeline", () => {
  it("renders generic protocol item labels without exposing raw inputs", () => {
    expect(agentProtocolItemLabel({
      type: "toolCall", id: "tool_1", tool: "http.request", status: "completed",
      risk: "read_only", summary: "Observed response", refs: [],
    })).toBe("http.request · completed");
    expect(agentProtocolItemLabel({
      type: "approval", id: "approval_1", tool: "session.write", status: "pending",
      risk: "bounded_write", reason: null,
    })).toBe("session.write · 审批 pending");
  });
});
