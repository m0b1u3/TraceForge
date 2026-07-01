import { describe, expect, it } from "vitest";
import { FallbackQueryExpander, LlmQueryExpander } from "./query-expander.js";
import type { LlmProvider } from "./provider.js";

function provider(result: unknown): LlmProvider {
  return {
    extractJson: async () => result,
    runTools: async () => ({ text: "", toolCalls: [], done: true }),
  };
}

describe("FallbackQueryExpander", () => {
  it("returns only the original query", async () => {
    const terms = await new FallbackQueryExpander().expand({ query: "越权", toolName: "search_facts" });

    expect(terms).toEqual(["越权"]);
  });
});

describe("LlmQueryExpander", () => {
  it("includes original query and sanitized LLM terms", async () => {
    const expander = new LlmQueryExpander(provider(["IDOR", "BOLA", "broken access control"]));

    const terms = await expander.expand({ query: "越权", toolName: "search_facts" });

    expect(terms).toEqual(["越权", "IDOR", "BOLA", "broken access control"]);
  });

  it("deduplicates terms case-insensitively", async () => {
    const expander = new LlmQueryExpander(provider(["IDOR", "idor", " 越权 "]));

    const terms = await expander.expand({ query: "越权", toolName: "search_facts" });

    expect(terms).toEqual(["越权", "IDOR"]);
  });

  it("filters empty, multiline, and overlong terms", async () => {
    const expander = new LlmQueryExpander(provider(["", "line1\nline2", "x".repeat(81), "BOLA"]));

    const terms = await expander.expand({ query: "越权", toolName: "search_facts" });

    expect(terms).toEqual(["越权", "BOLA"]);
  });

  it("falls back to original query on invalid provider result", async () => {
    const expander = new LlmQueryExpander(provider({ terms: ["IDOR"] }));

    const terms = await expander.expand({ query: "越权", toolName: "search_facts" });

    expect(terms).toEqual(["越权"]);
  });

  it("falls back to original query when provider throws", async () => {
    const throwing: LlmProvider = {
      extractJson: async () => { throw new Error("network"); },
      runTools: async () => ({ text: "", toolCalls: [], done: true }),
    };
    const expander = new LlmQueryExpander(throwing);

    const terms = await expander.expand({ query: "越权", toolName: "search_facts" });

    expect(terms).toEqual(["越权"]);
  });

  it("uses plain runTools JSON text when extractJson is unavailable", async () => {
    const jsonTextProvider: LlmProvider = {
      extractJson: async () => { throw new Error("json_schema unavailable"); },
      runTools: async () => ({ text: "[\"IDOR\", \"BOLA\"]", toolCalls: [], done: true }),
    };
    const expander = new LlmQueryExpander(jsonTextProvider);

    const terms = await expander.expand({ query: "越权", toolName: "search_facts" });

    expect(terms).toEqual(["越权", "IDOR", "BOLA"]);
  });

  it("caches expansion by tool and normalized query", async () => {
    let calls = 0;
    const counting: LlmProvider = {
      extractJson: async () => {
        calls += 1;
        return ["IDOR"];
      },
      runTools: async () => ({ text: "", toolCalls: [], done: true }),
    };
    const expander = new LlmQueryExpander(counting);

    await expander.expand({ query: " 越权 ", toolName: "search_facts" });
    await expander.expand({ query: "越权", toolName: "search_facts" });

    expect(calls).toBe(1);
  });
});
