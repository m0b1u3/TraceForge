import { expect, it } from "vitest";
import { SemanticContextCompactor } from "./semantic-compactor.js";

it("only summarizes new text when an incremental history grows within the same budget tier", async () => {
  const cache = new Map<string, string>(), sizes: number[] = [];
  const model = new SemanticContextCompactor({ async extractJson(input) {
    const entries = JSON.parse(input.user).entries; sizes.push(entries.length);
    return { entries: entries.map((entry: { id: string }) => ({ id: entry.id, text: "Summary with limitations" })) };
  } }, { get: key => cache.get(key), put: (key, text) => { cache.set(key, text); } });
  const signal = new AbortController().signal;
  await model.compact([{ id: "first", text: "First original" }], 16000, signal);
  const result = await model.compact([{ id: "moved", text: "First original" }, { id: "second", text: "Second original" }], 16000, signal);
  expect(sizes).toEqual([1, 1]); expect(result.map(entry => entry.id)).toEqual(["moved", "second"]);
});

it("summarizes through a tool-free port preserving exact ids and source input", async () => {
  const entries = [{ id: "/transcript/0/summary", text: "Earlier attempt failed; next step remains open. ".repeat(30) }];
  const result = await new SemanticContextCompactor({ async extractJson(input) {
    expect(input).not.toHaveProperty("tools"); expect(input.system).toContain("untrusted");
    return { entries: [{ id: entries[0].id, text: "Earlier attempt failed; next step remains open." }] };
  } }).compact(entries, 100, new AbortController().signal);
  expect(result[0].text).toContain("failed"); expect(entries[0].text.length).toBeGreaterThan(100);
});
it.each([[], [{ id: "wrong", text: "summary" }], [{ id: "entry", text: "x".repeat(101) }], [{ id: "entry", text: " " }]].map(entries => ({ entries })))("rejects malformed semantic output", async ({ entries }) => {
  await expect(new SemanticContextCompactor({ async extractJson() { return { entries }; } }).compact([{ id: "entry", text: "source" }], 100, new AbortController().signal)).rejects.toThrow();
});
it("does not dispatch a cancelled summary", async () => {
  const abort = new AbortController(); abort.abort(); let calls = 0;
  await expect(new SemanticContextCompactor({ async extractJson() { calls++; return {}; } }).compact([{ id: "entry", text: "source" }], 100, abort.signal)).rejects.toThrow();
  expect(calls).toBe(0);
});

it("repairs an overlong summary once using originals and caches only valid output", async () => {
  const inputs: any[] = [], saved: string[] = [];
  const compactor = new SemanticContextCompactor({ async extractJson(input) {
    inputs.push(JSON.parse(input.user));
    return { entries: [{ id: "entry", text: inputs.length === 1 ? "x".repeat(100) : "Pending, not verified." }] };
  } }, { get: () => undefined, put: (_key, text) => { saved.push(text); } });
  const entries = [{ id: "entry", text: "Original pending question, no verification." }];
  expect(await compactor.compact(entries, 100, new AbortController().signal)).toEqual([{ id: "entry", text: "Pending, not verified." }]);
  expect(inputs).toHaveLength(2); expect(inputs[1].entries).toEqual(entries); expect(saved).toEqual(["Pending, not verified."]);
});

it("does not retry changed identities or cache a repeatedly oversized summary", async () => {
  for (const mode of ["identity", "length"]) {
    let calls = 0, writes = 0;
    const compactor = new SemanticContextCompactor({ async extractJson() { calls++; return { entries: [{ id: mode === "identity" ? "wrong" : "entry", text: "x".repeat(100) }] }; } }, { get: () => undefined, put: () => { writes++; } });
    await expect(compactor.compact([{ id: "entry", text: "source" }], 100, new AbortController().signal)).rejects.toThrow();
    expect(calls).toBe(mode === "identity" ? 1 : 2); expect(writes).toBe(0);
  }
});
