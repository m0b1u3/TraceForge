import { describe, it, expect } from "vitest";
import { ObserverWarningSchema } from "./schemas.js";
import type { RuntimeEvent } from "./events.js";

describe("ObserverWarningSchema", () => {
  it("parses a valid warning with defaults", () => {
    const w = ObserverWarningSchema.parse({
      id: "w1", caseId: "c", level: "warning", title: "无依据猜测",
      description: "第3步断言注入但无 Fact", suggestedAction: "先最小验证", createdAt: "t",
    });
    expect(w.level).toBe("warning");
    expect(w.relatedFacts).toEqual([]);
    expect(w.relatedTasks).toEqual([]);
  });

  it("defaults workflow fields for older warning payloads", () => {
    const w = ObserverWarningSchema.parse({
      id: "w1",
      caseId: "c",
      level: "warning",
      title: "过早结束",
      description: "还有重要线索没有检查",
      relatedFacts: ["fact_1"],
      relatedTasks: [],
      suggestedAction: "继续检查 admin/login",
      createdAt: "t",
    });
    expect(w.status).toBe("open");
    expect(w.relatedRunId).toBeNull();
    expect(w.suggestedGoal).toBe("");
    expect(w.resolvedAt).toBeNull();
  });

  it("accepts observer warning update runtime events", () => {
    const event: RuntimeEvent = {
      type: "observer_warning_updated",
      warning: {
        id: "w1",
        caseId: "c",
        level: "warning",
        title: "过早结束",
        description: "还有重要线索没有检查",
        relatedFacts: ["fact_1"],
        relatedTasks: [],
        suggestedAction: "继续检查 admin/login",
        status: "accepted",
        relatedRunId: "run_1",
        suggestedGoal: "[Observer correction]\n继续检查 admin/login",
        resolvedAt: "t2",
        createdAt: "t",
      },
    };
    expect(event.warning.status).toBe("accepted");
  });

  it("rejects an invalid level", () => {
    expect(ObserverWarningSchema.safeParse({
      id: "w1", caseId: "c", level: "fatal", title: "x", description: "y", suggestedAction: "z", createdAt: "t",
    }).success).toBe(false);
  });
});
