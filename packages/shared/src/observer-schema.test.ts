import { describe, it, expect } from "vitest";
import { ObserverWarningSchema } from "./schemas.js";

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

  it("rejects an invalid level", () => {
    expect(ObserverWarningSchema.safeParse({
      id: "w1", caseId: "c", level: "fatal", title: "x", description: "y", suggestedAction: "z", createdAt: "t",
    }).success).toBe(false);
  });
});
