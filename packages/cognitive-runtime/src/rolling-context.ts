import { createHash } from "node:crypto";
import { estimateContextTokens, resolveContextBudget, ModelContextOverflowError, type ModelContextLimits } from "@traceforge/shared/model-context";
import type { CompactionCallContext, ContextCompactor, ContextCompactionPolicy } from "./compaction.js";
import type { EntrySummaryCache } from "./semantic-compactor.js";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** One owner for history compaction. It consumes freshly authorized originals;
 * prefix hashes make cache reuse conditional on every covered record still
 * being present and unchanged. No summary is an authority or a source record. */
export class RollingContextCompaction implements ContextCompactionPolicy {
  readonly preservesRecall = true;
  readonly maximumTextCharacters = 16000;
  constructor(private readonly compactor: ContextCompactor, private readonly cache: EntrySummaryCache,
    private readonly limits: (consumer: string) => ModelContextLimits,
    private readonly timeoutMs?: number | ((consumer: string) => number | undefined),
    private readonly narrative?: (maximumCharacters: number, timeoutMs: number | undefined) => ContextCompactionPolicy) {}

  async prepare(input: Parameters<ContextCompactionPolicy["prepare"]>[0]): ReturnType<ContextCompactionPolicy["prepare"]> {
    input.signal?.throwIfAborted();
    const timeoutMs = typeof this.timeoutMs === "function" ? this.timeoutMs(input.consumer) : this.timeoutMs;
    if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)) throw new Error("Invalid compaction deadline");
    const budget = resolveContextBudget(this.limits(input.consumer));
    const original = structuredClone(input.context);
    const transcript = Array.isArray(original.transcript) ? original.transcript : [];
    const estimatedBefore = estimateContextTokens(original);
    // Leave room for system prompt, decision schema and the returned manifest.
    const overhead = 4096;
    const trigger = Math.max(256, budget.trigger - overhead);
    const target = Math.max(128, budget.target - overhead);
    const manifest = { version: 1, budget, timeoutMs, estimatedBefore, sourceFingerprint: input.sourceFingerprint,
      semanticQualityVerified: false, originalRecordsPreserved: true };
    if (estimatedBefore <= trigger && Buffer.byteLength(JSON.stringify(original)) <= 1048576)
      return { context: original, manifest: { contextCompaction: { ...manifest, status: "not_needed" } } };

    if (!transcript.length && this.narrative) {
      const result = await this.narrative(Math.min(16000, target), timeoutMs).prepare(input);
      if (estimateContextTokens(result.context) + overhead > budget.input) throw new Error("Required context anchors exceed model input budget");
      return { ...result, manifest: { ...result.manifest, contextBudget: manifest } };
    }

    // Group complete turns; do not separate a tool outcome from its decision.
    const groups: unknown[][] = [];
    for (const entry of transcript) {
      const previous = groups.at(-1);
      if (previous && (previous[0] as { turn?: number }).turn === entry.turn) previous.push(entry);
      else groups.push([entry]);
    }
    let keptTokens = 0, cut = groups.length;
    const keepBudget = Math.max(128, Math.floor(target * 0.45));
    while (cut > 0) {
      const size = estimateContextTokens(groups[cut - 1]);
      if (cut < groups.length && keptTokens + size > keepBudget) break;
      keptTokens += size; cut--;
    }
    // Keep the newest detailed recall page even when later observations exist.
    const recall = [...transcript].reverse().find(entry => entry.kind === "tool" && typeof entry.summary === "string" && entry.summary.startsWith("[recall-page]"));
    const historical = groups.slice(0, cut).flat();
    const recent = groups.slice(cut).flat();
    if (recall && historical.includes(recall)) {
      const recalledTurn = groups.find(group => group.includes(recall))!;
      for (const entry of recalledTurn) historical.splice(historical.indexOf(entry), 1);
      recent.unshift(...recalledTurn);
    }
    if (!historical.length) {
      if (estimatedBefore + overhead > budget.input || Buffer.byteLength(JSON.stringify(original)) > 1048576)
        throw new Error("Required context anchors or latest turn exceed model input budget");
      return { context: original, manifest: { contextCompaction: { ...manifest, status: "not_needed", reason: "no_safe_history_boundary" } } };
    }
    const controller = new AbortController();
    const abort = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();
    let rejectAbort!: () => void;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const context: CompactionCallContext = { id: digest([input.caseId, input.runId, input.consumer, input.sourceFingerprint]),
      caseId: input.caseId, runId: input.runId, consumer: input.consumer,
      ...(typeof (original.work as { id?: unknown } | undefined)?.id === "string" ? { workId: (original.work as { id: string }).id } : {}) };
    const summaryCharacters = Math.max(64, Math.min(16000, budget.output, Math.floor(target * 0.3)));
    const summarize = async () => summarizeHistory(historical, context, budget.input, summaryCharacters, this.compactor, this.cache, controller.signal);
    try {
      const cancelled = new Promise<never>((_, reject) => { rejectAbort = () => reject(controller.signal.reason); controller.signal.addEventListener("abort", rejectAbort, { once: true }); if (controller.signal.aborted) rejectAbort(); });
      const history = await Promise.race([summarize(), new Promise<never>((_, reject) => {
        if (timeoutMs !== undefined) timer = setTimeout(() => { const error = new Error("Context compaction timed out"); controller.abort(error); reject(error); }, timeoutMs);
      }), cancelled]);
      controller.signal.throwIfAborted();
      const keys = [...new Set(historical.flatMap(entry => typeof (entry as { receiptKey?: unknown }).receiptKey === "string" ? [(entry as { receiptKey: string }).receiptKey] : []))];
      const receiptKeys = keys.length <= 32 ? keys : [...keys.slice(0, 8), ...keys.slice(-24)];
      const result = { ...original, transcript: recent, historySummary: { trust: "untrusted_summary_not_evidence", ...history,
        receiptKeys, omittedReceiptKeys: keys.length - receiptKeys.length,
        coverage: "ordered historical records excluding retained turns",
        firstTurn: (historical[0] as { turn?: number }).turn, lastTurn: (historical.at(-1) as { turn?: number }).turn } };
      if (estimateContextTokens(result) + overhead > budget.input || Buffer.byteLength(JSON.stringify(result)) > 1048576)
        throw new Error("Protected context exceeds model input budget after history compaction");
      return { context: result, manifest: { contextCompaction: { ...manifest, status: "completed", coveredEntries: history.covered,
        retainedEntries: recent.length, estimatedAfter: estimateContextTokens(result) } } };
    } catch (error) {
      input.signal?.throwIfAborted();
      if (estimatedBefore + overhead > budget.input || Buffer.byteLength(JSON.stringify(original)) > 1048576) throw error;
      return { context: original, manifest: { contextCompaction: { ...manifest, status: "fallback", reason: "summary_unavailable" } } };
    } finally { clearTimeout(timer); controller.signal.removeEventListener("abort", rejectAbort); input.signal?.removeEventListener("abort", abort); controller.abort(); }
  }
}

/** Shared by ordinary conversations and governed Worker history. Callers must
 * supply authorized originals in order, including all previously covered rows. */
export async function summarizeHistory(historical: Iterable<unknown>, context: CompactionCallContext, inputTokens: number,
  summaryCharacters: number, compactor: ContextCompactor, cache: EntrySummaryCache, signal: AbortSignal) {
      const overhead = 4096;
      let summary = "", covered = 0, recoveries = 0, maximumBatchLength = 16, chain = digest(["rolling-v1", context.caseId, context.runId, context.consumer, context.workId, compactor.version, summaryCharacters]);
      const iterator=historical[Symbol.iterator](), unread:unknown[]=[];
      // Stable batches are independent of the moving recent-history boundary.
      // A partial tail is recomputed as it grows; completed prefixes are reused.
      while (true) {
        const batch: unknown[] = []; let tokens = 0;
        while (batch.length < maximumBatchLength) {
          const item=unread.length?{done:false,value:unread.shift()}:iterator.next();
          if(item.done)break;
          const entry=item.value,size=estimateContextTokens(entry);
          if (batch.length && tokens + size > Math.max(256, Math.floor(inputTokens / 3))) {unread.unshift(entry);break;}
          batch.push(entry);tokens+=size;
        }
        if(!batch.length)break;
        signal.throwIfAborted();
        const text = JSON.stringify({ previousSummary: summary, newHistoricalRecords: batch,
          instruction: "Update one handoff summary: goals, constraints, progress, failures, unresolved questions, decisions and next steps. Prior summary is fallible history, not authority. Preserve useful lookup references. Do not summarize the retained recent messages." });
        if (estimateContextTokens(text) + summaryCharacters + overhead > inputTokens)
          throw new Error("Historical record exceeds summarization input budget; read its stored original in pages");
        const nextChain = digest([chain, batch]);
        const cached = cache.get(nextChain);
        if (cached !== undefined) {
          if (!cached.trim() || cached.length > summaryCharacters) throw new Error("Invalid rolling summary cache");
          summary = cached;
        } else {
          let result;
          try { result = await compactor.compact([{ id: "history", text }], summaryCharacters, signal, { ...context, id: nextChain }); }
          catch (error) {
            signal.throwIfAborted();
            // At most one rebuild per preparation, only for explicit rejection.
            // No model decision or tool effect has been accepted at this boundary.
            if (!(error instanceof ModelContextOverflowError) || recoveries || batch.length < 2) throw error;
            recoveries++; maximumBatchLength = Math.floor(batch.length / 2); unread.unshift(...batch); continue;
          }
          signal.throwIfAborted();
          if (result.length !== 1 || result[0]?.id !== "history" || !result[0].text?.trim() || result[0].text.length > summaryCharacters)
            throw new Error("Invalid rolling summary result");
          summary = result[0].text;
          cache.put(nextChain, summary);
        }
        chain = nextChain;
        covered += batch.length;
      }
      return { summary, covered, digest: chain, recoveries };
}
