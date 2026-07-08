import { describe, it, expect } from "vitest";
import { Observer } from "./observer.js";
import type { LlmProvider } from "./provider.js";

function provider(result: unknown | (() => never)): LlmProvider {
  return {
    extractJson: async () => (typeof result === "function" ? (result as () => never)() : result),
    runTools: async () => ({ text: "", toolCalls: [], done: true }),
  };
}
const input = { goal: "g", trajectory: "t", factsSummary: "f", tasksSummary: "k" };

describe("Observer.review", () => {
  it("returns parsed warnings with id/caseId/level filled", async () => {
    const obs = new Observer(provider({ warnings: [
      { level: "warning", title: "无依据猜测", description: "d", suggestedAction: "s" },
      { level: "info", title: "忽略 Fact", description: "d2", suggestedAction: "s2", relatedFacts: ["f1"] },
    ] }));
    const out = await obs.review("c", input);
    expect(out.warnings).toHaveLength(2);
    expect(out.warnings[0]).toMatchObject({ caseId: "c", level: "warning", title: "无依据猜测" });
    expect(out.warnings[0].id).toBeTruthy();
    expect(out.warnings[1].relatedFacts).toEqual(["f1"]);
    expect(out.error).toBeUndefined();
  });

  it("defaults warning workflow fields", async () => {
    const obs = new Observer(provider({ warnings: [
      { level: "warning", title: "过早结束", description: "d", suggestedAction: "继续测 X" },
    ] }));
    const out = await obs.review("c", input);
    expect(out.warnings[0]).toMatchObject({
      status: "open",
      relatedRunId: null,
      suggestedGoal: "",
      resolvedAt: null,
    });
  });

  it("uses the LLM-provided suggestedGoal when present", async () => {
    const obs = new Observer(provider({ warnings: [
      { level: "warning", title: "过早结束", description: "d", suggestedAction: "继续测 X", suggestedGoal: "继续深入测试 /admin" },
    ] }));
    const out = await obs.review("c", input);
    expect(out.warnings[0]?.suggestedGoal).toBe("继续深入测试 /admin");
  });

  it("coerces an invalid level to info", async () => {
    const obs = new Observer(provider({ warnings: [{ level: "fatal", title: "x", description: "d", suggestedAction: "s" }] }));
    const out = await obs.review("c", input);
    expect(out.warnings[0].level).toBe("info");
  });

  it("returns empty warnings and an error when the provider throws", async () => {
    const obs = new Observer(provider(() => { throw new Error("no llm"); }));
    const out = await obs.review("c", input);
    expect(out.warnings).toEqual([]);
    expect(out.error).toBe("no llm");
  });

  it("returns empty warnings when the provider yields a non-conforming shape", async () => {
    const obs = new Observer(provider({ nope: 1 }));
    const out = await obs.review("c", input);
    expect(out.warnings).toEqual([]);
    expect(out.error).toBeUndefined();
  });

  it("returns empty warnings when warnings is empty", async () => {
    const obs = new Observer(provider({ warnings: [] }));
    const out = await obs.review("c", input);
    expect(out.warnings).toEqual([]);
    expect(out.error).toBeUndefined();
  });
});
