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

  it("clusters equivalent injection variants semantically", () => {
    const first = { url: "http://target/article?id=1%20OR%201=1", method: "GET" };
    const second = { method: "GET", url: "http://target/article?id=2%27%20or%20%271%27=%271" };
    expect(computeFailureFingerprint("http_replay", first))
      .toBe(computeFailureFingerprint("http_replay", second));
  });

  it("blocks a transient semantic cluster after two failures", () => {
    const memory = new FailureMemory();
    const first = { url: "http://target/article?id=1 OR 1=1", method: "GET" };
    const second = { url: "http://target/article?id=2' OR '1'='1", method: "GET" };
    memory.add("http_replay", first, 2);
    expect(memory.has("http_replay", second)).toBe(false);
    memory.add("http_replay", second, 2);
    expect(memory.has("http_replay", first)).toBe(true);
  });
});
