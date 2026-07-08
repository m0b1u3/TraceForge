import { describe, it, expect } from "vitest";
import { makeReevaluateFactsTool } from "./reevaluate-facts.js";
import type { Fact } from "@traceforge/shared";

const fakeStore = {
  listByCase: (_caseId: string) => [
    { id: "f1", caseId: "c1", type: "credential", title: "leaked test account", value: "admin:superpass", source: { type: "test", ref: "t1" }, createdAt: "", updateCount: 0, updatedAt: "", validity: "valid" } as unknown as Fact,
    { id: "f2", caseId: "c1", type: "endpoint", title: "login endpoint", value: "/api/login", source: { type: "test", ref: "t2" }, createdAt: "", updateCount: 0, updatedAt: "", validity: "valid" } as unknown as Fact,
  ],
};

describe("reevaluate_facts tool", () => {
  it("returns suggestions based on existing facts", async () => {
    const tool = makeReevaluateFactsTool("c1", fakeStore, async (_caseId, goal, focus, facts) => {
      const endpoint = String(facts.find((f) => f.type === "endpoint")?.value ?? "");
      const credential = String(facts.find((f) => f.type === "credential")?.value ?? "");
      return `For goal "${goal}" (focus: ${focus ?? "none"}), try ${endpoint} with ${credential}`;
    });
    const res = await tool.execute({ goal: "test login", focus: "authentication" });
    expect(res.content).toContain("/api/login");
    expect(res.content).toContain("admin:superpass");
    expect(res.content).toContain("test login");
  });

  it("works without focus", async () => {
    const tool = makeReevaluateFactsTool("c1", fakeStore, async (_caseId, goal, focus, facts) => {
      return `goal=${goal} focus=${focus ?? "-"} facts=${facts.length}`;
    });
    const res = await tool.execute({ goal: "test login" });
    expect(res.content).toBe("goal=test login focus=- facts=2");
  });
});
