import type Database from "better-sqlite3";
import { generateKeyPairSync, sign } from "node:crypto";
import { DurableScenarioRuntime, ScenarioDefinitionRegistry, type ScenarioCommand, type ScenarioDefinition } from "@traceforge/orchestration-core";
import { createDb, getSqliteClient } from "../db/client.js";
import { SqliteScenarioEventStore } from "../scenario-event-store.js";
import { SqliteToolInvocationBindingStore } from "../worker-execution-adapters.js";
import { ScenarioWorkRetryControl } from "../scenario-work-retry.js";
import { ToolInvocationReconciliationControl } from "../tool-invocation-reconciliation.js";
import { SignedToolRecoveryEvidenceVerifier, recoveryEvidenceSigningPayload, type SignedRecoveryEvidence, type RecoveryEvidenceAuthority } from "../tool-recovery-evidence.js";
import { ToolExecutionRecoveryControl } from "../tool-execution-recovery.js";

export const at = "2026-08-30T00:00:00.000Z";
export const definition: ScenarioDefinition = {
  kind: "neutral", version: 1, title: "Neutral", authorizationActions: ["observe"], requiredCapabilities: ["observe"],
  workKinds: [{ id: "observe", defaultWorkerRoles: ["observer"] }], initialPhaseId: "observe",
  agentTopology: {
    planner: { enabled: false, pollIntervalMs: 1000, maximumGraphNodes: 1, maximumRecentEvents: 1, maximumRunItems: 1, maximumProposalsPerEvaluation: 1 },
    observer: { enabled: false, pollIntervalMs: 1000, maximumGraphNodes: 1, maximumRecentEvents: 1, maximumRunItems: 1 },
    workerPools: [{ id: "neutral", role: "observer", workKinds: ["observe"], activation: "on_demand", minimumInstances: 0, maximumInstances: 1, maxConcurrentWork: 1, capabilities: ["observe"] }],
  },
  phases: [{ id: "observe", title: "Observe", objective: "Observe", allowedWorkKinds: ["observe"], maxParallelWork: 1,
    requiredCapabilities: ["observe"], transitions: [{ to: "complete", allOf: [{ kind: "decision" }] }] }],
};

export const keys = generateKeyPairSync("ed25519");
export function signEvidence(payload: Omit<SignedRecoveryEvidence, "signature">): SignedRecoveryEvidence {
  return { ...payload, signature: sign(null, Buffer.from(recoveryEvidenceSigningPayload(payload)), keys.privateKey).toString("base64") };
}
export function authority(): RecoveryEvidenceAuthority {
  return { publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString(), sources: ["neutral", "traceforge.builtin"],
    validFrom: "2026-01-01T00:00:00.000Z", validUntil: "2099-01-01T00:00:00.000Z", maximumAgeMs: 300000, allowNonProcess: true };
}
export interface RecoveryControls {
  sqlite: Database.Database;
  bindings: SqliteToolInvocationBindingStore;
  runtime: DurableScenarioRuntime;
  verifier: SignedToolRecoveryEvidenceVerifier;
  reconciliation: ToolInvocationReconciliationControl;
  retry: ScenarioWorkRetryControl;
  recovery: ToolExecutionRecoveryControl;
}
export function controls(sqlite: Database.Database, options: {
  now?: () => string; authority?: RecoveryEvidenceAuthority;
  stage?: (stage: "registered" | "reconciled" | "retried") => void; denied?: boolean; retryDenied?: boolean;
} = {}): RecoveryControls {
  const now = options.now ?? (() => at);
  const bindings = new SqliteToolInvocationBindingStore(sqlite, now);
  const definitions = new ScenarioDefinitionRegistry([definition]);
  const runtime = new DurableScenarioRuntime(new SqliteScenarioEventStore(sqlite), definitions);
  const verifier = new SignedToolRecoveryEvidenceVerifier(sqlite, (key) => key === "test-key" ? options.authority ?? authority() : undefined, now);
  const reconciliation = new ToolInvocationReconciliationControl(sqlite, bindings,
    { async authorize() { return { decision: options.denied ? "denied" : "allowed", reason: "test-only grant" }; } }, verifier, now);
  const retry = new ScenarioWorkRetryControl(sqlite, definitions, undefined, { async authorize() {
    return options.retryDenied ? { decision: "denied" } : { decision: "allowed", authorizationRef: "test-only grant", expiresAt: "2099-01-01T00:00:00.000Z" };
  } }, undefined, now);
  const recovery = new ToolExecutionRecoveryControl(sqlite, bindings, reconciliation, retry, now, options.stage);
  return { sqlite, bindings, runtime, verifier, reconciliation, retry, recovery };
}
export function initialize(sqlite: Database.Database): RecoveryControls & { block(): void } {
  const c = controls(sqlite);
  const command = (id: string, command: ScenarioCommand) => c.runtime.execute({ runId: "run", commandId: id,
    expectedRevision: c.runtime.load("run")?.revision ?? 0, definitionKind: "neutral", definitionVersion: 1, command }).state;
  command("start", { type: "start_run", runId: "run", caseId: "case", goal: "Observe", scopeRef: "scope",
    scenarioPackage: { id: "neutral", version: "1.0.0", schemaRevision: 1 }, availableCapabilities: ["observe"], at });
  command("propose", { type: "propose_work", proposal: { id: "work", kind: "observe", title: "Observe", objective: "Observe", idempotencyKey: "effect" }, at });
  command("claim", { type: "claim_work", workId: "work", leaseId: "lease", workerId: "worker", workerRoles: ["observer"],
    workerCapabilities: ["observe"], workerCurrentWork: 0, workerMaxConcurrentWork: 1, leaseExpiresAt: "2099-01-01T00:00:00.000Z", at });
  return { ...c, block() { command("block", { type: "block_work", workId: "work", leaseId: "lease", reason: "interrupted", at }); } };
}
export async function uncertain(sqlite: Database.Database): Promise<RecoveryControls & { block(): void }> {
  const c = initialize(sqlite);
  await c.bindings.prepare({ idempotencyKey: "call", invocationId: "first",
    tool: { name: "observe", source: "neutral", version: "1", contractFingerprint: "a".repeat(64) },
    inputFingerprint: "b".repeat(64), attribution: { caseId: "case", runId: "run", workId: "work" } });
  await c.bindings.beginExecution("call", "lease", "worker");
  await c.bindings.markUncertain("call", "interrupted");
  c.block();
  return c;
}
export function evidence(c: ReturnType<typeof controls>, key = "call", issuedAt = at): Omit<SignedRecoveryEvidence, "signature"> {
  const binding = c.bindings.get(key)!;
  const execution = c.bindings.execution(key)!;
  return { format: "traceforge.invocation-recovery.v1", keyId: "test-key", process: null, assertion: {
    schemaVersion: 1, identity: { idempotencyKey: key, invocationId: binding.invocationId, tool: binding.tool,
      inputFingerprint: binding.inputFingerprint, attribution: binding.attribution },
    executionOwnership: { ownerId: execution.owner_id, leaseId: execution.lease_id },
    outcome: "no_effect_confirmed", resultFingerprint: null, cleanup: { status: "not_started", evidenceRef: "test-only-independent-attestation" },
    issuedAt, expiresAt: new Date(Date.parse(issuedAt) + 300000).toISOString(),
  } };
}
export function database(path = ":memory:"): Database.Database { return getSqliteClient(createDb(path)); }
