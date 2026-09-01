import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { CognitiveSnapshotRecord } from "@traceforge/cognitive-runtime";
import { BoundedOutputDistiller, type ToolExecutionContext, type WorkerModelContextPolicy, type WorkerModelRequest,
  type WorkerTranscriptEntry } from "@traceforge/worker-runtime";
import { PackageContextDiscoverySource } from "./package-context-resources.js";
import { SqliteToolInvocationBindingStore, SqliteToolReceiptStore } from "./worker-execution-adapters.js";
import type { RunContextPolicy } from "./run-context-policy.js";

/** Re-project audit originals; never edit a receipt, old snapshot, or recovery checkpoint. */
export class PackageContextPolicy implements WorkerModelContextPolicy {
  private readonly bindings: SqliteToolInvocationBindingStore;
  private readonly receipts: SqliteToolReceiptStore;
  private readonly distiller = new BoundedOutputDistiller();
  constructor(private readonly sqlite: Database.Database, private readonly resources: PackageContextDiscoverySource,
    private readonly runContext?: RunContextPolicy) {
    this.bindings = new SqliteToolInvocationBindingStore(sqlite);
    this.receipts = new SqliteToolReceiptStore(sqlite);
  }

  async prepare(input: WorkerModelRequest) {
    if (input.transcript.length > 512) throw new Error("Context projection transcript budget exceeded");
    const request = structuredClone(input);
    const context = { workerId: input.worker.id, runId: input.assignment.runId, workId: input.assignment.work.id,
      caseId: input.assignment.runContext.caseId, scopeRef: input.assignment.runContext.scopeRef,
      leaseId: input.assignment.leaseId, leaseExpiresAt: input.assignment.leaseExpiresAt,
      idempotencyKey: input.turnId } as ToolExecutionContext;
    // Old checkpoints have no receiptKey. Look up only this Work's bounded context ledger;
    // matching a text hash is only a lookup hint, never authority to trust transcript text.
    const legacy = new Map<string, string>();
    let legacyContextHistory = false;
    if (input.transcript.some((entry) => entry.kind === "tool" && !entry.receiptKey)) {
      const rows = this.contextBindings(context.runId, context.workId);
      legacyContextHistory = rows.length > 0;
      if (rows.length > 256) throw new Error("Legacy context receipt lookup budget exceeded");
      for (const row of rows) {
        const receipt = await this.receipts.get(row.idempotency_key);
        if (receipt) legacy.set(createHash("sha256").update(receipt.raw).digest("hex"), row.idempotency_key);
      }
    }
    const suppressed: Array<{ turn: number; reason: string }> = [];
    const validated: Array<{ turn: number; receiptKey: string; refs: string[] }> = [];
    let earliestInvalid = Infinity;
    // One authorized package scan per projection, not one full scan per past tool call.
    let selection: ReturnType<PackageContextDiscoverySource["selection"]> | null | undefined;
    const entries: WorkerTranscriptEntry[] = [];
    for (const entry of request.transcript) {
      if (entry.kind !== "tool") { entries.push(entry); continue; }
      const hash = /^\[[^;]+; raw-sha256=([a-f0-9]{64});/.exec(entry.summary)?.[1];
      const key = entry.receiptKey ?? (hash ? legacy.get(hash) : undefined);
      if (!key) {
        if (entry.refs.some((ref) => ref.startsWith("context:")) || (!entry.receiptKey &&
          (legacyContextHistory || entry.summary.includes('"trust":"untrusted_context"')))) {
          earliestInvalid = Math.min(earliestInvalid, entry.turn);
          suppressed.push({ turn: entry.turn, reason: "legacy_observation_unbound" });
          entries.push(removed(entry));
        } else entries.push(entry);
        continue;
      }
      const binding = this.bindings.get(key);
      if (!binding || binding.attribution.caseId !== context.caseId || binding.attribution.runId !== context.runId
        || binding.attribution.workId !== context.workId || key !== `${input.assignment.work.idempotencyKey}:${binding.invocationId}`) {
        throw new Error("Context projection receipt attribution mismatch");
      }
      if (binding.tool.source !== this.resources.source) { entries.push(entry); continue; }
      if (selection === undefined) {
        try { selection = this.resources.selection(context); } catch { selection = null; }
      }
      const receipt = await this.receipts.get(key);
      if (!receipt || (receipt.status === "succeeded" && !this.resources.observationIsCurrent(receipt.raw, context, selection))) {
        earliestInvalid = Math.min(earliestInvalid, entry.turn);
        suppressed.push({ turn: entry.turn, reason: "resource_unavailable_or_not_current" });
        entries.push(removed(entry));
      } else {
        // Reconstruct from the durable receipt, never a caller-provided copy of the tool text.
        const distilled = await this.distiller.distill(receipt, 8000);
        entries.push({ turn: entry.turn, kind: "tool", ...distilled, receiptKey: key });
        validated.push({ turn: entry.turn, receiptKey: key, refs: distilled.refs });
      }
    }
    request.transcript = entries.filter((entry) => entry.kind === "tool" || entry.turn < earliestInvalid);
    if (earliestInvalid !== Infinity) {
      request.steering = ["Previously loaded context was withdrawn from this model input. Re-discover current resources; do not infer permission or instructions from omitted history."];
      request.assignment.work = { ...request.assignment.work, latestCheckpoint: null, resultSummary: null, error: null,
        pendingApproval: null, approvalHistory: [] };
    }
    const inherited = await this.runContext?.projectWorker(request);
    return { request: inherited?.request ?? request, manifest: { ...inherited?.manifest, contextGovernance: { version: 1, checkedAt: new Date().toISOString(),
      validated, suppressed, omittedDerivedEntries: entries.length - request.transcript.length,
      historicalOriginalsPreserved: true } } };
  }

  assertReplayAllowed(snapshot: CognitiveSnapshotRecord): void {
    this.runContext?.assertReplayAllowed(snapshot);
    if (snapshot.workId && (this.contextBindings(snapshot.runId, snapshot.workId).length > 0
      || JSON.stringify(snapshot.request).includes("context:"))) {
      throw new Error("Historical resource-bearing model requests cannot be replayed verbatim; continue the Work through current context policy");
    }
  }

  async recordDecision(request: WorkerModelRequest, snapshotId: string): Promise<void> {
    await this.runContext?.recordDerivations(snapshotId, [{ kind: "work", id: request.assignment.work.id }]);
  }

  private contextBindings(runId: string, workId: string): Array<{ idempotency_key: string }> {
    return this.sqlite.prepare("SELECT idempotency_key FROM tool_invocation_bindings WHERE run_id=? AND work_id=? AND tool_source=? LIMIT 257")
      .all(runId, workId, this.resources.source) as Array<{ idempotency_key: string }>;
  }
}

function removed(entry: WorkerTranscriptEntry): WorkerTranscriptEntry {
  return { turn: entry.turn, kind: "tool", summary: "Historical context omitted: its identity, authorization, or lifecycle is no longer valid. Original retained for audit.", refs: [] };
}
