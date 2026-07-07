import { describe, it, expect, vi } from "vitest";
import { ProviderHolder } from "./provider-holder.js";
import type { LlmProvider } from "@traceforge/llm";

describe("ProviderHolder", () => {
  it("forwards runTools to the current provider", async () => {
    const p1: LlmProvider = { runTools: vi.fn().mockResolvedValue({ text: "a", toolCalls: [], done: true }) };
    const holder = new ProviderHolder(() => p1);
    const args = { system: "s", messages: [{ role: "user" as const, content: "hi" }], tools: [] };
    await holder.runTools(args);
    expect(p1.runTools).toHaveBeenCalledWith(args);
  });

  it("switches to a new provider after reload", async () => {
    const p1: LlmProvider = { extractJson: vi.fn().mockResolvedValue({ ok: true }) };
    const p2: LlmProvider = { extractJson: vi.fn().mockResolvedValue({ ok: false }) };
    let current = p1;
    const holder = new ProviderHolder(() => current);
    await holder.extractJson({ system: "s", user: "u", schema: {} });
    expect(p1.extractJson).toHaveBeenCalled();
    current = p2;
    await holder.extractJson({ system: "s", user: "u", schema: {} });
    expect(p2.extractJson).toHaveBeenCalled();
  });
});
