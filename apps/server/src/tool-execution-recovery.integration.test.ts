import { mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { LocalExecutionNode, NodeSpawnProcessLauncher, permissionProfileFingerprint, resourceLimitsFingerprint } from "@traceforge/execution-node";
import { createExecutionToolRegistry, PolicyExecutionToolGateway, ToolInvocationRecoveryRequiredError, type WorkerAssignment } from "@traceforge/worker-runtime";
import { at, authority, controls, database, evidence, initialize, signEvidence, uncertain } from "./test-fixtures/execution-recovery.js";
import { ExecutionNodeProcessTool, SqliteToolReceiptStore } from "./worker-execution-adapters.js";
import { SqliteProcessExecutionJournal } from "./execution-process-journal.js";
import { registerToolExecutionRecoveryRoutes } from "./tool-execution-recovery.js";
import { recoveryEvidenceHash } from "./tool-recovery-evidence.js";

const databases: Database.Database[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function open(path?: string) { const db = database(path); databases.push(db); return db; }
function command(c: ReturnType<typeof controls>) {
  return { idempotencyKey: "call", commandId: "recover", actor: "operator", reason: "independently verified outcome",
    resolution: "confirmed_no_effect" as const, evidence: signEvidence(evidence(c)), retry: { expectedRevision: 4 } };
}
async function crashHost(path: string, mode: "crash" | "resume", phase: string, request: unknown) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../test-fixtures/execution-recovery-crash-host.mjs", import.meta.url)),
      path, mode, phase, JSON.stringify(request), authority().publicKeyPem], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "", errors = "", failure: Error | undefined;
    const fail = (reason: string) => { failure = new Error(reason); child.kill("SIGKILL"); };
    const timer = setTimeout(() => fail("Recovery host deadline exceeded"), 15000);
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      if (output.length > 64000) return fail("Recovery host output limit");
      if (mode === "crash" && output.includes("\n")) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk) => { errors += String(chunk); if (errors.length > 64000) fail("Recovery host error limit"); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (mode === "crash" ? signal !== "SIGKILL" : code !== 0) return reject(new Error(`Recovery host failed: ${code}/${signal}: ${errors}`));
      try { resolve(JSON.parse(output)); } catch { reject(new Error(`Invalid host response: ${output}`)); }
    });
  });
}

describe("Integrated execution recovery", () => {
  it.each(["registered", "reconciled", "retried"])("recovers a separate host killed at %s with exactly one replacement Work", async (stage) => {
    const directory = mkdtempSync(join(tmpdir(), "traceforge-recovery-kill-")); directories.push(directory);
    const path = join(directory, "state.sqlite"); const db = open(path); const c = await uncertain(db);
    const request = command(c); db.close();
    expect(await crashHost(path, "crash", stage, request)).toEqual({ checkpoint: stage });
    const expected = { outcome: "retry_queued", workCount: 2, audits: 1, retryAudits: 1, integrity: "ok" };
    expect(await crashHost(path, "resume", stage, request)).toEqual(expected);
    expect(await crashHost(path, "resume", stage, request)).toEqual(expected);
  });

  it.each(["registered", "reconciled", "retried"] as const)("resumes across database restart after %s without repeating committed stages", async (stage) => {
    const directory = mkdtempSync(join(tmpdir(), "traceforge-recovery-")); directories.push(directory);
    const path = join(directory, "state.sqlite");
    const db = open(path); await uncertain(db);
    const c = controls(db, { stage(current) { if (current === stage) throw new Error("connection interrupted"); } });
    const request = command(c);
    await expect(c.recovery.recover(request)).rejects.toThrow("connection interrupted");
    db.close();
    const restarted = controls(open(path));
    const result = await restarted.recovery.resume("recover", "operator");
    expect(result.outcome).toBe("retry_queued");
    expect((await restarted.recovery.resume("recover", "operator")).retry?.replayed).toBe(true);
    expect(restarted.runtime.load("run")!.workItems).toHaveLength(2);
    expect(restarted.runtime.load("run")!.workItems[0].status).toBe("blocked");
    expect(restarted.reconciliation.listAudits("call")).toHaveLength(1);
    expect(restarted.sqlite.prepare("SELECT count(*) AS n FROM scenario_work_retry_audits").get()).toEqual({ n: 1 });
    expect(await restarted.bindings.hasOpenBindings("neutral", "1")).toBe(false);
    expect(restarted.recovery.inspect("call")).toMatchObject({ automaticRetryAllowed: false, hasReceipt: false,
      commands: [{ reconciliation: "resolved", retry: "queued" }] });
    await expect(restarted.recovery.resume("recover", "other")).rejects.toThrow("actor");
    await expect(restarted.recovery.recover({ ...request, reason: "changed" })).rejects.toThrow("conflicts");
    expect(() => restarted.sqlite.exec("DELETE FROM tool_recovery_commands")).toThrow("immutable");
    expect(() => restarted.sqlite.exec("UPDATE tool_recovery_evidence SET envelope_json = '{}'")).toThrow("immutable");
  });

  it("keeps the successfully reconciled outcome when retry authorization is denied", async () => {
    const db = open(); await uncertain(db);
    const c = controls(db, { retryDenied: true });
    expect(await c.recovery.recover(command(c))).toMatchObject({ outcome: "retry_blocked", retry: { audit: { outcome: "denied" } } });
    expect(c.bindings.execution("call")?.status).toBe("completed");
    expect(c.runtime.load("run")!.workItems).toHaveLength(1);
  });

  it("retains verified results without permitting a whole-Work rerun", async () => {
    const c = await uncertain(open());
    const result = { status: "succeeded" as const, summary: "verified result", raw: "", refs: [], retryable: false };
    const payload = evidence(c);
    payload.assertion.outcome = "result_confirmed";
    payload.assertion.cleanup.status = "not_applicable";
    payload.assertion.resultFingerprint = recoveryEvidenceHash(result);
    const request = { ...command(c), resolution: "confirmed_result", result, evidence: signEvidence(payload), retry: undefined };
    expect(await c.recovery.recover(request)).toMatchObject({ outcome: "reconciled", retry: null });
    expect(await new SqliteToolReceiptStore(c.sqlite).get("call")).toEqual(result);
    await expect(c.recovery.recover({ ...request, commandId: "repeat", retry: { expectedRevision: 4 } })).rejects.toThrow("must not be repeated");
    expect((await c.retry.retry({ commandId: "unsafe", runId: "run", workId: "work", actor: "operator", reason: "repeat", expectedRevision: 4 })).audit.outcome).toBe("rejected");
  });

  it("exposes one redacted control API and keeps denied requests uncertain", async () => {
    const db = open(); await uncertain(db); const c = controls(db, { denied: true });
    const app = Fastify(); registerToolExecutionRecoveryRoutes(app, c.recovery);
    try {
      const { idempotencyKey, ...body } = command(c);
      expect((await app.inject({ method: "POST", url: `/api/security-tools/invocations/${idempotencyKey}/recover`, payload: body })).statusCode).toBe(403);
      const response = await app.inject({ url: "/api/security-tools/invocations/call/recovery" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ execution: { status: "uncertain" }, commands: [{ reconciliation: "denied" }] });
      expect(response.body).not.toContain("signature");
      expect((await app.inject({ method: "POST", url: "/api/security-tools/recovery/commands/recover/resume", payload: { actor: "operator" } })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: "/api/security-tools/invocations/call/recover", payload: {} })).statusCode).toBe(400);
    } finally { await app.close(); }
  });

  it.each(["watchdog", "gateway"])("carries a real process %s timeout through uncertainty, durable provenance and authorized recovery", async (mode) => {
    const directory = mkdtempSync(join(tmpdir(), "traceforge-recovery-process-")); directories.push(directory);
    const path = join(directory, "state.sqlite");
    const sqlite = open(path); const initialized = initialize(sqlite);
    const now = () => new Date().toISOString();
    const c = controls(sqlite, { now });
    const platform: "darwin" | "windows" | "linux" = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
    // Real subprocess, test-only enforcement metadata: not a native sandbox certification.
    const node = new LocalExecutionNode(new NodeSpawnProcessLauncher((request) => ({
      executable: request.executable, arguments: request.arguments, workingDirectory: request.workingDirectory,
      environment: request.environment, detached: false, windowsHide: true,
      enforcement: { sandboxBackend: "test", sandboxed: true, filesystemPolicyApplied: true, network: "deny",
        permissionProfileFingerprint: permissionProfileFingerprint(request.permissions), resourceLimitsApplied: true,
        resourceLimitsFingerprint: resourceLimitsFingerprint(request.resources) },
    })), { platform, sandboxBackends: ["test"], processJournal: new SqliteProcessExecutionJournal(sqlite),
      capabilities: { process: { spawn: true, stdio: true, tty: false, adoption: true, resourceLimits: true, signals: ["kill"] } } });
    const permissions = { version: 1 as const, platform, filesystem: {
      read: [{ path: directory, scope: "tree" as const }, { path: dirname(process.execPath), scope: "tree" as const }], write: [], deny: [],
    }, network: "deny" as const, process: { access: "sandboxed" as const, interactive: false, background: false }, secrets: "deny" as const };
    let terminations = 0;
    const terminate = node.terminateProcess.bind(node);
    node.terminateProcess = async (request) => { terminations++; return terminate(request); };
    const adapter = new ExecutionNodeProcessTool(node);
    const registry = createExecutionToolRegistry([{ ...adapter, execute: adapter.execute.bind(adapter), timeoutMs: mode === "gateway" ? 150 : adapter.timeoutMs }]);
    const gateway = new PolicyExecutionToolGateway(registry, { async authorize() { return { decision: "approved" }; } }, new SqliteToolReceiptStore(sqlite),
      { allowedRisks: ["privileged"], permissionLayers: () => [{ source: "test", profile: permissions }] }, undefined, c.bindings);
    const state = initialized.runtime.load("run")!;
    const assignment: WorkerAssignment = { runId: "run", leaseId: "lease", leaseExpiresAt: "2099-01-01T00:00:00.000Z", runRevision: state.revision,
      runContext: { caseId: "case", goal: "Observe", scopeRef: "scope", activePhaseId: "observe", directives: [] },
      work: { ...state.workItems[0], requiredCapabilities: ["process.execute"] } };
    await expect(gateway.execute({ worker: { id: "worker", roles: ["observer"], capabilities: ["process.execute"], maxConcurrentWork: 1, status: "online", heartbeatAt: at },
      assignment, idempotencyKey: "call", invocation: { id: "first", tool: "process_execute", rationale: "test timeout", input: {
        executable: process.execPath, arguments: ["-e", "setInterval(() => {}, 1000)"], workingDirectory: directory, timeoutMs: mode === "gateway" ? 5000 : 150,
      } } })).rejects.toBeInstanceOf(ToolInvocationRecoveryRequiredError);
    expect(c.bindings.execution("call")?.status).toBe("uncertain");
    expect(await new SqliteToolReceiptStore(sqlite).get("call")).toBeUndefined();
    initialized.block();
    expect(await c.bindings.hasOpenBindings("traceforge.builtin", "1.0.0")).toBe(true);
    const journal = new SqliteProcessExecutionJournal(sqlite);
    await expect.poll(() => journal.get("call")?.status, { timeout: 3000 }).not.toBe("claimed");
    const observed = journal.get("call")!;
    if (mode === "gateway") expect(terminations).toBe(1);
    expect(observed).toMatchObject({ schemaVersion: 2, status: mode === "gateway" ? "exit_observed" : "failure_observed", cleanup: "unverified", launch: { launchId: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    const app = Fastify(); registerToolExecutionRecoveryRoutes(app, c.recovery);
    try {
      const response = await app.inject({ method: "GET", url: "/api/security-tools/execution-history?caseId=case&runId=run&limit=1" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ entries: [{ identity: { idempotencyKey: "call" } }], nextCursor: null, capacity: { records: 1 } });
      expect(response.body).not.toContain("setInterval");
      expect((await app.inject({ method: "GET", url: "/api/security-tools/execution-history?caseId=case&runId=run&limit=101" })).statusCode).toBe(400);
    } finally { await app.close(); }
    sqlite.close();
    const accepted = { ...authority(), processAcceptance: { reference: "test-only-attestor-not-platform-certification", nodeIds: [observed.nodeId] } };
    const restarted = controls(open(path), { now, authority: accepted });
    const payload = evidence(restarted, "call", now());
    payload.process = { identity: observed.identity, launch: observed.launch! };
    payload.assertion.cleanup.status = "terminal";
    const request = { ...command(restarted), evidence: signEvidence(payload) };
    expect(await restarted.recovery.recover(request)).toMatchObject({ outcome: "retry_queued" });
    expect(restarted.runtime.load("run")!.workItems).toHaveLength(2);
    expect(restarted.recovery.inspect("call").process?.cleanup).toBe("unverified");
    expect(restarted.reconciliation.listAudits("call")[0].verifiedAssertion?.cleanup.evidenceRef).toMatch(/^recovery-evidence:/);
  });
});
