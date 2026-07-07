import { describe, it, expect } from "vitest";
import { ProviderHolder } from "./provider-holder.js";
import type { LlmProvider } from "@traceforge/llm";

function makeProvider(partial: Partial<LlmProvider> & { calls?: unknown[] }): LlmProvider {
  return {
    runTools: async (args) => {
      partial.calls?.push(["runTools", args]);
      return { text: "", toolCalls: [], done: true };
    },
    extractJson: async (args) => {
      partial.calls?.push(["extractJson", args]);
      return {};
    },
    ...partial,
  };
}

describe("ProviderHolder", () => {
  it("forwards runTools to the current provider", async () => {
    const calls: unknown[] = [];
    const p1 = makeProvider({
      calls,
      runTools: async (args) => {
        calls.push(["runTools", args]);
        return { text: "a", toolCalls: [], done: true };
      },
    });
    const holder = new ProviderHolder(() => p1);
    const args = { system: "s", messages: [{ role: "user" as const, content: "hi" }], tools: [] };
    await holder.runTools(args);
    expect(calls).toEqual([["runTools", args]]);
  });

  it("switches to a new provider after reload", async () => {
    const calls: string[] = [];
    const p1 = makeProvider({ extractJson: async () => { calls.push("p1"); return { ok: true }; } });
    const p2 = makeProvider({ extractJson: async () => { calls.push("p2"); return { ok: false }; } });
    let current: LlmProvider = p1;
    const holder = new ProviderHolder(() => current);
    await holder.extractJson({ system: "s", user: "u", schema: {} });
    current = p2;
    await holder.extractJson({ system: "s", user: "u", schema: {} });
    expect(calls).toEqual(["p1", "p2"]);
  });
});
