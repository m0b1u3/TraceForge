import { expect, it, vi } from "vitest";
import { RollingContextCompaction, summarizeHistory } from "./rolling-context.js";
import { estimateContextTokens, resolveContextBudget, ModelContextOverflowError } from "@traceforge/shared/model-context";
import type { ContextCompactor } from "./compaction.js";

function fixture() {
  const rows = new Map<string, string>(); let calls = 0;
  const inputs: unknown[] = [];
  const cache = { get: (key: string) => rows.get(key), put: (key: string, text: string) => { rows.set(key, text); } };
  const compactor: ContextCompactor = { version: "fixture", async compact(entries) {
    calls++; inputs.push(JSON.parse(entries[0].text));
    return [{ id: "history", text: "Progress retained; unresolved work remains. Read original receipts for details." }];
  } };
  const context = { id: "call", caseId: "case", runId: "run", consumer: "worker", workId: "work" };
  return { cache, compactor, context, inputs, calls: () => calls, size: () => rows.size };
}
it("uses the configured window and output headroom, with a visible unknown-model fallback", () => {
  expect(resolveContextBudget().source).toBe("conservative_fallback");
  const small = resolveContextBudget({ contextWindowTokens: 32000, maxOutputTokens: 4000 });
  expect(small.input).toBe(26400);
  expect(resolveContextBudget({ contextWindowTokens: 128000, maxOutputTokens: 4000 }).trigger).toBeGreaterThan(small.trigger);
  expect(() => resolveContextBudget({ contextWindowTokens: 32000, maxOutputTokens: 32000 })).toThrow();
  expect(estimateContextTokens("中文")).toBeGreaterThan(estimateContextTokens("ab"));
});
it("reuses complete prefixes after restart, merges only new records, and invalidates changed sources", async () => {
  const f = fixture(), originals = Array.from({ length: 32 }, (_, id) => ({ id, text: `record ${id}` }));
  const run = (entries: unknown[], owner = f.context) => summarizeHistory(entries, owner, 24000, 2048, f.compactor, f.cache, new AbortController().signal);
  const first = await run(originals);
  expect(first.covered).toBe(32); expect(f.calls()).toBe(2);
  expect((f.inputs[1] as any).previousSummary).toContain("Progress");
  await run(originals); expect(f.calls()).toBe(2);
  await run([...originals, { id: 32, text: "new record" }]); expect(f.calls()).toBe(3);
  expect((f.inputs[2] as any).newHistoricalRecords).toEqual([{ id: 32, text: "new record" }]);
  await run([{ id: 0, text: "withdrawn source" }, ...originals.slice(1)]); expect(f.calls()).toBe(5);
  await run(originals, { ...f.context, workId: "other" }); expect(f.calls()).toBe(7);
});
it("keeps complete recent turns and recalled text, without summarizing them a second time", async () => {
  const f = fixture(); let window = 16000;
  const runtime = new RollingContextCompaction(f.compactor, f.cache, () => ({ contextWindowTokens: window, maxOutputTokens: 2000 }));
  const transcript = Array.from({ length: 50 }, (_, turn) => ({ turn, kind: "tool", receiptKey: `receipt-${turn}`, refs: [], summary: "record ".repeat(180) }));
  transcript[0].summary = "[recall-page] exact detail";
  const input = { caseId: "case", runId: "run", consumer: "worker", sourceFingerprint: "sources", context: {
    work: { id: "work", objective: "Keep this exact", pendingApproval: { reason: "Not a summary" } }, transcript,
  } };
  const before = JSON.stringify(input);
  window = 128000;
  expect((await runtime.prepare(input)).manifest.contextCompaction).toMatchObject({ status: "not_needed" });
  window = 16000;
  const result = await runtime.prepare(input);
  expect(result.manifest.contextCompaction).toMatchObject({ status: "completed" });
  expect(result.context.work).toEqual(input.context.work);
  expect((result.context.transcript as any[])[0]).toEqual(transcript[0]);
  expect((result.context.transcript as any[]).at(-1)).toEqual(transcript.at(-1));
  expect(f.inputs.every(value => !(value as any).newHistoricalRecords.some((entry: any) => entry.summary.includes("[recall-page]")))).toBe(true);
  expect(JSON.stringify(input)).toBe(before);
});
it("does not store failed/late summaries or drop required anchors to force a fit", async () => {
  const f = fixture();
  const bad: ContextCompactor = { version: "bad", async compact() { return [{ id: "other", text: "wrong" }]; } };
  await expect(summarizeHistory(["original"], f.context, 24000, 2048, bad, f.cache, new AbortController().signal)).rejects.toThrow("Invalid");
  const runtime = new RollingContextCompaction(f.compactor, f.cache, () => ({ contextWindowTokens: 16000 }));
  await expect(runtime.prepare({ caseId: "case", runId: "run", consumer: "worker", sourceFingerprint: "source",
    context: { work: { objective: "x".repeat(80000) }, transcript: [] } })).rejects.toThrow("budget");
});
it("times out a non-cooperating summarizer without accepting its late result", async () => {
  const f = fixture(); let finish!: (value: Array<{ id: string; text: string }>) => void;
  const slow: ContextCompactor = { version: "slow", compact: () => new Promise(resolve => { finish = resolve; }) };
  const runtime = new RollingContextCompaction(slow, f.cache, () => ({ contextWindowTokens: 16000 }), 5);
  const pending = runtime.prepare({ caseId: "case", runId: "run", consumer: "worker", sourceFingerprint: "source",
    context: { transcript: Array.from({ length: 60 }, (_, turn) => ({ turn, kind: "tool", summary: "x".repeat(1200) })) } });
  await expect(pending).rejects.toThrow("timed out");
  finish([{ id: "history", text: "late" }]);
  await Promise.resolve();
  expect(f.size()).toBe(0);
});

it("rebuilds explicitly rejected summary batches once without replaying accepted history", async () => {
  const f = fixture(); let calls = 0;
  const compactor: ContextCompactor = { version: "overflow-fixture", async compact(entries) {
    calls++;
    if (calls === 1) throw new ModelContextOverflowError("remote_rejection");
    const batch = JSON.parse(entries[0].text).newHistoricalRecords;
    expect(batch.length).toBeLessThanOrEqual(8);
    return [{ id: "history", text: "Earlier progress and remaining records retained." }];
  } };
  const rows = Array.from({ length: 16 }, (_, id) => ({ id }));
  const result = await summarizeHistory(rows, f.context, 24000, 2048, compactor, f.cache, new AbortController().signal);
  expect(result).toMatchObject({ covered: 16, recoveries: 1 }); expect(calls).toBe(3);
  expect(f.size()).toBe(2); // The rejected batch was never cached.
});

it.each(["repeated_overflow", "transport", "aborted"])("does not loop or infer safe retries for %s", async mode => {
  const f = fixture(), controller = new AbortController(); let calls = 0;
  const compactor: ContextCompactor = { version: "reject", async compact() {
    calls++;
    if (mode === "aborted") controller.abort();
    if (mode === "transport") throw new Error("network failure");
    throw new ModelContextOverflowError("remote_rejection");
  } };
  await expect(summarizeHistory([{ id: 1 }, { id: 2 }], f.context, 24000, 2048, compactor, f.cache, controller.signal)).rejects.toThrow();
  expect(calls).toBe(mode === "repeated_overflow" ? 2 : 1); expect(f.size()).toBe(0);
});

it("passes cancellation into compaction, rejects promptly and never caches late text", async () => {
  const f = fixture(), stop = new AbortController(); let complete!: (entries: Array<{ id: string; text: string }>) => void;
  let compactorSignal: AbortSignal | undefined;
  const runtime = new RollingContextCompaction({ version: "noncooperative", compact: (_entries, _maximum, signal) => {
    compactorSignal = signal; return new Promise(resolve => { complete = resolve; });
  } }, f.cache, () => ({ contextWindowTokens: 16000 }));
  const pending = runtime.prepare({ signal: stop.signal, caseId: "case", runId: "run", consumer: "worker", sourceFingerprint: "source",
    context: { transcript: Array.from({ length: 60 }, (_, turn) => ({ turn, kind: "tool", summary: "x".repeat(1200) })) } });
  stop.abort(new Error("operator stopped"));
  await expect(pending).rejects.toThrow("operator stopped"); expect(compactorSignal?.aborted).toBe(true);
  complete([{ id: "history", text: "late" }]); await Promise.resolve(); expect(f.size()).toBe(0);
});

it("allows multiple slow summary batches under the bounded model deadline, not a fixed 30-second total", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture(); let calls = 0;
    const runtime = new RollingContextCompaction({ version: "slow-batches", async compact() {
      calls++; await new Promise(resolve => setTimeout(resolve, 20000)); return [{ id: "history", text: "Pending progress preserved." }];
    } }, f.cache, () => ({ contextWindowTokens: 16000 }));
    const pending = runtime.prepare({ caseId: "case", runId: "run", consumer: "worker", sourceFingerprint: "source",
      context: { transcript: Array.from({ length: 40 }, (_, turn) => ({ turn, kind: "tool", summary: "x".repeat(900) })) } });
    await vi.advanceTimersByTimeAsync(100000);
    expect((await pending).manifest.contextCompaction).toMatchObject({ status: "completed", timeoutMs: 120000 });
    expect(calls).toBeGreaterThan(1);
  } finally { vi.useRealTimers(); }
});
