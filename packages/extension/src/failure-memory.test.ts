import { describe, it, expect } from "vitest";
import { FailureMemory, computeFailureFingerprint } from "./failure-memory.js";

describe("FailureMemory", () => {
  it("blocks identical tool inputs after a failure", () => {
    const mem = new FailureMemory();
    expect(mem.has("exec_command", { command: "ls" })).toBe(false);
    mem.add("exec_command", { command: "ls" });
    expect(mem.has("exec_command", { command: "ls" })).toBe(true);
    expect(mem.has("exec_command", { command: "pwd" })).toBe(false);
  });

  it("is insensitive to object key order", () => {
    const mem = new FailureMemory();
    mem.add("run_script", { args: ["a", "b"], path: "x.sh" });
    expect(mem.has("run_script", { path: "x.sh", args: ["a", "b"] })).toBe(true);
  });

  it("loads previously recorded failures", () => {
    const mem = new FailureMemory([
      { tool: "exec_command", input: { command: "cat /etc/passwd" } },
    ]);
    expect(mem.has("exec_command", { command: "cat /etc/passwd" })).toBe(true);
  });

  it("produces stable fingerprints", () => {
    expect(computeFailureFingerprint("t", { a: 1, b: 2 }))
      .toBe(computeFailureFingerprint("t", { b: 2, a: 1 }));
  });

  it("does not collapse changed investigation inputs into one product rule", () => {
    const first = { target: "https://target.test/resource?candidate=first", method: "GET" };
    const second = { method: "GET", target: "https://target.test/resource?candidate=second" };
    expect(computeFailureFingerprint("request", first))
      .not.toBe(computeFailureFingerprint("request", second));
  });

  it("allows one bounded retry for a retryable failure", () => {
    const memory = new FailureMemory();
    const input = { target: "https://target.test/resource" };
    const diagnostic = {
      category: "network" as const,
      retryable: true,
      summary: "Transport failed.",
      recommendation: "Retry once.",
    };
    memory.recordFailure("request", input, diagnostic);
    expect(memory.has("request", input)).toBe(false);
    memory.recordFailure("request", input, diagnostic);
    expect(memory.getBlocked("request", input)).toMatchObject({
      observations: 2,
      diagnostic: { category: "network", retryable: true },
    });
  });

  it("blocks an identical non-retryable call but permits a corrected input", () => {
    const memory = new FailureMemory();
    const diagnostic = {
      category: "invalid_input" as const,
      retryable: false,
      summary: "Input was rejected.",
      recommendation: "Correct the input.",
    };
    memory.recordFailure("analyze", { path: "missing" }, diagnostic);
    expect(memory.has("analyze", { path: "missing" })).toBe(true);
    expect(memory.has("analyze", { path: "available" })).toBe(false);
  });

  it("clears only a resolved environmental precondition category", () => {
    const memory = new FailureMemory([
      {
        tool: "analyze",
        input: { path: "artifact.bin" },
        diagnostic: {
          category: "unavailable_dependency",
          retryable: false,
          summary: "Analyzer unavailable.",
          recommendation: "Install an analyzer.",
        },
      },
      {
        tool: "request",
        input: { target: "https://target.test" },
        diagnostic: {
          category: "invalid_input",
          retryable: false,
          summary: "Input rejected.",
          recommendation: "Correct the input.",
        },
      },
    ]);
    memory.clearCategory("unavailable_dependency");
    expect(memory.has("analyze", { path: "artifact.bin" })).toBe(false);
    expect(memory.has("request", { target: "https://target.test" })).toBe(true);
  });
});
