import { describe, expect, it, vi } from "vitest";
import type { LlmProvider } from "@traceforge/llm";
import { createDb } from "./db/client.js";
import { SemanticIndex, cosineSimilarity } from "./semantic-index.js";
import { SemanticDocumentStore } from "./stores/semantic-document-store.js";

describe("SemanticIndex", () => {
  it("persists real provider vectors and ranks by cosine similarity", async () => {
    const vectors: Record<string, number[]> = {
      "ownership authorization bypass": [1, 0],
      "certificate inventory": [0, 1],
      "broken object access": [0.95, 0.05],
    };
    const embed = vi.fn(async ({ inputs }: { inputs: string[] }) => inputs.map((input) => vectors[input]));
    const provider = { embed } as unknown as LlmProvider;
    const store = new SemanticDocumentStore(createDb(":memory:"));
    const index = new SemanticIndex(provider, store, () => "embedding-test");

    const hits = await index.search("case_1", "fact", "broken object access", [
      { id: "fact_auth", text: "ownership authorization bypass" },
      { id: "fact_tls", text: "certificate inventory" },
    ]);
    expect(hits[0]).toMatchObject({ id: "fact_auth" });
    expect(hits[0].score).toBeGreaterThan(0.9);
    expect(store.get("fact", "fact_auth")).toMatchObject({ model: "embedding-test", dimensions: 2 });

    await index.search("case_1", "fact", "broken object access", [
      { id: "fact_auth", text: "ownership authorization bypass" },
      { id: "fact_tls", text: "certificate inventory" },
    ]);
    expect(embed).toHaveBeenNthCalledWith(1, { inputs: ["ownership authorization bypass", "certificate inventory"] });
    expect(embed).toHaveBeenCalledTimes(3); // documents once, query on each search
  });

  it("does not invent compatibility for mismatched or empty vectors", () => {
    expect(cosineSimilarity([1], [1, 2])).toBe(-1);
    expect(cosineSimilarity([], [])).toBe(-1);
  });
});
