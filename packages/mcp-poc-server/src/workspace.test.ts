import { describe, it, expect } from "vitest";
import { resolveInWorkspace, truncateOutput } from "./workspace.js";
import { join, resolve } from "node:path";

const root = resolve("/tmp/ws");

describe("resolveInWorkspace", () => {
  it("resolves a relative path inside the case dir", () => {
    expect(resolveInWorkspace(root, "case1", "poc.py")).toBe(join(root, "case1", "poc.py"));
  });

  it("returns the case root when relPath omitted", () => {
    expect(resolveInWorkspace(root, "case1")).toBe(join(root, "case1"));
  });

  it("rejects ../ escape in relPath", () => {
    expect(() => resolveInWorkspace(root, "case1", "../../etc/passwd")).toThrow(/escape/i);
  });

  it("rejects a caseId containing a path separator", () => {
    expect(() => resolveInWorkspace(root, "a/b", "x")).toThrow();
    expect(() => resolveInWorkspace(root, "..", "x")).toThrow();
  });

  it("rejects an empty caseId", () => {
    expect(() => resolveInWorkspace(root, "", "x")).toThrow();
  });
});

describe("truncateOutput", () => {
  it("returns input unchanged when within limit", () => {
    expect(truncateOutput("hello", 100)).toBe("hello");
  });

  it("truncates and annotates when over limit", () => {
    const out = truncateOutput("abcdefghij", 4);
    expect(out.startsWith("abcd")).toBe(true);
    expect(out).toMatch(/truncated 6 bytes/);
  });
});
