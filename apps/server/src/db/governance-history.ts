import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { canonicalJson } from "@traceforge/orchestration-core";
import { archiveStores, readExecutionRow } from "./execution-archive.js";

export type GovernanceHistoryKind = "managedCleanup" | "processCleanup";
export interface GovernanceHistoryIndex {
  kind: GovernanceHistoryKind; entry_key: string; occupancy_key: string; case_id: string; run_id: string;
  work_id: string; created_at: string; evidence_ref: string | null; outcome: string; fingerprint: string;
}
export const governanceHash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");

/** The index is permanent; only accepted history bodies can leave the source tables. */
export function initializeGovernanceHistory(sqlite: Database.Database, kind: GovernanceHistoryKind): void {
  const process = kind === "processCleanup", store = archiveStores[kind];
  const occupancy = process ? "process_execution_occupancy" : "managed_execution_occupancy";
  const key = process ? "id" : "idempotency_key";
  const auditKey = process ? "occupancyId" : "idempotencyKey";
  const scope = process ? "attribution" : "scheduling";
  sqlite.transaction(() => {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS execution_governance_history (
      kind TEXT NOT NULL,entry_key TEXT NOT NULL,occupancy_key TEXT NOT NULL,case_id TEXT NOT NULL,run_id TEXT NOT NULL,
      work_id TEXT NOT NULL,created_at TEXT NOT NULL,evidence_ref TEXT,outcome TEXT NOT NULL,fingerprint TEXT NOT NULL,
      PRIMARY KEY(kind,entry_key));
      CREATE INDEX IF NOT EXISTS governance_history_scope ON execution_governance_history(case_id,run_id,kind,entry_key);
      CREATE TRIGGER IF NOT EXISTS governance_history_keep BEFORE DELETE ON execution_governance_history BEGIN SELECT RAISE(ABORT,'Governance history keys are permanent'); END;
      CREATE TRIGGER IF NOT EXISTS governance_history_fence BEFORE UPDATE ON execution_governance_history BEGIN SELECT RAISE(ABORT,'Governance history index is immutable'); END;`);
    const select = (record: string) => `SELECT '${kind}',${record}.command_id,o.${key},
      json_extract(o.identity_json,'$.${scope}.caseId'),json_extract(o.identity_json,'$.${scope}.runId'),json_extract(o.identity_json,'$.${scope}.workId'),
      json_extract(${record}.audit_json,'$.createdAt'),json_extract(${record}.audit_json,'$.proofRef'),
      ${process ? "'released'" : `json_extract(${record}.audit_json,'$.outcome')`},${record}.fingerprint
      FROM ${occupancy} o WHERE o.${key}=json_extract(${record}.audit_json,'$.${auditKey}')`;
    sqlite.exec(`CREATE TRIGGER IF NOT EXISTS governance_history_${kind}_insert AFTER INSERT ON ${store.table} BEGIN
      INSERT INTO execution_governance_history ${select("NEW")};
      SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM execution_governance_history WHERE kind='${kind}' AND entry_key=NEW.command_id)
        THEN RAISE(ABORT,'Cleanup history has no occupancy identity') END;
    END;`);
    // Old rows have intact JSON; archived rows MUST already have their permanent index.
    for (const row of sqlite.prepare(`SELECT command_id FROM ${store.table} s WHERE NOT EXISTS
      (SELECT 1 FROM execution_governance_history h WHERE h.kind=? AND h.entry_key=s.command_id)`).all(kind) as {command_id:string}[]) {
      const body = readExecutionRow<{audit_json:string}>(sqlite,kind,row.command_id)!;
      if (!body || !JSON.parse(body.audit_json)) throw new Error("Cleanup history migration is corrupt");
      const inserted=sqlite.prepare(`INSERT INTO execution_governance_history ${select("s").replace(`FROM ${occupancy} o`, `FROM ${store.table} s JOIN ${occupancy} o`)}
        AND s.command_id=?`).run(row.command_id);
      if(inserted.changes!==1)throw new Error("Cleanup history migration has no occupancy identity");
    }
  })();
  // Do not admit a fresh host with silently missing/tampered archived proof bodies.
  for (const row of sqlite.prepare(`SELECT h.entry_key FROM execution_governance_history h LEFT JOIN ${store.table} s ON s.command_id=h.entry_key
    WHERE h.kind=? AND (s.audit_json LIKE 'execution-archive:%' OR EXISTS
      (SELECT 1 FROM execution_archives a WHERE a.kind=h.kind AND a.entry_key=h.entry_key))`).iterate(kind) as Iterable<{entry_key:string}>) {
    readGovernanceHistory(sqlite,kind,row.entry_key);
  }
}

/** Validate the archived body against permanent identity, cleanup decision and linked evidence. No execution or authorization is performed. */
export function readGovernanceHistory(sqlite: Database.Database, kind: GovernanceHistoryKind, key: string) {
  const index = sqlite.prepare("SELECT * FROM execution_governance_history WHERE kind=? AND entry_key=?").get(kind,key) as GovernanceHistoryIndex | undefined;
  const row = readExecutionRow<{fingerprint:string;audit_json:string;proof_json?:string}>(sqlite,kind,key);
  if (!index || !row || row.fingerprint!==index.fingerprint) throw new Error("Governance history identity missing or corrupt");
  const audit = JSON.parse(row.audit_json);
  if (audit.commandId!==key || audit.createdAt!==index.created_at || audit.proofRef!==index.evidence_ref
    || (kind==="managedCleanup" ? audit.idempotencyKey!==index.occupancy_key || audit.outcome!==index.outcome : audit.occupancyId!==index.occupancy_key)) {
    throw new Error("Governance history index mismatch");
  }
  const process = kind==="processCleanup";
  const occupancy = sqlite.prepare(`SELECT identity_json,state,proof_ref FROM ${process?"process_execution_occupancy":"managed_execution_occupancy"} WHERE ${process?"id":"idempotency_key"}=?`)
    .get(index.occupancy_key) as {identity_json:string;state:string;proof_ref:string|null}|undefined;
  if (!occupancy) throw new Error("Governance occupancy missing");
  const identity=JSON.parse(occupancy.identity_json), scope=process?identity.attribution:identity.scheduling;
  if (scope.caseId!==index.case_id || scope.runId!==index.run_id || scope.workId!==index.work_id) throw new Error("Governance history scope mismatch");
  let evidenceKey:string|null=null;
  if (process) {
    const proof=JSON.parse(row.proof_json!);
    if (proof.occupancyId!==index.occupancy_key || canonicalJson(proof.identity)!==occupancy.identity_json
      || index.evidence_ref!==`process-cleanup:${governanceHash(proof)}`) throw new Error("Process cleanup archive proof mismatch");
  } else if (index.outcome==="released" && index.evidence_ref?.startsWith("recovery-evidence:")) {
    const evidence=readExecutionRow<{envelope_json:string}>(sqlite,"evidence",index.evidence_ref);
    if (!evidence) throw new Error("Managed cleanup archive evidence missing");
    const envelope=JSON.parse(evidence.envelope_json);
    if (`recovery-evidence:${governanceHash(envelope)}`!==index.evidence_ref
      || canonicalJson(envelope.assertion.identity)!==canonicalJson(identity.invocation)
      || canonicalJson(envelope.assertion.executionOwnership)!==canonicalJson(identity.ownership)) throw new Error("Managed cleanup archive evidence mismatch");
    evidenceKey=index.evidence_ref;
  }
  return {index,row,occupancy,evidenceKey};
}
