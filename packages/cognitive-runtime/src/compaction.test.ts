import { describe, expect, it } from "vitest";
import { ContextCompactionRuntime, ExtractiveContextCompactor, type ContextCompactionRecord, type ContextCompactionStore, type ContextCompactor } from "./compaction.js";

class Store implements ContextCompactionStore {
  rows = new Map<string, ContextCompactionRecord>();
  get(id: string) { return structuredClone(this.rows.get(id)); }
  prepare(record: ContextCompactionRecord) { this.rows.set(record.id, structuredClone(record)); }
  finish(id: string, entries: ContextCompactionRecord["entries"], error: string | null) {
    const row = this.rows.get(id)!; this.rows.set(id, { ...row, entries: structuredClone(entries), error, status: error ? "failed" : "completed" });
  }
}
const limits = { triggerCharacters: 256, maximumTextCharacters: 200, maximumContextBytes: 8192, timeoutMs: 20 };
function input() { return { caseId: "case", runId: "run", consumer: "worker", sourceFingerprint: "sources-1", context: {
  run: { id: "run", scopeRef: "scope", goal: "Original goal", workItems: [{ id: "pending", status: "queued", objective: "Do not lose this instruction", evidenceRefs: ["early-evidence"] }] },
  transcript: [{ turn: 1, kind: "tool", receiptKey: "first-receipt", refs: ["first-evidence"], summary: "first observation ".repeat(80) },
    { turn: 2, kind: "tool", receiptKey: "last-receipt", refs: ["last-evidence"], summary: "last observation ".repeat(80) }],
} }; }
describe("Bounded context compaction lifecycle", () => {
  it("preserves early/later identities, task instructions and exact references without mutating input", async () => {
    const original = input(), before = JSON.stringify(original), store = new Store();
    const result = await new ContextCompactionRuntime(store, undefined, limits).prepare(original);
    expect(result.context.run).toEqual(original.context.run);
    expect(result.context.transcript).toMatchObject([{ receiptKey: "first-receipt", refs: ["first-evidence"] }, { receiptKey: "last-receipt", refs: ["last-evidence"] }]);
    expect(result.context.compactedText).toMatchObject({ trust: "untrusted_summary", entries: [{ id: "/transcript/0/summary" }, { id: "/transcript/1/summary" }] });
    expect(result.manifest.contextCompaction).toMatchObject({ status: "completed", semanticQualityVerified: false });
    expect(JSON.stringify(original)).toBe(before); expect(store.rows.size).toBe(1);
  });
  it("reuses an exact completed record after runtime reconstruction, not across identity/source changes", async () => {
    const store = new Store(); let calls = 0;
    const compactor = { version: "test", async compact(...args: Parameters<ExtractiveContextCompactor["compact"]>) { calls++; return new ExtractiveContextCompactor().compact(...args); } };
    await new ContextCompactionRuntime(store, compactor, limits).prepare(input());
    const second = await new ContextCompactionRuntime(store, compactor, limits).prepare(input());
    expect(second.manifest.contextCompaction).toMatchObject({ replayed: true }); expect(calls).toBe(1);
    for (const change of [{ caseId: "other" }, { runId: "other" }, { consumer: "observer" }, { sourceFingerprint: "sources-2" }]) await new ContextCompactionRuntime(store, compactor, limits).prepare({ ...input(), ...change });
    expect(calls).toBe(5);
  });
  it.each(["missing", "reordered", "invented", "oversized", "throw"])("falls back on %s compactor output without losing originals", async (mode) => {
    const store = new Store(); const source = input();
    const adapter: ContextCompactor = { version: "broken", async compact(entries) {
      if (mode === "throw") throw new Error("fixture");
      if (mode === "missing") return [];
      if (mode === "reordered") return [...entries].reverse().map((e) => ({ ...e, text: "short" }));
      return entries.map((e) => ({ id: mode === "invented" ? "invented" : e.id, text: "x".repeat(300) }));
    } };
    const result = await new ContextCompactionRuntime(store, adapter, limits).prepare(source);
    expect(result.context).toEqual(source.context); expect(result.manifest.contextCompaction).toMatchObject({ status: "fallback" });
    expect([...store.rows.values()][0]!.status).toBe("failed");
  });
  it("bounds a non-cooperating compactor and ignores late results", async () => {
    let done!: (value: Array<{ id: string; text: string }>) => void;
    const store = new Store(), adapter: ContextCompactor = { version: "late", compact: () => new Promise((resolve) => { done = resolve; }) };
    const result = await new ContextCompactionRuntime(store, adapter, limits).prepare(input());
    done([{ id: "/transcript/0/summary", text: "late" }, { id: "/transcript/1/summary", text: "late" }]);
    await Promise.resolve(); expect(result.manifest.contextCompaction).toMatchObject({ status: "fallback" });
    expect([...store.rows.values()][0]!.status).toBe("failed");
  });
  it("refuses instead of dropping protected structure when no safe fallback fits", async () => {
    const source = input(); source.context.run.goal = "x".repeat(10000);
    await expect(new ContextCompactionRuntime(new Store(), undefined, limits).prepare(source)).rejects.toThrow("budget");
  });
  it("keeps tool schemas, approval fields and graph properties outside the compactor", async () => {
    const source = input() as any; source.context.work = { pendingApproval: { rationale: "permission ".repeat(100) } };
    source.context.graph = { nodes: [{ id: "node", properties: { summary: "protected ".repeat(100) } }] };
    const result = await new ContextCompactionRuntime(new Store(), undefined, limits).prepare(source);
    expect(result.context.work).toEqual(source.context.work); expect(result.context.graph).toEqual(source.context.graph);
  });
  it("does not silently trust tampered cached identities", async () => {
    const store = new Store(), runtime = new ContextCompactionRuntime(store, undefined, limits);
    await runtime.prepare(input()); [...store.rows.values()][0]!.sourceFingerprint = "changed";
    await expect(runtime.prepare(input())).rejects.toThrow("identity");
  });
});
