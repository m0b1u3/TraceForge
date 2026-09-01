import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { at, authority, controls, database, evidence, signEvidence, uncertain } from "./test-fixtures/execution-recovery.js";
import { SqliteProcessExecutionJournal } from "./execution-process-journal.js";
import { SignedToolRecoveryEvidenceVerifier, recoveryEvidenceHash } from "./tool-recovery-evidence.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
async function fixture() { const db = database(); databases.push(db); return uncertain(db); }
function input(c: ReturnType<typeof controls>) {
  const payload = evidence(c);
  return { evidence: signEvidence(payload), resolution: "confirmed_no_effect" as const, result: null,
    expectedIdentity: payload.assertion.identity, expectedExecutionOwnership: payload.assertion.executionOwnership };
}

describe("Deployment-pinned signed recovery evidence", () => {
  it("stores immutable content-addressed evidence and revalidates authority on reference reuse", async () => {
    const c = await fixture(); const trusted = authority();
    const verifier = new SignedToolRecoveryEvidenceVerifier(c.sqlite, () => trusted, () => at);
    const request = input(c); const assertion = await verifier.verify(request);
    expect(assertion.cleanup.evidenceRef).toBe(`recovery-evidence:${recoveryEvidenceHash(request.evidence)}`);
    const reference = { ...request, evidence: { evidenceRef: assertion.cleanup.evidenceRef } };
    expect(await verifier.verify(reference)).toEqual(assertion);
    trusted.revoked = true;
    await expect(verifier.verify(reference)).rejects.toThrow("revoked");
    expect(() => c.sqlite.exec("DELETE FROM tool_recovery_evidence")).toThrow("immutable");
    expect(c.sqlite.prepare("SELECT count(*) AS n FROM tool_recovery_evidence").get()).toEqual({ n: 1 });
  });

  it.each(["unsigned", "tampered", "unknown-key", "tool", "input", "owner", "lease", "outcome", "future", "expired", "overlong"])("rejects %s evidence without persisting a trusted record", async (mode) => {
    const c = await fixture(); const request = input(c); const payload = evidence(c);
    if (mode === "unknown-key") payload.keyId = "unknown";
    if (mode === "tool") payload.assertion.identity.tool.version = "other";
    if (mode === "input") payload.assertion.identity.inputFingerprint = "c".repeat(64);
    if (mode === "owner") payload.assertion.executionOwnership.ownerId = "other";
    if (mode === "lease") payload.assertion.executionOwnership.leaseId = "other";
    if (mode === "outcome") payload.assertion.outcome = "result_confirmed";
    if (mode === "future") payload.assertion.issuedAt = "2026-08-30T00:01:00.000Z";
    if (mode === "expired") payload.assertion.expiresAt = at;
    if (mode === "overlong") payload.assertion.expiresAt = "2026-08-30T00:06:00.000Z";
    request.evidence = signEvidence(payload);
    if (mode === "unsigned") request.evidence.signature = "";
    if (mode === "tampered") request.evidence.assertion.cleanup.evidenceRef = "changed after signing";
    await expect(c.verifier.verify(request)).rejects.toThrow();
    expect(c.sqlite.prepare("SELECT count(*) AS n FROM tool_recovery_evidence").get()).toEqual({ n: 0 });
    expect(c.bindings.execution("call")?.status).toBe("uncertain");
  });

  it.each(["source", "revoked", "non-process", "key-validity", "wrong-key"])("requires a currently delegated %s authority", async (mode) => {
    const c = await fixture(); const trusted = authority();
    if (mode === "source") trusted.sources = ["other"];
    if (mode === "revoked") trusted.revoked = true;
    if (mode === "non-process") trusted.allowNonProcess = false;
    if (mode === "key-validity") trusted.validFrom = "2090-01-01T00:00:00.000Z";
    if (mode === "wrong-key") trusted.publicKeyPem = "invalid key";
    const verifier = new SignedToolRecoveryEvidenceVerifier(c.sqlite, () => trusted, () => at);
    await expect(verifier.verify(input(c))).rejects.toThrow();
  });

  it.each(["valid", "legacy", "generation", "launch", "request", "lease", "node", "missing", "not-applicable", "no-acceptance"])("binds process proof to its durable launch (%s)", async (mode) => {
    const c = await fixture(); const payload = evidence(c);
    const identity = { idempotencyKey: "call", requestId: "request", caseId: "case", runId: "run", workId: "work", leaseId: "lease" };
    const launch = { nodeId: "node", generationId: "generation", launchId: "a".repeat(64), requestId: "request", requestFingerprint: "b".repeat(64) };
    if (mode !== "missing") new SqliteProcessExecutionJournal(c.sqlite).claim({ schemaVersion: mode === "legacy" ? 1 : 2,
      identity, nodeId: "node", requestFingerprint: launch.requestFingerprint, ...(mode === "legacy" ? {} : { launch }),
      status: "claimed", cleanup: "unverified", process: null, events: [], lostEvents: false, updatedAt: at });
    payload.process = { identity: { ...identity }, launch: { ...launch } };
    payload.assertion.cleanup.status = mode === "not-applicable" ? "not_applicable" : "terminal";
    if (mode === "generation") payload.process.launch.generationId = "other";
    if (mode === "launch") payload.process.launch.launchId = "c".repeat(64);
    if (mode === "request") payload.process.launch.requestFingerprint = "c".repeat(64);
    if (mode === "lease") payload.process.identity.leaseId = "other";
    const trusted = { ...authority(), processAcceptance: mode === "no-acceptance" ? undefined : { reference: "test-only acceptance", nodeIds: [mode === "node" ? "other" : "node"] } };
    const verifier = new SignedToolRecoveryEvidenceVerifier(c.sqlite, () => trusted, () => at);
    const request = { ...input(c), evidence: signEvidence(payload) };
    if (mode === "valid") expect(await verifier.verify(request)).toMatchObject({ cleanup: { status: "terminal" } });
    else await expect(verifier.verify(request)).rejects.toThrow();
  });

  it("never accepts an unsigned local observation as proof, even with an accepted authority", async () => {
    const c = await fixture();
    await expect(c.verifier.verify({ ...input(c), evidence: { cleanup: "unverified", status: "failure_observed" } })).rejects.toThrow();
    expect(await c.bindings.hasOpenBindings("neutral", "1")).toBe(true);
  });
});
