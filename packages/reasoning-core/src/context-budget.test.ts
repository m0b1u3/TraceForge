import { describe, expect, it } from "vitest";
import { deriveContextBudget, shouldCompressFarHistory } from "./context-budget.js";

describe("deriveContextBudget", () => {
  it("reserves output and safety tokens from the model context window", () => {
    const budget = deriveContextBudget({ contextWindowTokens: 128000, maxOutputTokens: 8192 });
    expect(budget.maxTokens).toBe(107808);
    expect(budget.focusReserve).toBe(3000);
    expect(budget.recentWindow).toBe(40);
  });

  it("uses conservative defaults when config does not declare a context window", () => {
    const budget = deriveContextBudget({});
    expect(budget.maxTokens).toBe(60000);
    expect(budget.recentWindow).toBe(20);
  });
});

describe("shouldCompressFarHistory", () => {
  it("compresses only when far history exceeds the available history budget", () => {
    const budget = deriveContextBudget({ contextWindowTokens: 32000, maxOutputTokens: 4096 });
    expect(shouldCompressFarHistory({ farHistoryTokens: 12000, budget })).toBe(false);
    expect(shouldCompressFarHistory({ farHistoryTokens: 24000, budget })).toBe(true);
  });
});
