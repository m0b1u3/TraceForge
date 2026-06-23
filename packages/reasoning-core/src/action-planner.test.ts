import { describe, it, expect } from "vitest";
import { MockProvider, type ExtractJsonArgs } from "@traceforge/llm";
import type { Fact } from "@traceforge/shared";
import { ActionPlanner, PLANNING_SYSTEM_PROMPT } from "./action-planner.js";

const facts: Fact[] = [
  { id: "fact_1", caseId: "case_1", type: "api_endpoint", title: "order api",
    value: { url: "https://t/api/order?id=1" }, source: { type: "traffic", ref: "traf_1" },
    confidence: 1, tags: [], createdAt: "now" },
];

describe("ActionPlanner", () => {
  it("turns provider actions into validated ActionCards", async () => {
    const provider = new MockProvider({
      actions: [
        { title: "SQLi probe", goal: "check injection", evidenceRefs: ["fact_1"],
          reasoning: "id is a db param", steps: ["baseline", "append quote"],
          expectedResults: ["diff means suspicious"], riskNotes: ["minimal only"],
          tool: "http_replay", priority: "high" },
      ],
    });
    const out = await new ActionPlanner(provider).plan("case_1", facts);
    expect(out).toHaveLength(1);
    expect(out[0].id).toMatch(/^acand_/);
    expect(out[0].status).toBe("proposed");
    expect(out[0].priority).toBe("high");
    expect(out[0].evidenceRefs).toEqual(["fact_1"]);
  });

  it("drops actions with empty evidenceRefs (no-evidence hard rule)", async () => {
    const provider = new MockProvider({
      actions: [
        { title: "blind dir brute", goal: "guess", evidenceRefs: [], reasoning: "hunch",
          steps: ["brute"], tool: "http_replay", priority: "low" },
      ],
    });
    const out = await new ActionPlanner(provider).plan("case_1", facts);
    expect(out).toEqual([]);
  });

  it("drops actions referencing a non-existent fact id", async () => {
    const provider = new MockProvider({
      actions: [
        { title: "x", goal: "g", evidenceRefs: ["fact_ghost"], reasoning: "r", steps: ["s"], tool: "manual", priority: "low" },
      ],
    });
    const out = await new ActionPlanner(provider).plan("case_1", facts);
    expect(out).toEqual([]);
  });

  it("returns [] when provider returns malformed payload", async () => {
    const out = await new ActionPlanner(new MockProvider({ nope: true })).plan("case_1", facts);
    expect(out).toEqual([]);
  });

  it("embeds facts inside data-boundary markers", async () => {
    let seen = "";
    const provider = new MockProvider((args: ExtractJsonArgs) => { seen = args.user; return { actions: [] }; });
    await new ActionPlanner(provider).plan("case_1", facts);
    expect(seen).toContain("<facts_data>");
    expect(seen).toContain("</facts_data>");
    expect(seen).toContain("fact_1");
  });

  it("system prompt declares evidence-driven + isolation rules", () => {
    expect(PLANNING_SYSTEM_PROMPT).toContain("<facts_data>");
    expect(PLANNING_SYSTEM_PROMPT.toLowerCase()).toMatch(/evidence|证据/);
  });
});
