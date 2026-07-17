import { describe, expect, it } from "vitest";
import { confidencePercent } from "./knowledge-window.js";

describe("confidencePercent", () => {
  it("formats normalized confidence values", () => {
    expect(confidencePercent(0.95)).toBe(95);
    expect(confidencePercent(1)).toBe(100);
  });

  it("supports legacy percentage values without multiplying them twice", () => {
    expect(confidencePercent(95)).toBe(95);
    expect(confidencePercent(100)).toBe(100);
  });

  it("clamps invalid and out-of-range values", () => {
    expect(confidencePercent(Number.NaN)).toBe(0);
    expect(confidencePercent(-1)).toBe(0);
    expect(confidencePercent(140)).toBe(100);
  });
});
