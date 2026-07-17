import { describe, expect, it } from "vitest";
import { classifyToolFailure, incrementalTrajectory, shouldReviewAtCheckpoint } from "./agent-runtime.js";

describe("AgentRuntime failure classification", () => {
  it("classifies tool failures by retry policy", () => {
    expect(classifyToolFailure("HTTP 429 Too Many Requests")).toBe("transient");
    expect(classifyToolFailure("download failed: HTTP 503")).toBe("transient");
    expect(classifyToolFailure("out of scope: host is not allowed")).toBe("policy");
    expect(classifyToolFailure("浏览器未启动")).toBe("environment");
    expect(classifyToolFailure("unknown mcp server: poc")).toBe("environment");
    expect(classifyToolFailure("sh: nuclei: command not found")).toBe("permanent");
  });
});

describe("Observer checkpoint scheduling", () => {
  it("reviews every third completed tool turn", () => {
    expect([1, 2, 3, 4, 5, 6].filter((turn) => shouldReviewAtCheckpoint(turn, 3))).toEqual([3, 6]);
  });

  it("sends only messages added after the previous review", () => {
    const messages = [
      { role: "user" as const, content: "goal" },
      { role: "assistant" as const, content: "inspect" },
      { role: "tool" as const, content: "result", toolCallId: "call_1" },
      { role: "user" as const, content: "[Observer correction]\nverify evidence" },
    ];
    expect(incrementalTrajectory(messages, 3)).toBe("user: [Observer correction]\nverify evidence");
  });
});
