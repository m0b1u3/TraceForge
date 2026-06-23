import { describe, it, expect } from "vitest";
import { checkScope } from "./scope-guard.js";
import type { ScopeRule } from "@traceforge/shared";

const rules: ScopeRule[] = [
  { caseId: "c1", allowHosts: ["target.com", "*.target.com"], denyHosts: ["admin.target.com"] },
];

describe("checkScope", () => {
  it("allows an exact allowed host", () => {
    expect(checkScope("https://target.com/login", rules).allowed).toBe(true);
  });

  it("allows a wildcard subdomain", () => {
    expect(checkScope("https://api.target.com/v1", rules).allowed).toBe(true);
  });

  it("denies an explicitly denied host even if it matches a wildcard", () => {
    const r = checkScope("https://admin.target.com/", rules);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/denied/i);
  });

  it("denies an out-of-scope host (deny-by-default)", () => {
    expect(checkScope("https://evil.com/", rules).allowed).toBe(false);
  });

  it("denies an invalid URL", () => {
    expect(checkScope("not a url", rules).allowed).toBe(false);
  });

  it("denies when there are no rules", () => {
    expect(checkScope("https://target.com/", []).allowed).toBe(false);
  });
});
