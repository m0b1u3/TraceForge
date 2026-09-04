import type Database from "better-sqlite3";
import type { ScenarioRunState } from "@traceforge/orchestration-core";
import { toolInvocationInputFingerprint, type WorkerModelRequest } from "@traceforge/worker-runtime";
import {
  CONTEXT_WITHHELD_TEXT,
  projectRunContextLineage,
  type CognitiveContextRole,
  type CognitiveSnapshotRecord,
  type ContextLineageDerivation,
  type ContextLineageManifest,
  type ContextLineageSource,
  type RunContextInput,
} from "@traceforge/cognitive-runtime";
import { PackageContextDiscoverySource } from "./package-context-resources.js";
import { SqliteToolReceiptStore } from "./worker-execution-adapters.js";
import type { SqliteCognitiveSnapshotStore } from "./cognitive-context-snapshots.js";

/** Conservative structural provenance; never edits durable Run or Evidence Graph state. */
export class RunContextPolicy {
  constructor(private readonly sqlite: Database.Database, private readonly resources: PackageContextDiscoverySource,
    private readonly loadRun: (id: string) => ScenarioRunState | null, private readonly snapshots: SqliteCognitiveSnapshotStore) {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS context_derivations (
      case_id TEXT NOT NULL, run_id TEXT NOT NULL, target_kind TEXT NOT NULL, target_id TEXT NOT NULL,
      snapshot_id TEXT NOT NULL, sources_json TEXT NOT NULL, PRIMARY KEY(run_id,target_kind,target_id,snapshot_id));
      CREATE INDEX IF NOT EXISTS context_derivations_run ON context_derivations(run_id);
      CREATE TRIGGER IF NOT EXISTS context_derivations_bounded BEFORE INSERT ON context_derivations BEGIN
        SELECT CASE WHEN (SELECT count(*) FROM context_derivations)>=8192 OR length(CAST(NEW.sources_json AS BLOB))>32768
          THEN RAISE(ABORT,'Context derivation budget exceeded') END;
        SELECT execution_physical_admit(execution_floor, maximum_database_bytes, maximum_wal_bytes,
          length(CAST(NEW.sources_json AS BLOB))+2048,'execution') FROM execution_physical_policy WHERE id=1;
      END;
      CREATE TRIGGER IF NOT EXISTS context_derivations_keep BEFORE DELETE ON context_derivations
        BEGIN SELECT RAISE(ABORT,'Context derivation is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS context_derivations_immutable BEFORE UPDATE ON context_derivations
        BEGIN SELECT RAISE(ABORT,'Context derivation is immutable'); END;`);
  }

  private async lineage(run: ScenarioRunState, role: CognitiveContextRole, readerWorkId?: string) {
    const rows = this.sqlite.prepare(`SELECT idempotency_key,work_id,case_id FROM tool_invocation_bindings
      WHERE run_id=? AND tool_source=? ORDER BY idempotency_key LIMIT 257`).all(run.id, this.resources.source) as Array<{ idempotency_key: string; work_id: string; case_id: string }>;
    const derived = this.sqlite.prepare("SELECT target_kind,target_id,snapshot_id,sources_json,case_id FROM context_derivations WHERE run_id=? ORDER BY target_kind,target_id,snapshot_id LIMIT 513")
      .all(run.id) as Array<ContextLineageDerivation & { case_id: string }>;
    if (rows.length > 256 || derived.length > 512 || run.workItems.length > 512 || run.outputs.length > 512 || run.directives.length > 512) throw new Error("Run context lineage budget exceeded");
    const receipts = new SqliteToolReceiptStore(this.sqlite), sources: ContextLineageSource[] = [];
    const selections = new Map<string, ReturnType<PackageContextDiscoverySource["selectionForReader"]> | null>();
    for (const row of rows) {
      if (row.case_id !== run.caseId) throw new Error("Context receipt Case mismatch");
      const selectionWorkId = role === "worker" ? readerWorkId ?? row.work_id : run.workItems[0]?.id ?? row.work_id;
      if (!selections.has(selectionWorkId)) {
        try { selections.set(selectionWorkId, this.resources.selectionForReader(run.id, run.caseId, selectionWorkId, role)); }
        catch { selections.set(selectionWorkId, null); }
      }
      const receipt = await receipts.get(row.idempotency_key), selection = selections.get(selectionWorkId)!;
      // Terminal rejected reads carried no resource text. Missing or interrupted observations are not trusted.
      if (receipt && receipt.status !== "succeeded") continue;
      let valid = false;
      if (receipt && selection) {
        try {
          const raw = JSON.parse(receipt.raw);
          const entries = Array.isArray(raw.entries) ? raw.entries : [raw];
          valid = run.workItems.some((w) => w.id === row.work_id) && raw.trust === "untrusted_context" && raw.caseId === run.caseId && raw.runId === run.id && raw.workId === row.work_id
            && toolInvocationInputFingerprint("package", raw.package) === toolInvocationInputFingerprint("package", run.scenarioPackage)
            && entries.every((item: { id: string; digest: string; version: number }) => selection.resources.some((r) => r.id === item.id && r.digest === item.digest && r.version === item.version));
        } catch { /* Missing provenance is not authority. */ }
      }
      sources.push({ key: row.idempotency_key, workId: row.work_id, valid, refs: receipt?.refs ?? [],
        fingerprint: toolInvocationInputFingerprint("context.receipt", receipt ?? null) });
    }
    if (derived.some((row) => row.case_id !== run.caseId)) throw new Error("Context derivation Case mismatch");
    const fingerprint = toolInvocationInputFingerprint("context.lineage", { role, scopeRef: run.scopeRef, phase: run.activePhaseId, package: run.scenarioPackage, sources, derived });
    return { sources, derived, fingerprint };
  }

  async fingerprint(run: ScenarioRunState, role: CognitiveContextRole, readerWorkId?: string): Promise<string> { return (await this.lineage(run, role, readerWorkId)).fingerprint; }

  async prepare(input: RunContextInput, role: CognitiveContextRole, readerWorkId?: string) {
    const { sources, derived, fingerprint } = await this.lineage(input.run, role, readerWorkId);
    return projectRunContextLineage(input, { role, sources, derived, fingerprint });
  }

  async projectWorker(input: WorkerModelRequest) {
    const run = this.loadRun(input.assignment.runId);
    if (!run || run.caseId !== input.assignment.runContext.caseId) throw new Error("Worker context Run mismatch");
    const projected = await this.prepare({ run, graph: { caseId: run.caseId, revision: 0, nodes: [], edges: [], createdAt: "", updatedAt: "" }, recentEvents: [] }, "worker", input.assignment.work.id);
    const request = structuredClone(input), m = projected.manifest.contextLineage;
    // Own direct receipts already undergo exact lease-aware Worker projection. Inherited dependencies need this second boundary.
    const inherited = this.sqlite.prepare("SELECT sources_json FROM context_derivations WHERE run_id=? AND target_kind='work' AND target_id=? LIMIT 513")
      .all(run.id, input.assignment.work.id) as { sources_json: string }[];
    const valid = new Set(m.sources.filter((s) => s.valid).map((s) => s.key));
    const inheritedInvalid = inherited.some((row) => (JSON.parse(row.sources_json) as string[]).some((key) => !valid.has(key)))
      || (!!input.assignment.work.retryOf && m.withheldWorkIds.includes(input.assignment.work.retryOf));
    if (inheritedInvalid) {
      const work = projected.run.workItems.find((w) => w.id === input.assignment.work.id)!;
      request.assignment.work = { ...request.assignment.work, title: work.title, objective: work.objective, resultSummary: null, error: null, latestCheckpoint: null, pendingApproval: null, approvalHistory: [] };
      request.transcript = []; request.steering = [CONTEXT_WITHHELD_TEXT];
    } else if (m.withheldDirectiveIds.length) {
      request.steering = []; request.transcript = request.transcript.filter((t) => t.kind === "tool");
    }
    request.assignment.runContext.directives = request.assignment.runContext.directives.filter((d) => !m.withheldDirectiveIds.includes(d.id));
    return { request, manifest: projected.manifest };
  }

  async assertSnapshotCurrent(id: string): Promise<void> {
    const snapshot = this.snapshots.get(id);
    if (!snapshot) throw new Error("Missing lineage snapshot");
    const lineage = snapshot.contextManifest.contextLineage as ContextLineageManifest | undefined;
    if (!lineage) throw new Error("Snapshot has no current context lineage");
    const run = this.loadRun(snapshot.runId);
    if (!run || run.caseId !== snapshot.caseId || run.status !== "running" || await this.fingerprint(run, lineage.role, snapshot.workId ?? undefined) !== lineage.fingerprint) throw new Error("Context sources changed before decision application");
  }

  async recordDerivations(snapshotId: string, targets: Array<{ kind: "work" | "directive"; id: string }>): Promise<void> {
    await this.assertSnapshotCurrent(snapshotId);
    const snapshot = this.snapshots.get(snapshotId)!;
    const manifest = snapshot.contextManifest.contextLineage as ContextLineageManifest;
    const keys = manifest.sources.filter((source) => source.valid).map((source) => source.key);
    if (!keys.length) return;
    this.sqlite.transaction(() => {
      for (const target of targets) {
        if (target.id.length > 512) throw new Error("Context target budget exceeded");
        const previous = this.sqlite.prepare("SELECT sources_json FROM context_derivations WHERE run_id=? AND target_kind=? AND target_id=? AND snapshot_id=?")
          .get(snapshot.runId, target.kind, target.id, snapshotId) as { sources_json: string } | undefined;
        if (previous) { if (previous.sources_json !== JSON.stringify(keys)) throw new Error("Context derivation conflict"); continue; }
        this.sqlite.prepare("INSERT INTO context_derivations VALUES (?,?,?,?,?,?)").run(snapshot.caseId, snapshot.runId, target.kind, target.id, snapshotId, JSON.stringify(keys));
      }
    })();
  }

  assertReplayAllowed(snapshot: CognitiveSnapshotRecord): void {
    const manifest = snapshot.contextManifest.contextLineage as ContextLineageManifest | undefined;
    if (manifest?.sources.length || this.sqlite.prepare("SELECT 1 FROM tool_invocation_bindings WHERE run_id=? AND tool_source=? LIMIT 1").get(snapshot.runId, this.resources.source)) throw new Error("Resource-derived snapshot requires current context projection");
  }
}
