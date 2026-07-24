import { describe, expect, it } from "vitest";
import {
  classifyToolFailure, compactConversation, compactToolResult, executeWithDeadline,
  incrementalTrajectory, normalizeRunBudget, shouldReviewAtCheckpoint,
} from "./agent-runtime.js";

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
  it("supports a low-frequency twelve-turn fallback", () => {
    expect([1, 6, 11, 12, 18, 24].filter((turn) => shouldReviewAtCheckpoint(turn, 12))).toEqual([12, 24]);
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

describe("runtime context governance", () => {
  it("keeps long-running investigations unlimited by default", () => {
    const budget = normalizeRunBudget();
    expect(budget.maxTurns).toBe(Infinity);
    expect(budget.maxTotalTokens).toBe(Infinity);
    expect(budget.maxContextCharacters).toBe(96_000);
    expect(budget.maxToolResultCharacters).toBe(12_000);
  });

  it("omits binary output and truncates oversized text", () => {
    expect(compactToolResult(`HPROF\u0000\u0001binary`)).toContain("binary output omitted");
    expect(compactToolResult("x".repeat(100), 20).length).toBeLessThan(100);
  });

  it("compacts old messages while preserving recent context", () => {
    const messages = Array.from({ length: 14 }, (_, index) => ({
      role: index === 0 ? "user" as const : "assistant" as const,
      content: `${index}:${"x".repeat(100)}`,
    }));
    const latest = messages.at(-1)?.content;
    compactConversation(messages, 500);
    expect(messages.some((message) => message.content.includes("context compacted"))).toBe(true);
    expect(messages.at(-1)?.content).toBe(latest);
  });
});

describe("tool execution deadline", () => {
  it("returns completed real work before the deadline", async () => {
    await expect(executeWithDeadline(async () => "done", 1_000)).resolves.toBe("done");
  });

  it("stops waiting when the run is interrupted", async () => {
    const controller = new AbortController();
    const pending = executeWithDeadline(
      () => new Promise<string>((resolve) => setTimeout(() => resolve("late"), 500)),
      1_000,
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toThrow("tool execution aborted");
  });
});
