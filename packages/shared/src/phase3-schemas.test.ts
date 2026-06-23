import { describe, it, expect } from "vitest";
import { CandidateFactSchema } from "./schemas.js";

describe("CandidateFactSchema", () => {
  it("defaults confidence to 0.5", () => {
    const c = CandidateFactSchema.parse({
      id: "cand_1", caseId: "case_1", type: "api_endpoint", title: "order detail",
      value: { url: "https://t/api/order" }, sourceRef: "traf_1", reasoning: "looks like an API",
    });
    expect(c.confidence).toBe(0.5);
  });

  it("rejects an unknown type", () => {
    expect(() =>
      CandidateFactSchema.parse({
        id: "c", caseId: "c", type: "bogus", title: "t", value: {}, sourceRef: "r", reasoning: "x",
      }),
    ).toThrow();
  });
});
