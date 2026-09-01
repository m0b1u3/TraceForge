import type Database from "better-sqlite3";
import type { EvidenceGraphState } from "@traceforge/evidence-graph";
import type { ScenarioEvent, ScenarioRunState } from "@traceforge/orchestration-core";
import { toolInvocationInputFingerprint, type WorkerModelRequest } from "@traceforge/worker-runtime";
import type { CognitiveSnapshotRecord } from "@traceforge/cognitive-runtime";
import { PackageContextDiscoverySource } from "./package-context-resources.js";
import { SqliteToolReceiptStore } from "./worker-execution-adapters.js";
import type { SqliteCognitiveSnapshotStore } from "./cognitive-context-snapshots.js";

type Role = "planner" | "observer" | "worker";
interface Source { key: string; workId: string; fingerprint: string; refs: string[]; valid: boolean }
interface Derivation { target_kind: "work" | "directive"; target_id: string; snapshot_id: string; sources_json: string }
export interface RunContextInput { run: ScenarioRunState; graph: EvidenceGraphState; recentEvents: ScenarioEvent[] }
export interface ContextLineageManifest {
  version: 1; role: Role; fingerprint: string; sources: Source[]; parents: string[];
  withheldWorkIds: string[]; withheldDirectiveIds: string[]; withheldNodeIds: string[]; omittedEvents: number;
}

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

  private async lineage(run: ScenarioRunState, role: Role, readerWorkId?: string) {
    const rows = this.sqlite.prepare(`SELECT idempotency_key,work_id,case_id FROM tool_invocation_bindings
      WHERE run_id=? AND tool_source=? ORDER BY idempotency_key LIMIT 257`).all(run.id, this.resources.source) as Array<{ idempotency_key: string; work_id: string; case_id: string }>;
    const derived = this.sqlite.prepare("SELECT target_kind,target_id,snapshot_id,sources_json,case_id FROM context_derivations WHERE run_id=? ORDER BY target_kind,target_id,snapshot_id LIMIT 513")
      .all(run.id) as Array<Derivation & { case_id: string }>;
    if (rows.length > 256 || derived.length > 512 || run.workItems.length > 512 || run.outputs.length > 512 || run.directives.length > 512) throw new Error("Run context lineage budget exceeded");
    const receipts = new SqliteToolReceiptStore(this.sqlite), sources: Source[] = [];
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

  async fingerprint(run: ScenarioRunState, role: Role, readerWorkId?: string): Promise<string> { return (await this.lineage(run, role, readerWorkId)).fingerprint; }

  async prepare(input: RunContextInput, role: Role, readerWorkId?: string) {
    if (input.graph.caseId !== input.run.caseId || input.graph.nodes.length > 2048 || input.graph.edges.length > 4096 || input.recentEvents.length > 4096) throw new Error("Invalid Run context bounds or Case");
    const { sources, derived, fingerprint } = await this.lineage(input.run, role, readerWorkId);
    const valid = new Set(sources.filter((s) => s.valid).map((s) => s.key));
    const bad = sources.filter((s) => !s.valid);
    const workIds = new Set(bad.map((s) => s.workId)), directiveIds = new Set<string>();
    for (const row of derived) {
      const keys = JSON.parse(row.sources_json) as string[];
      if (!Array.isArray(keys) || keys.length > 256) throw new Error("Invalid context derivation");
      if (keys.some((key) => !valid.has(key))) (row.target_kind === "work" ? workIds : directiveIds).add(row.target_id);
    }
    // Retry descendants inherit the source Work's contextual dependencies.
    for (let n = 0; n < input.run.workItems.length; n++) {
      let changed = false;
      for (const work of input.run.workItems) if (work.retryOf && workIds.has(work.retryOf) && !workIds.has(work.id)) { workIds.add(work.id); changed = true; }
      if (!changed) break;
    }
    if (bad.length) for (const directive of input.run.directives) {
      if (!derived.some((d) => d.target_kind === "directive" && d.target_id === directive.id)) directiveIds.add(directive.id);
    }
    const tainted = new Set([...bad.flatMap((s) => [s.key, ...s.refs]), ...workIds, ...directiveIds,
      ...input.run.outputs.filter((o) => workIds.has(o.producedByWorkId)).flatMap((o) => [o.id, ...o.refs])]);
    const nodeIds = new Set<string>();
    const visibleNodes = input.graph.nodes.filter((node) => node.caseId === input.run.caseId && (node.runId === null || node.runId === input.run.id));
    for (const node of visibleNodes) if (node.source && tainted.has(node.source.ref)) nodeIds.add(node.id);
    for (let n = 0; n < visibleNodes.length; n++) {
      let changed = false;
      for (const edge of input.graph.edges) {
        const reverse = ["derived_from", "depends_on"].includes(edge.relation);
        const source = reverse ? edge.targetId : edge.sourceId, target = reverse ? edge.sourceId : edge.targetId;
        if (nodeIds.has(source) && !nodeIds.has(target)) { nodeIds.add(target); changed = true; }
      }
      if (!changed) break;
    }
    const request = structuredClone(input);
    request.run.workItems = request.run.workItems.map((work) => workIds.has(work.id) ? {
      ...work, title: omitted, objective: omitted, resultSummary: null, error: null, latestCheckpoint: null,
      pendingApproval: null, approvalHistory: [],
    } : work);
    request.run.outputs = request.run.outputs.map((output) => workIds.has(output.producedByWorkId) ? { ...output, summary: omitted } : output);
    request.run.directives = request.run.directives.filter((d) => !directiveIds.has(d.id));
    request.graph.nodes = visibleNodes.map((node) => nodeIds.has(node.id) ? { ...structuredClone(node), title: omitted, summary: omitted, properties: {}, source: null } : structuredClone(node));
    const visibleIds = new Set(request.graph.nodes.map((n) => n.id));
    request.graph.edges = request.graph.edges.filter((e) => visibleIds.has(e.sourceId) && visibleIds.has(e.targetId))
      .map((edge) => nodeIds.has(edge.sourceId) || nodeIds.has(edge.targetId) ? { ...edge, rationale: omitted } : edge);
    if (bad.length || workIds.size || directiveIds.size) request.recentEvents = [];
    const manifest: ContextLineageManifest = { version: 1, role, fingerprint, sources, parents: [...new Set(derived.map((d) => d.snapshot_id))],
      withheldWorkIds: [...workIds], withheldDirectiveIds: [...directiveIds], withheldNodeIds: [...nodeIds], omittedEvents: input.recentEvents.length - request.recentEvents.length };
    return { ...request, manifest: { contextLineage: manifest } };
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
      request.transcript = []; request.steering = [omitted];
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

const omitted = "Context-derived text withheld: source authorization or lifecycle is no longer current. Reassess from available evidence; original retained for audit.";
