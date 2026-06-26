import { describe, it, expect } from "vitest";
import { buildContext, type ContextInput, type ContextBudget } from "./context-builder.js";
import type { Fact } from "@traceforge/shared";

function fact(id: string, title: string, host: string): Fact {
  return { id, caseId: "c", type: "api_endpoint", title, value: {}, source: { type: "manual", ref: "x" }, confidence: 1, tags: [`host:${host}`], createdAt: "2026-06-01T00:00:00Z", updateCount: 0, updatedAt: "", validity: "valid" } as Fact;
}

const base: ContextInput = {
  goal: "测越权", state: undefined,
  recentConvo: [{ role: "user", text: "测 a.com" }, { role: "assistant", text: "已提议纳入 a.com" }],
  facts: [fact("f1", "a.com order api", "a.com")],
  activeHypotheses: [], activeTasks: [], doneTaskSummaries: [], farSummary: undefined,
  scopeHosts: ["a.com"], protectedFactIds: new Set(),
};
const budget: ContextBudget = { maxTokens: 100000, focusReserve: 2000 };

describe("buildContext", () => {
  it("expands recent conversation into real user/assistant turns", () => {
    const r = buildContext(base, budget);
    const roles = r.messages.map((m) => m.role);
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");
    expect(r.messages.at(-1)).toMatchObject({ role: "user" });
    expect(r.messages.at(-1)!.content).toContain("测越权");
  });
  it("includes in-scope fact id and records injectedFactIds", () => {
    const r = buildContext(base, budget);
    expect(r.injectedFactIds).toContain("f1");
  });
  it("protected fact is kept even when topK would drop it", () => {
    const many = Array.from({ length: 50 }, (_, i) => fact(`x${i}`, `api ${i}`, "a.com"));
    const input = { ...base, facts: [...many, fact("keep", "rare", "a.com")], protectedFactIds: new Set(["keep"]) };
    const r = buildContext(input, { maxTokens: 100000, focusReserve: 2000 });
    expect(r.injectedFactIds).toContain("keep");
  });
  it("degrades when over budget", () => {
    const huge = { ...base, doneTaskSummaries: Array.from({ length: 200 }, (_, i) => `task ${i} 结论很长很长很长很长`), farSummary: "x".repeat(5000) };
    const r = buildContext(huge, { maxTokens: 300, focusReserve: 150 });
    expect(r.degraded.length).toBeGreaterThan(0);
    expect(r.estimatedTokens).toBeLessThanOrEqual(300 + 200);
  });
});
