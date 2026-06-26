import { describe, it, expect } from "vitest";
import { relevanceScore, topK } from "./relevance.js";
import type { Fact } from "@traceforge/shared";

function fact(p: Partial<Fact>): Fact {
  return { id: "f", caseId: "c", type: "note", title: "t", value: {}, source: { type: "manual", ref: "x" }, confidence: 1, tags: [], createdAt: "2026-01-01T00:00:00Z", updateCount: 0, updatedAt: "", validity: "valid", ...p } as Fact;
}

describe("relevanceScore", () => {
  it("same-host fact scores higher than cross-host", () => {
    const focus = { host: "a.com" };
    const same = relevanceScore(fact({ title: "login on a.com", tags: ["host:a.com"] }), focus);
    const cross = relevanceScore(fact({ title: "x on b.com", tags: ["host:b.com"] }), focus);
    expect(same).toBeGreaterThan(cross);
  });
  it("goal keyword match raises score", () => {
    const focus = { goal: "测试登录越权" };
    const hit = relevanceScore(fact({ type: "login_endpoint", title: "登录接口" }), focus);
    const miss = relevanceScore(fact({ type: "note", title: "无关页面" }), focus);
    expect(hit).toBeGreaterThan(miss);
  });
  it("consumed exploratory fact is penalized", () => {
    const focus = { host: "a.com" };
    const f = fact({ id: "f1", title: "x on a.com", tags: ["host:a.com"] });
    const normal = relevanceScore(f, focus);
    const penalized = relevanceScore(f, focus, { has: (id) => id === "f1" });
    expect(penalized).toBeLessThan(normal);
  });
});

describe("topK", () => {
  it("returns top k by score, drops cross-scope", () => {
    const focus = { host: "a.com" };
    const facts = [
      fact({ id: "1", title: "a.com login", tags: ["host:a.com"] }),
      fact({ id: "2", title: "b.com thing", tags: ["host:b.com"] }),
      fact({ id: "3", title: "a.com api", tags: ["host:a.com"] }),
    ];
    const res = topK(facts, focus, 2);
    expect(res.map((f) => f.id)).not.toContain("2");
    expect(res.length).toBeLessThanOrEqual(2);
  });
});
