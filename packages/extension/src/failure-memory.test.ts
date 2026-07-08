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
});
