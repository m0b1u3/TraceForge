import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { canonicalJson } from "@traceforge/orchestration-core";
import type {
  ProviderCapabilityReceipt,
  ScenarioCapabilityClaim,
  ScenarioProcessManifest,
  ScenarioProcessPackageIdentity,
  ScenarioProcessSupervisionSnapshot,
  ScenarioProcessSupervisionState,
  ScenarioProcessSupervisionStore,
} from "@traceforge/worker-runtime";

interface SupervisionRow {
  package_id: string; package_version: string; source: string; manifest_digest: string; launch_fingerprint: string;
  maximum_starts: number; last_generation: number; state: ScenarioProcessSupervisionState; revoked_reason: string | null;
}

/** Durable single-host Scenario Process generation ledger and exact-once capability receipt store. */
export class SqliteScenarioProcessSupervisionStore implements ScenarioProcessSupervisionStore {
  constructor(private readonly sqlite: Database.Database, private readonly now: () => string = () => new Date().toISOString()) {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS scenario_process_supervision (
        package_id TEXT NOT NULL, package_version TEXT NOT NULL, source TEXT NOT NULL,
        manifest_digest TEXT NOT NULL, launch_fingerprint TEXT NOT NULL, maximum_starts INTEGER NOT NULL,
        last_generation INTEGER NOT NULL, state TEXT NOT NULL, revoked_reason TEXT, updated_at TEXT NOT NULL,
        PRIMARY KEY(package_id, package_version)
      );
      CREATE TABLE IF NOT EXISTS scenario_process_generations (
        package_id TEXT NOT NULL, package_version TEXT NOT NULL, source TEXT NOT NULL, generation INTEGER NOT NULL,
        state TEXT NOT NULL, detail_json TEXT NOT NULL, detail_digest TEXT NOT NULL, reserved_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(package_id, package_version, generation)
      );
      CREATE TABLE IF NOT EXISTS scenario_process_capability_receipts (
        package_id TEXT NOT NULL, package_version TEXT NOT NULL, idempotency_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL, status TEXT NOT NULL, receipt_json TEXT, receipt_digest TEXT,
        claim_json TEXT, claim_digest TEXT, attempt INTEGER NOT NULL DEFAULT 1,
        recovery_evidence_ref TEXT, started_at TEXT NOT NULL, completed_at TEXT,
        PRIMARY KEY(package_id, package_version, idempotency_key)
      );
      CREATE TRIGGER IF NOT EXISTS scenario_process_supervision_capacity BEFORE INSERT ON scenario_process_supervision BEGIN
        SELECT CASE WHEN (SELECT count(*) FROM scenario_process_supervision)>=10000 THEN RAISE(ABORT,'Scenario Process supervision capacity exceeded') END;
        SELECT execution_physical_admit(execution_floor,maximum_database_bytes,maximum_wal_bytes,16384,'execution') FROM execution_physical_policy WHERE id=1;
      END;
      CREATE TRIGGER IF NOT EXISTS scenario_process_generation_capacity BEFORE INSERT ON scenario_process_generations BEGIN
        SELECT CASE WHEN (SELECT count(*) FROM scenario_process_generations)>=100000 OR length(CAST(NEW.detail_json AS BLOB))>16384
          THEN RAISE(ABORT,'Scenario Process generation capacity exceeded') END;
        SELECT execution_physical_admit(execution_floor,maximum_database_bytes,maximum_wal_bytes,32768,'execution') FROM execution_physical_policy WHERE id=1;
      END;
      CREATE TRIGGER IF NOT EXISTS scenario_process_receipt_capacity BEFORE INSERT ON scenario_process_capability_receipts BEGIN
        SELECT CASE WHEN (SELECT count(*) FROM scenario_process_capability_receipts)>=1000000 OR coalesce(length(CAST(NEW.receipt_json AS BLOB)),0)>4194304
          THEN RAISE(ABORT,'Scenario Process receipt capacity exceeded') END;
        SELECT execution_physical_admit(execution_floor,maximum_database_bytes,maximum_wal_bytes,16384,'execution') FROM execution_physical_policy WHERE id=1;
      END;
      CREATE TRIGGER IF NOT EXISTS scenario_process_receipt_settlement_storage BEFORE UPDATE OF status ON scenario_process_capability_receipts
      WHEN OLD.status='pending' AND NEW.status='succeeded' BEGIN
        SELECT execution_physical_admit(recovery_floor,maximum_database_bytes,maximum_wal_bytes,
          coalesce(length(CAST(NEW.receipt_json AS BLOB)),0)+8192,'recovery') FROM execution_physical_policy WHERE id=1;
      END;
    `);
    const columns = new Set((sqlite.prepare("PRAGMA table_info(scenario_process_capability_receipts)").all() as {name:string}[]).map(row=>row.name));
    for (const [name,definition] of [["claim_json","TEXT"],["claim_digest","TEXT"],["attempt","INTEGER NOT NULL DEFAULT 1"],
      ["recovery_evidence_ref","TEXT"]] as const) if(!columns.has(name)) sqlite.exec(`ALTER TABLE scenario_process_capability_receipts ADD COLUMN ${name} ${definition}`);
  }

  recoverInterrupted(): number {
    return this.sqlite.transaction(() => {
      const at = this.now();
      const generations = this.sqlite.prepare(`UPDATE scenario_process_generations SET state='interrupted', updated_at=?
        WHERE state IN ('reserved','started','ready')`).run(at).changes;
      this.sqlite.prepare(`UPDATE scenario_process_supervision SET state='interrupted', updated_at=?
        WHERE state IN ('reserved','started','ready')`).run(at);
      return generations;
    })();
  }

  snapshot(identity: ScenarioProcessManifest): ScenarioProcessSupervisionSnapshot | undefined {
    const row = this.row(identity);
    if (!row) return undefined;
    this.assertIdentity(row, identity);
    return { id: row.package_id, version: row.package_version, source: row.source, lastGeneration: row.last_generation,
      maximumStarts: row.maximum_starts, state: row.state, revokedReason: row.revoked_reason };
  }

  reserveGeneration(identity: ScenarioProcessManifest, generation: number, maximumStarts: number, launchFingerprint: string): void {
    validIdentity(identity); digestValue(launchFingerprint, "launch fingerprint");
    if (!Number.isSafeInteger(generation) || generation < 1 || !Number.isSafeInteger(maximumStarts) || maximumStarts < 1 || maximumStarts > 101) {
      throw new Error("Invalid Scenario Process generation reservation");
    }
    this.sqlite.transaction(() => {
      const at = this.now(), row = this.row(identity), manifestDigest = manifestFingerprint(identity);
      if (row) {
        this.assertIdentity(row, identity);
        if (row.revoked_reason) throw new Error(`Scenario Process is revoked: ${row.revoked_reason}`);
        if (row.manifest_digest !== manifestDigest || row.launch_fingerprint !== launchFingerprint) {
          throw new Error("Scenario Process reviewed launch identity changed; a new Package version is required");
        }
        if (row.maximum_starts !== maximumStarts) throw new Error("Scenario Process restart budget changed for an installed Package version");
        if (generation !== row.last_generation + 1) throw new Error("Scenario Process generation is not monotonic");
      } else if (generation !== 1) throw new Error("First Scenario Process generation must be one");
      if (generation > maximumStarts) throw new Error("Scenario Process restart budget exhausted");
      const detail = JSON.stringify({ launchFingerprint });
      this.sqlite.prepare(`INSERT INTO scenario_process_generations
        (package_id,package_version,source,generation,state,detail_json,detail_digest,reserved_at,updated_at)
        VALUES(?,?,?,?,'reserved',?,?,?,?)`).run(identity.id, identity.version, identity.source, generation,
          detail, sha256(detail), at, at);
      if (row) this.sqlite.prepare(`UPDATE scenario_process_supervision SET last_generation=?,state='reserved',updated_at=?
        WHERE package_id=? AND package_version=?`).run(generation, at, identity.id, identity.version);
      else this.sqlite.prepare(`INSERT INTO scenario_process_supervision
        (package_id,package_version,source,manifest_digest,launch_fingerprint,maximum_starts,last_generation,state,revoked_reason,updated_at)
        VALUES(?,?,?,?,?,?,?,'reserved',NULL,?)`).run(identity.id, identity.version, identity.source, manifestDigest,
          launchFingerprint, maximumStarts, generation, at);
    })();
  }

  recordLifecycle(identity: ScenarioProcessManifest, generation: number, state: "started" | "ready" | "exited" | "failed",
    detail: { proof?: unknown; error?: string; exitCode?: number | null; exitSignal?: string | null }): void {
    validIdentity(identity);
    const json = JSON.stringify(detail), digest = sha256(json);
    if (Buffer.byteLength(json) > 16_384) throw new Error("Scenario Process lifecycle detail exceeds capacity");
    this.sqlite.transaction(() => {
      const row = this.sqlite.prepare(`SELECT state,detail_digest FROM scenario_process_generations
        WHERE package_id=? AND package_version=? AND generation=?`).get(identity.id, identity.version, generation) as
        { state: ScenarioProcessSupervisionState; detail_digest: string } | undefined;
      if (!row) throw new Error("Scenario Process lifecycle has no reserved generation");
      if (row.state === state) {
        if (row.detail_digest !== digest) throw new Error("Scenario Process lifecycle replay conflict");
        return;
      }
      const allowed: Record<typeof state, ScenarioProcessSupervisionState[]> = {
        started: ["reserved"], ready: ["started"], exited: ["started", "ready", "failed"], failed: ["reserved", "started", "ready"],
      };
      if (!allowed[state].includes(row.state)) throw new Error(`Invalid Scenario Process lifecycle transition ${row.state} -> ${state}`);
      const at = this.now();
      this.sqlite.prepare(`UPDATE scenario_process_generations SET state=?,detail_json=?,detail_digest=?,updated_at=?
        WHERE package_id=? AND package_version=? AND generation=?`).run(state, json, digest, at, identity.id, identity.version, generation);
      this.sqlite.prepare(`UPDATE scenario_process_supervision SET state=?,updated_at=? WHERE package_id=? AND package_version=? AND last_generation=? AND revoked_reason IS NULL`)
        .run(state, at, identity.id, identity.version, generation);
    })();
  }

  revoke(identity: ScenarioProcessManifest, reason: string): void {
    validIdentity(identity);
    if (typeof reason !== "string" || !reason.trim() || Buffer.byteLength(reason) > 4096) throw new Error("Invalid Scenario Process revocation reason");
    const changed = this.sqlite.prepare(`UPDATE scenario_process_supervision SET state='revoked',revoked_reason=?,updated_at=?
      WHERE package_id=? AND package_version=? AND source=? AND revoked_reason IS NULL`).run(reason.trim(), this.now(), identity.id, identity.version, identity.source).changes;
    if (!changed) {
      const row = this.row(identity);
      if (!row) return;
      if (row.revoked_reason !== reason.trim()) throw new Error("Scenario Process revocation reason conflict");
    }
  }

  getCapabilityReceipt(identity: ScenarioProcessPackageIdentity, idempotencyKey: string) {
    validPackageIdentity(identity); validKey(idempotencyKey);
    const row = this.sqlite.prepare(`SELECT fingerprint,status,receipt_json,receipt_digest FROM scenario_process_capability_receipts
      WHERE package_id=? AND package_version=? AND idempotency_key=?`).get(identity.id, identity.version, idempotencyKey) as
      { fingerprint: string; status: "pending"|"retry_allowed"|"succeeded"|"archived"; receipt_json: string|null; receipt_digest: string|null } | undefined;
    if (!row) return undefined;
    if (row.status === "pending" || row.status === "retry_allowed") {
      if (row.receipt_json !== null || row.receipt_digest !== null) throw new Error("Scenario Process pending capability record is corrupt");
      return { fingerprint:row.fingerprint,status:row.status };
    }
    if (row.status !== "succeeded" || row.receipt_json === null || row.receipt_digest === null
      || sha256(row.receipt_json) !== row.receipt_digest) throw new Error("Scenario Process capability receipt is corrupt");
    const receipt = JSON.parse(row.receipt_json) as ProviderCapabilityReceipt;
    validateReceipt(identity, idempotencyKey, row.fingerprint, receipt);
    return { fingerprint: row.fingerprint, status:"succeeded" as const, receipt };
  }

  countCapabilityReceipts(identity: ScenarioProcessPackageIdentity): number {
    validPackageIdentity(identity);
    return (this.sqlite.prepare(`SELECT count(*) AS count FROM scenario_process_capability_receipts
      WHERE package_id=? AND package_version=? AND status!='archived'`).get(identity.id, identity.version) as { count: number }).count;
  }

  claimCapabilityReceipt(identity: ScenarioProcessPackageIdentity, claim: ScenarioCapabilityClaim): boolean {
    validPackageIdentity(identity);validateClaim(identity,claim);const json=canonicalJson(claim),digest=sha256(json);
    return this.sqlite.transaction(()=>{
      const inserted=this.sqlite.prepare(`INSERT OR IGNORE INTO scenario_process_capability_receipts
        (package_id,package_version,idempotency_key,fingerprint,status,receipt_json,receipt_digest,claim_json,claim_digest,attempt,recovery_evidence_ref,started_at,completed_at)
        VALUES(?,?,?,?,'pending',NULL,NULL,?,?,1,NULL,?,NULL)`).run(identity.id,identity.version,claim.idempotencyKey,
          claim.inputFingerprint,json,digest,claim.startedAt).changes;
      if(inserted===1)return true;
      const row=this.sqlite.prepare(`SELECT status,fingerprint,claim_json,claim_digest FROM scenario_process_capability_receipts
        WHERE package_id=? AND package_version=? AND idempotency_key=?`).get(identity.id,identity.version,claim.idempotencyKey) as
        {status:string;fingerprint:string;claim_json:string|null;claim_digest:string|null}|undefined;
      if(!row || row.status!=="retry_allowed")return false;
      if(row.fingerprint!==claim.inputFingerprint || !row.claim_json || sha256(row.claim_json)!==row.claim_digest)throw new Error("Scenario capability retry identity is corrupt");
      const prior=JSON.parse(row.claim_json) as ScenarioCapabilityClaim;
      if(canonicalJson({...prior,generation:claim.generation,startedAt:claim.startedAt})!==json)throw new Error("Scenario capability retry identity changed");
      return this.sqlite.prepare(`UPDATE scenario_process_capability_receipts SET status='pending',claim_json=?,claim_digest=?,attempt=attempt+1,
        recovery_evidence_ref=NULL,started_at=? WHERE package_id=? AND package_version=? AND idempotency_key=? AND status='retry_allowed'`)
        .run(json,digest,claim.startedAt,identity.id,identity.version,claim.idempotencyKey).changes===1;
    })();
  }

  settleCapabilityReceipt(identity: ScenarioProcessPackageIdentity, fingerprint: string, receipt: ProviderCapabilityReceipt): void {
    validPackageIdentity(identity); digestValue(fingerprint, "receipt fingerprint"); validKey(receipt.idempotencyKey);
    validateReceipt(identity, receipt.idempotencyKey, fingerprint, receipt);
    const json = JSON.stringify(receipt), digest = sha256(json);
    this.sqlite.transaction(() => {
      const previous = this.getCapabilityReceipt(identity, receipt.idempotencyKey);
      if (!previous || previous.fingerprint !== fingerprint) throw new Error("Scenario Process capability receipt has no matching claim");
      if (previous.status === "succeeded") {
        if (canonicalJson(previous.receipt) !== canonicalJson(receipt)) throw new Error("Scenario Process capability receipt conflict");
        return;
      }
      const changed=this.sqlite.prepare(`UPDATE scenario_process_capability_receipts SET status='succeeded',receipt_json=?,receipt_digest=?,completed_at=?
        WHERE package_id=? AND package_version=? AND idempotency_key=? AND fingerprint=? AND status='pending'`)
        .run(json,digest,receipt.completedAt,identity.id,identity.version,receipt.idempotencyKey,fingerprint).changes;
      if(changed!==1)throw new Error("Scenario Process capability receipt settlement conflict");
    })();
  }

  private row(identity: ScenarioProcessPackageIdentity): SupervisionRow | undefined {
    return this.sqlite.prepare(`SELECT package_id,package_version,source,manifest_digest,launch_fingerprint,maximum_starts,
      last_generation,state,revoked_reason FROM scenario_process_supervision WHERE package_id=? AND package_version=?`)
      .get(identity.id, identity.version) as SupervisionRow | undefined;
  }
  private assertIdentity(row: SupervisionRow, identity: ScenarioProcessManifest): void {
    if (row.source !== identity.source) throw new Error("Scenario Process supervision source mismatch");
  }
}

function manifestFingerprint(value: ScenarioProcessManifest): string { return sha256(canonicalJson(value)); }
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function digestValue(value: string, label: string): void { if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`Invalid Scenario Process ${label}`); }
function validKey(value: string): void { if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > 1024) throw new Error("Invalid Scenario Process idempotency key"); }
function validPackageIdentity(value: ScenarioProcessPackageIdentity): void {
  for (const entry of [value.id, value.version]) if (typeof entry !== "string" || !entry.trim() || Buffer.byteLength(entry) > 256) throw new Error("Invalid Scenario Package identity");
}
function validIdentity(value: ScenarioProcessManifest): void { validPackageIdentity(value); if (!value.source?.trim()) throw new Error("Invalid Scenario Process source"); }
function validateClaim(identity:ScenarioProcessPackageIdentity,value:ScenarioCapabilityClaim):void {
  if(value.schemaVersion!==1||value.package.id!==identity.id||value.package.version!==identity.version||!Number.isSafeInteger(value.generation)||value.generation<1
    ||!Number.isFinite(Date.parse(value.startedAt)))throw new Error("Invalid Scenario Process capability claim");
  for(const entry of [value.parentRequestId,value.capability,value.action,value.idempotencyKey,value.attribution.caseId,value.attribution.runId,
    value.attribution.workId,value.attribution.workerId,value.attribution.scopeRef,value.attribution.leaseId])validKey(entry);
  digestValue(value.inputFingerprint,"receipt fingerprint");
}
function validateReceipt(identity: ScenarioProcessPackageIdentity, key: string, fingerprint: string, receipt: ProviderCapabilityReceipt): void {
  digestValue(fingerprint, "receipt fingerprint");
  if (receipt.provider.id !== identity.id || receipt.provider.version !== identity.version || receipt.idempotencyKey !== key
    || receipt.inputFingerprint !== fingerprint || receipt.status !== "succeeded") throw new Error("Invalid Scenario Process capability receipt");
}
