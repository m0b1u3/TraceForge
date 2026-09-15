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
