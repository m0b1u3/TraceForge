import { describe, expect, it } from "vitest";
import { detectResponseLanguage, normalizeResponseLanguage, responseLanguageInstruction } from "./response-language.js";

describe("response language", () => {
  it("detects the user's writing system instead of following English tool output", () => {
    expect(detectResponseLanguage("继续测试这个目标")).toBe("zh-CN");
    expect(detectResponseLanguage("Continue testing this target")).toBe("en");
    expect(detectResponseLanguage("この対象を続けて調査する")).toBe("ja");
  });

  it("preserves an explicit inherited language for machine-generated continuation goals", () => {
    expect(normalizeResponseLanguage("zh-CN", "Approved target.test. Continue testing.")).toBe("zh-CN");
  });

  it("places a mandatory no-drift instruction in the system prompt", () => {
    expect(responseLanguageInstruction("zh-CN")).toContain("mandatory");
    expect(responseLanguageInstruction("zh-CN")).toContain("Never switch");
  });
});
