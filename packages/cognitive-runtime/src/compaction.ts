import { createHash } from "node:crypto";
import { canonicalJson } from "@traceforge/orchestration-core";

export interface ContextTextEntry { id: string; text: string }
export interface ContextCompactor {
  /** Version is part of immutable cache identity. A changed implementation needs a new version. */
  version: string;
  compact(entries: readonly ContextTextEntry[], maximumCharacters: number, signal: AbortSignal): Promise<ContextTextEntry[]>;
}
export interface ContextCompactionRecord {
  id: string; caseId: string; runId: string; consumer: string; inputFingerprint: string; protectedFingerprint: string;
  sourceFingerprint: string; compactorVersion: string; status: "prepared" | "completed" | "failed";
  entries: ContextTextEntry[] | null; error: string | null; sourceIds: string[];
}
export interface ContextCompactionStore {
  get(id: string): ContextCompactionRecord | undefined;
  prepare(record: ContextCompactionRecord): void;
  finish(id: string, entries: ContextTextEntry[] | null, error: string | null): void;
}
export interface ContextCompactionPolicy {
  prepare(input: { caseId: string; runId: string; consumer: string; context: Record<string, unknown>; sourceFingerprint: string }): Promise<{
    context: Record<string, unknown>; manifest: Record<string, unknown>;
  }>;
}

/** Extractive default only: preserves an explicit prefix/suffix, never claims semantic completeness. */
export class ExtractiveContextCompactor implements ContextCompactor {
  readonly version = "bounded-extract-v1";
  async compact(entries: readonly ContextTextEntry[], maximumCharacters: number): Promise<ContextTextEntry[]> {
    const allowance = Math.floor(maximumCharacters / Math.max(1, entries.length));
    if (allowance < 64) throw new Error("Too many text entries to compress safely");
    return entries.map(({ id, text }) => ({ id, text: text.length <= allowance ? text
      : `${text.slice(0, allowance - 40)} [omitted] ${text.slice(-29)}` }));
  }
}

export const contextFingerprint = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");

/** Host preserves the structural document; a compactor can replace text entries only. */
export class ContextCompactionRuntime implements ContextCompactionPolicy {
  constructor(private readonly store: ContextCompactionStore, private readonly compactor: ContextCompactor = new ExtractiveContextCompactor(),
    private readonly limits = { triggerCharacters: 24000, maximumTextCharacters: 16000, maximumContextBytes: 262144, timeoutMs: 1000 }) {
    if (Object.values(limits).some((n) => !Number.isSafeInteger(n) || n < 1) || limits.maximumContextBytes > 1048576
      || !compactor.version.trim() || compactor.version.length > 128) throw new Error("Invalid compaction configuration");
  }

  async prepare(input: { caseId: string; runId: string; consumer: string; context: Record<string, unknown>; sourceFingerprint: string }): ReturnType<ContextCompactionPolicy["prepare"]> {
    const original = structuredClone(input.context), entries: ContextTextEntry[] = [];
    if (Buffer.byteLength(JSON.stringify(original)) > 1048576) throw new Error("Compaction source exceeds hard input bound");
    // Only these narrative fields can be transformed. Goal, identifiers, statuses, references,
    // leases, approvals, tool schemas, graph properties and active task instructions stay exact.
    const protectedContext = structuredClone(original);
    const extract = (value: unknown, path: string, enabled: boolean, depth = 0): void => {
      if (depth > 32) throw new Error("Compaction document depth exceeded");
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { value.forEach((item, i) => extract(item, `${path}/${i}`, enabled, depth + 1)); return; }
      const record = value as Record<string, unknown>;
      for (const [key, child] of Object.entries(record)) {
        const id = `${path}/${key}`;
        if (enabled && typeof child === "string" && ["summary", "resultSummary", "rationale"].includes(key) && child.length > 128) {
          entries.push({ id, text: child }); record[key] = { contextTextId: id };
        } else extract(child, id, enabled && !["properties", "input", "inputSchema", "schema", "pendingApproval", "approvalHistory", "latestCheckpoint"].includes(key), depth + 1);
      }
    };
    // Do not traverse Host provenance manifests or tool schemas.
    for (const key of ["run", "work", "graph", "recentEvents", "transcript"]) extract(protectedContext[key], `/${key}`, true);
    if (entries.length > 512) throw new Error("Compaction text entry budget exceeded");
    const inputFingerprint = contextFingerprint(original), protectedFingerprint = contextFingerprint(protectedContext);
    const sourceIds = entries.map((entry) => entry.id);
    const baseManifest = { version: 1, inputFingerprint, protectedFingerprint, sourceFingerprint: input.sourceFingerprint,
      compactorVersion: this.compactor.version, sourceIds, preservedStructure: true, semanticQualityVerified: false };
    const originalFits = Buffer.byteLength(JSON.stringify(original)) <= this.limits.maximumContextBytes;
    if (!entries.length || entries.reduce((sum, entry) => sum + entry.text.length, 0) <= this.limits.triggerCharacters) {
      if (!originalFits) throw new Error("Required context anchors exceed model input budget");
      return { context: original, manifest: { contextCompaction: { ...baseManifest, status: "not_needed", outputFingerprint: inputFingerprint } } };
    }
    const id = contextFingerprint({ caseId: input.caseId, runId: input.runId, consumer: input.consumer,
      inputFingerprint, sourceFingerprint: input.sourceFingerprint, compactor: this.compactor.version, limits: this.limits });
    let record = this.store.get(id);
    let replayed = !!record;
    if (!record) {
      record = { id, caseId: input.caseId, runId: input.runId, consumer: input.consumer, inputFingerprint, protectedFingerprint,
        sourceFingerprint: input.sourceFingerprint, compactorVersion: this.compactor.version, sourceIds, status: "prepared", entries: null, error: null };
      this.store.prepare(record);
      const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("Compaction deadline exceeded")); }, this.limits.timeoutMs); });
        const result = await Promise.race([Promise.resolve().then(() => this.compactor.compact(structuredClone(entries), this.limits.maximumTextCharacters, controller.signal)), timeout]);
        validateEntries(result, sourceIds, this.limits.maximumTextCharacters);
        this.store.finish(id, result, null);
      } catch { this.store.finish(id, null, "Compaction failed, timed out, or returned incompatible text references"); }
      finally { if (timer) clearTimeout(timer); controller.abort(); }
      record = this.store.get(id)!;
    }
    if (record.caseId !== input.caseId || record.runId !== input.runId || record.consumer !== input.consumer || record.inputFingerprint !== inputFingerprint
      || record.protectedFingerprint !== protectedFingerprint || record.sourceFingerprint !== input.sourceFingerprint || record.compactorVersion !== this.compactor.version) throw new Error("Compaction cache identity mismatch");
    if (record.status === "completed") {
      validateEntries(record.entries, sourceIds, this.limits.maximumTextCharacters);
      const context = { ...protectedContext, compactedText: { trust: "untrusted_summary", entries: record.entries } };
      if (Buffer.byteLength(JSON.stringify(context)) <= this.limits.maximumContextBytes) return { context,
        manifest: { contextCompaction: { ...baseManifest, id, status: "completed", replayed, outputFingerprint: contextFingerprint(context) } } };
    }
    if (!originalFits) throw new Error("Compaction unavailable and original exceeds safe context budget");
    return { context: original, manifest: { contextCompaction: { ...baseManifest, id, status: "fallback", replayed,
      reason: record.status === "prepared" ? "interrupted_or_in_progress" : "summary_unavailable_or_oversized", outputFingerprint: inputFingerprint } } };
  }
}

function validateEntries(value: unknown, ids: string[], maximumCharacters: number): asserts value is ContextTextEntry[] {
  if (!Array.isArray(value) || value.length !== ids.length || value.some((e, i) => !e || typeof e !== "object" || e.id !== ids[i]
    || typeof e.text !== "string" || !e.text.trim() || Object.keys(e).some((key) => !["id", "text"].includes(key)))
    || value.reduce((sum, e) => sum + e.text.length, 0) > maximumCharacters) throw new Error("Compactor changed required references or exceeded budget");
}
