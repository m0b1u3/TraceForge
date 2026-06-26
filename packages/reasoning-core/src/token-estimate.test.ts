import { describe, it, expect } from "vitest";
import { estimateTokens } from "./token-estimate.js";

describe("estimateTokens", () => {
  it("empty is 0", () => {
    expect(estimateTokens("")).toBe(0);
  });
  it("ascii ~ chars/4", () => {
    expect(estimateTokens("a".repeat(40))).toBe(10);
  });
  it("cjk weighs more than ascii of same length", () => {
    expect(estimateTokens("你".repeat(40))).toBeGreaterThan(
      estimateTokens("a".repeat(40))
    );
  });
});
