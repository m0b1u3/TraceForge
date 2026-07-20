import { describe, it, expect } from "vitest";
import { buildContext, type ContextInput, type ContextBudget } from "./context-builder.js";

const base: ContextInput = {
  goal: "测越权", state: undefined,
  recentConvo: [{ role: "user", text: "测 a.com" }, { role: "assistant", text: "已提议纳入 a.com" }],
  factCount: 1, trafficCount: 0, summaryCount: 0,
  activeHypotheses: [], activeTasks: [], doneTaskSummaries: [], farSummary: undefined,
  scopeHosts: ["a.com"],
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
  it("includes resource inventory line with counts", () => {
    const r = buildContext({ ...base, factCount: 23, trafficCount: 8, summaryCount: 2 }, budget);
    const ctxMsg = r.messages[0].content;
    expect(ctxMsg).toContain("23");
    expect(ctxMsg).toContain("search_facts");
  });
  it("injectedFactIds is always empty (pull mode)", () => {
    const r = buildContext({ ...base, factCount: 5 }, budget);
    expect(r.injectedFactIds).toEqual([]);
  });
  it("injects a bounded trusted cross-run summary and reports injected ids", () => {
    const r = buildContext({ ...base, sharedKnowledge: {
      verifiedFindings: ["fact_verified Verified IDOR"], identities: ["identity_1 user alice"],
      attackPaths: ["path_1 validated"], failedAttempts: ["fact_fail do not repeat"],
      excludedConflictCount: 2, injectedFactIds: ["fact_verified", "fact_fail"],
    } }, budget);
    expect(r.messages[0].content).toContain("Verified IDOR");
    expect(r.messages[0].content).toContain("已隔离 2");
    expect(r.injectedFactIds).toEqual(["fact_verified", "fact_fail"]);
  });
  it("degrades when over budget", () => {
    const huge = { ...base, doneTaskSummaries: Array.from({ length: 200 }, (_, i) => `task ${i} 结论很长很长很长很长`), farSummary: "x".repeat(5000) };
    const r = buildContext(huge, { maxTokens: 300, focusReserve: 150 });
    expect(r.degraded.length).toBeGreaterThan(0);
    expect(r.estimatedTokens).toBeLessThanOrEqual(300 + 200);
  });
});
