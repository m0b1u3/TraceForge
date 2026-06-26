import { describe, it, expect } from "vitest";
import { compressFar } from "./compressor.js";

describe("compressFar", () => {
  it("falls back to rule-based when no llm", async () => {
    const r = await compressFar({ convoText: "很多对话".repeat(50), doneTaskLines: ["t1", "t2", "t3"] });
    expect(r).toContain("3"); // done 任务计数
    expect(r.length).toBeLessThan("很多对话".repeat(50).length);
  });
  it("uses llm summary when provided", async () => {
    const llm = { extractJson: async () => ({ summary: "LLM 摘要结论" }) };
    const r = await compressFar({ convoText: "x".repeat(100), doneTaskLines: [] }, llm);
    expect(r).toBe("LLM 摘要结论");
  });
  it("falls back when llm throws", async () => {
    const llm = { extractJson: async () => { throw new Error("network"); } };
    const r = await compressFar({ convoText: "abc", doneTaskLines: ["t1"] }, llm);
    expect(r).toContain("1");
  });
});
