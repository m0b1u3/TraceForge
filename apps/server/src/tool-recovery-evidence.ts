import { createHash, createPublicKey, verify } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { canonicalJson } from "@traceforge/orchestration-core";
import type { ToolInvocationReconciliationEvidenceVerifier } from "./tool-invocation-reconciliation.js";
import { SqliteProcessExecutionJournal } from "./execution-process-journal.js";
import { ExecutionStorageWriteError, isExecutionStorageCapacityError } from "./db/execution-storage.js";

const text = z.string().min(1).max(512);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z.object({
  idempotencyKey: text, invocationId: text,
  tool: z.object({ name: text, source: text, version: text, contractFingerprint: hash }).strict(),
  inputFingerprint: hash, attribution: z.object({ caseId: text, runId: text, workId: text }).strict(),
}).strict();
const assertion = z.object({
  schemaVersion: z.literal(1), identity,
  executionOwnership: z.object({ ownerId: text, leaseId: text.nullable() }).strict(),
  outcome: z.enum(["result_confirmed", "no_effect_confirmed"]), resultFingerprint: hash.nullable(),
  cleanup: z.object({ status: z.enum(["not_started", "terminal", "not_applicable"]), evidenceRef: text }).strict(),
  issuedAt: text, expiresAt: text,
}).strict();
const processProof = z.object({
  identity: z.object({ idempotencyKey: text, requestId: text, caseId: text, runId: text, workId: text, leaseId: text }).strict(),
  launch: z.object({ nodeId: text, generationId: text, launchId: hash, requestId: text, requestFingerprint: hash }).strict(),
}).strict();
export const signedRecoveryEvidenceSchema = z.object({
  format: z.literal("traceforge.invocation-recovery.v1"), keyId: text, assertion,
  process: processProof.nullable(), signature: z.string().max(128),
}).strict();
export type SignedRecoveryEvidence = z.infer<typeof signedRecoveryEvidenceSchema>;

/** Deployment-owned authorities, NEVER supplied by an HTTP request or a tool. */
export interface RecoveryEvidenceAuthority {
  publicKeyPem: string;
  sources: readonly string[];
  validFrom: string;
  validUntil: string;
  revoked?: boolean;
  maximumAgeMs: number;
  /** Non-process result/outcome attestations are a separate, explicit delegation. */
  allowNonProcess: boolean;
  /** Real platform acceptance reference required before delegating process cleanup assertions. */
  processAcceptance?: { reference: string; nodeIds: readonly string[] };
}

export function recoveryEvidenceSigningPayload(envelope: Omit<SignedRecoveryEvidence, "signature">): string {
  return canonicalJson(envelope);
}
export function recoveryEvidenceHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** Verifies independently attested outcomes. It never signs local close/timeout observations. */
export class SignedToolRecoveryEvidenceVerifier implements ToolInvocationReconciliationEvidenceVerifier {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly authority: (keyId: string) => RecoveryEvidenceAuthority | undefined,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async verify(input: Parameters<ToolInvocationReconciliationEvidenceVerifier["verify"]>[0]) {
    const value = z.object({ evidenceRef: z.string().regex(/^recovery-evidence:[a-f0-9]{64}$/) }).strict().safeParse(input.evidence);
    const raw = value.success ? this.load(value.data.evidenceRef) : input.evidence;
    if (Buffer.byteLength(canonicalJson(raw)) > 64 * 1024) throw new Error("Recovery evidence exceeds its size limit");
    const envelope = signedRecoveryEvidenceSchema.parse(raw);
    const authority = this.authority(envelope.keyId);
    if (!authority || authority.revoked || !authority.sources.includes(input.expectedIdentity.tool.source)) {
      throw new Error("Recovery evidence authority is absent, revoked, or outside scope");
    }
    const issued = Date.parse(envelope.assertion.issuedAt), expires = Date.parse(envelope.assertion.expiresAt), now = Date.parse(this.now());
    const validFrom = Date.parse(authority.validFrom), validUntil = Date.parse(authority.validUntil);
    if (![issued, expires, now, validFrom, validUntil].every(Number.isFinite)
      || !Number.isSafeInteger(authority.maximumAgeMs) || authority.maximumAgeMs < 1
      || issued > now || issued < validFrom || expires > validUntil || now >= expires || now >= validUntil
      || expires <= issued || now - issued > authority.maximumAgeMs || expires - issued > authority.maximumAgeMs) {
      throw new Error("Recovery evidence or authority is not temporally valid");
    }
    const signature = Buffer.from(envelope.signature, "base64");
    if (signature.length !== 64 || signature.toString("base64") !== envelope.signature) throw new Error("Invalid evidence signature encoding");
    const key = createPublicKey(authority.publicKeyPem);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("Recovery authority must use Ed25519");
    const { signature: _signature, ...payload } = envelope;
    if (!verify(null, Buffer.from(recoveryEvidenceSigningPayload(payload)), key, signature)) throw new Error("Recovery evidence signature is invalid");
    const claim = envelope.assertion;
    if (canonicalJson(claim.identity) !== canonicalJson(input.expectedIdentity)
      || canonicalJson(claim.executionOwnership) !== canonicalJson(input.expectedExecutionOwnership)) throw new Error("Recovery evidence ownership mismatch");
    if (claim.outcome !== (input.resolution === "confirmed_result" ? "result_confirmed" : "no_effect_confirmed")
      || claim.resultFingerprint !== (input.result ? recoveryEvidenceHash(input.result) : null)) throw new Error("Recovery evidence result mismatch");
    const observed = new SqliteProcessExecutionJournal(this.sqlite).get(input.expectedIdentity.idempotencyKey);
    if (observed || envelope.process) {
      if (!observed || observed.schemaVersion !== 2 || !observed.launch || !envelope.process
        || !authority.processAcceptance?.reference.trim()
        || !authority.processAcceptance.nodeIds.includes(observed.nodeId)
        || canonicalJson(envelope.process.identity) !== canonicalJson(observed.identity)
        || canonicalJson(envelope.process.launch) !== canonicalJson(observed.launch)
        || observed.identity.leaseId !== input.expectedExecutionOwnership.leaseId
        || observed.identity.caseId !== input.expectedIdentity.attribution.caseId
        || observed.identity.runId !== input.expectedIdentity.attribution.runId
        || observed.identity.workId !== input.expectedIdentity.attribution.workId) throw new Error("Process provenance or accepted authority mismatch");
      if (claim.cleanup.status === "not_applicable") throw new Error("A dispatched process cannot bypass cleanup verification");
      if (claim.cleanup.status === "not_started" && (observed.status !== "claimed" || observed.process !== null)) throw new Error("Not-started evidence contradicts process observation");
    } else if (!authority.allowNonProcess || claim.cleanup.status === "terminal") {
      throw new Error("Non-process outcome authority is required; missing process records are not proof");
    }
    const evidenceRef = `recovery-evidence:${recoveryEvidenceHash(envelope)}`;
    const json = canonicalJson(envelope);
    try {
      this.sqlite.prepare("INSERT OR IGNORE INTO tool_recovery_evidence (evidence_ref, envelope_json, created_at) VALUES (?, ?, ?)")
        .run(evidenceRef, json, this.now());
      if (canonicalJson(this.load(evidenceRef)) !== json) throw new Error("Stored recovery evidence conflicts with verified content");
    } catch (error) {
      if (isExecutionStorageCapacityError(error)) throw error;
      throw new ExecutionStorageWriteError(error);
    }
    return { ...claim, cleanup: { ...claim.cleanup, evidenceRef } };
  }

  private load(evidenceRef: string): unknown {
    const row = readExecutionRow<{ envelope_json: string }>(this.sqlite, "evidence", evidenceRef);
    if (!row) throw new Error("Unknown recovery evidence reference");
    const value: unknown = JSON.parse(row.envelope_json);
    if (`recovery-evidence:${recoveryEvidenceHash(value)}` !== evidenceRef) throw new Error("Recovery evidence storage is corrupt");
    return value;
  }
}
import { readExecutionRow } from "./db/execution-archive.js";
