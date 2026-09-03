import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { DurableScenarioRuntime, ScenarioDefinitionRegistry } from "@traceforge/orchestration-core";
import { BlackboardChangeBus } from "@traceforge/cognitive-runtime";
import { ScenarioPackageRegistry } from "@traceforge/scenario-sdk";
import type { ToolExecutionResult } from "@traceforge/worker-runtime";
import { database, at } from "./test-fixtures/execution-recovery.js";
import { migrationFixture, migrationPackages } from "./test-fixtures/run-migration.js";
import { reviewedMaterial } from "./test-fixtures/scenario-package-trust.js";
import { ScenarioPackageTrustControl } from "./scenario-package-trust.js";
import { SqliteScenarioEventStore } from "./scenario-event-store.js";
import { ScenarioRunDisposalControl, readRunForensics, type ScenarioRunDisposalAuthorizer } from "./scenario-run-disposal.js";
import { registerPhysicalStorageFunctions } from "./db/physical-storage.js";
import { foundationHost, eventually, type FoundationHost } from "./test-fixtures/foundation-host.js";

const dbs: Database.Database[] = [], roots: string[] = [], hosts: FoundationHost[] = [];
const allowed: ScenarioRunDisposalAuthorizer = { async authorize() { return { decision: "allowed", authorizationRef: "independent-fixture-grant", expiresAt: "2099-01-01T00:00:00.000Z" }; } };
const scope = { caseId: "case", runId: "run" };
afterEach(async () => {
  vi.useRealTimers();
  for (const host of hosts.splice(0).reverse()) if (host.sqlite.open) await host.close();
  for (const db of dbs.splice(0)) if (db.open) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root() { const value = mkdtempSync(join(tmpdir(), "traceforge-disposal-")); roots.push(value); return value; }
function fixture(authorizer: ScenarioRunDisposalAuthorizer | undefined = allowed, changes?: BlackboardChangeBus) {
  const sqlite = database(); dbs.push(sqlite); const f = migrationFixture(sqlite);
  const control = new ScenarioRunDisposalControl(sqlite, authorizer, changes);
  const request = (operation: "stop" | "retire" = "stop") => ({ ...scope, operation, commandId: operation,
    expectedRevision: readRunForensics(sqlite, "run").revision, actor: "operator", reason: "Retire unavailable material" });
  return { ...f, disposal: control, request };
}

describe("Package-independent Run forensics and disposal", () => {
  it("reads and stops revoked material without executing package callbacks or rewriting old facts", async () => {
    const f = fixture(), material = reviewedMaterial(join(root(), "material"), f.source);
    const trust = new ScenarioPackageTrustControl(f.sqlite, new ScenarioPackageRegistry([f.source]), material.options);
    await trust.revoke({ commandId: "revoke", package: f.from, actor: "operator", reason: "Withdraw" });
    const forbidden = vi.fn(() => { throw new Error("Package code must not execute"); });
    f.source.createToolSources = forbidden;
    (f.source.authorizationPolicy as { parseScope: typeof forbidden }).parseScope = forbidden;
    (f.source.outputSchemas[0]! as unknown as { validate: typeof forbidden }).validate = forbidden;
    const runtime = new DurableScenarioRuntime(new SqliteScenarioEventStore(f.sqlite), new ScenarioDefinitionRegistry([f.source.definition]), trust.registry);
    expect(() => runtime.load("run")).toThrow();
    const events = new SqliteScenarioEventStore(f.sqlite).load("run").events;
    expect(f.disposal.inspect(scope).run.scenarioPackage).toEqual(f.from);
    await f.disposal.dispose(f.request());
    expect(f.disposal.inspect(scope).run.status).toBe("cancelled");
    expect(new SqliteScenarioEventStore(f.sqlite).load("run").events.slice(0, events.length)).toEqual(events);
    expect(forbidden).not.toHaveBeenCalled();
  });
  it("keeps normal Runtime commands from committing before a failed trust check", () => {
    const f = fixture(), events = new SqliteScenarioEventStore(f.sqlite), before = events.load("run");
    const runtime = new DurableScenarioRuntime(events, new ScenarioDefinitionRegistry(f.packages.definitions()), { requireAvailable() { throw new Error("revoked"); } });
    expect(() => runtime.execute({ runId: "run", commandId: "unsafe-resume", expectedRevision: before.revision,
      command: { type: "resume_run", requestedBy: "operator", reason: "Resume", at } })).toThrow("revoked");
    expect(events.load("run")).toEqual(before);
  });
  it("rejects a new Run before persistence when its package cannot be used", () => {
    const f = fixture(), events = new SqliteScenarioEventStore(f.sqlite);
    const runtime = new DurableScenarioRuntime(events, new ScenarioDefinitionRegistry(f.packages.definitions()), { requireAvailable() { throw new Error("unreviewed"); } });
    expect(() => runtime.execute({ runId: "new", commandId: "start", expectedRevision: 0, definitionKind: "neutral", definitionVersion: 1,
      command: { type: "start_run", runId: "new", caseId: "case", goal: "Observe", scopeRef: "scope", scenarioPackage: f.from, availableCapabilities: ["observe"], at } })).toThrow("unreviewed");
    expect(events.load("new").revision).toBe(0);
  });
  it.each([false, true])("preserves checkpoint and approval history when stopping; completed output=%s", async completed => {
    const f = fixture(); f.command({ type: "resume_run", reason: "Prepare history", requestedBy: "operator", at });
    const claim = (leaseId: string) => f.command({ type: "claim_work", workId: "work", workerId: "worker", workerRoles: ["observer"], workerCapabilities: ["observe"], workerCurrentWork: 0, workerMaxConcurrentWork: 1, leaseId, leaseExpiresAt: "2099-01-01T00:00:00.000Z", at });
    claim("history");
    const checkpoint = { version: 2 as const, caseId: "case", runId: "run", workId: "work", workKey: "effect", workerId: "worker", leaseId: "history", savedAt: at,
      turn: 1, consecutiveFailures: 0, pendingInvocation: null, completedInvocationIds: [], steering: [], transcript: [] };
    const ref = await f.checkpoints.save(checkpoint);
    f.command({ type: "checkpoint_work", workId: "work", leaseId: "history", checkpointId: "history", progressSummary: "Saved", payloadRef: ref, at });
    f.command({ type: "request_work_approval", workId: "work", leaseId: "history", approvalId: "approval", actionKey: "observe", toolName: "observe", risk: "read_only", rationale: "Review", inputRef: ref, at });
    if (completed) {
      f.command({ type: "resolve_work_approval", workId: "work", approvalId: "approval", approved: true, reason: "Reviewed", at }); claim("after-approval");
      f.command({ type: "complete_work", workId: "work", leaseId: "after-approval", summary: "Saved", outputs: [{ id: "output", kind: "decision", schemaVersion: 1, summary: "Observed", refs: ["evidence:first"], createdAt: at }], at });
    }
    const before = readRunForensics(f.sqlite, "run");
    await f.disposal.dispose(f.request());
    const after = f.disposal.inspect(scope).run;
    expect(after.outputs).toEqual(before.outputs); expect(after.workItems[0]!.latestCheckpoint).toEqual(before.workItems[0]!.latestCheckpoint);
    expect(await f.checkpoints.load(ref)).toEqual(checkpoint);
    expect(after.workItems[0]!.approvalHistory[0]!.status).toBe(completed ? "approved" : "cancelled");
    expect(f.disposal.records({ ...scope, kind: "checkpoints" }).records[0]!.ref).toBe(ref);
    expect(f.sqlite.prepare("SELECT count(*) n FROM scenario_work_leases WHERE run_id='run'").get()).toEqual({ n: 0 });
  });
  it("bounds an unresponsive independent authorizer", async () => {
    const f = fixture({ authorize: () => new Promise(() => {}) });
    const timeout = AbortSignal.timeout.bind(AbortSignal), spy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => timeout(5));
    try { await expect(f.disposal.dispose(f.request())).rejects.toThrow(); expect(spy).toHaveBeenCalledWith(10000); }
    finally { spy.mockRestore(); }
    expect(f.runtime.load("run")!.status).toBe("paused");
  });
  it.each(["models", "admissions"])("keeps outstanding %s as retirement blockers", async kind => {
    const f = fixture(); await f.disposal.dispose(f.request());
    if (kind === "models") f.sqlite.prepare(`INSERT INTO scenario_model_calls(id,snapshot_id,run_id,case_id,role,route_id,route_attempt,status,reserved_tokens,started_at)
      VALUES ('pending','snapshot','run','case','observer','fixture',1,'running',1,?)`).run(at);
    else f.sqlite.prepare(`INSERT INTO scenario_model_admissions(id,snapshot_id,run_id,case_id,role,priority,status,queued_at)
      VALUES ('pending','snapshot','run','case','observer',1,'queued',?)`).run(at);
    expect(f.disposal.inspect(scope).blockers.some(b => b.kind === kind)).toBe(true);
    await expect(f.disposal.dispose(f.request("retire"))).rejects.toThrow("Unresolved");
  });
  it("reports late unresolved facts even after a retirement receipt", async () => {
    const f = fixture(); await f.disposal.dispose(f.request()); await f.disposal.dispose(f.request("retire"));
    f.sqlite.prepare("INSERT INTO process_execution_occupancy VALUES ('late','key',?,'unknown',NULL,NULL,?)").run(JSON.stringify({ attribution: scope }), at);
    expect(f.disposal.inspect(scope).disposalStatus).toBe("retired_unresolved");
    expect(f.disposal.inspect(scope).retirement).not.toBeNull();
  });
  it("enforces byte limits before materializing oversized forensic pages or state", () => {
    const f = fixture(), event = new SqliteScenarioEventStore(f.sqlite).load("run").events[0]!;
    if (event.type !== "run_started") throw new Error("Fixture origin missing");
    event.state.goal = "x".repeat(4 * 1024 * 1024);
    f.sqlite.prepare("UPDATE scenario_events SET payload_json=? WHERE run_id='run' AND sequence=1").run(JSON.stringify(event));
    expect(() => f.disposal.events({ ...scope, limit: 1 })).toThrow("byte budget");
    expect(() => f.disposal.inspect(scope)).toThrow("state budget");
    expect(f.disposal.events({ ...scope, after: 1 }).events).toHaveLength(3);
  });
  it("stops then explicitly retires without deleting history, and never resumes", async () => {
    const f = fixture(); const stop = await f.disposal.dispose(f.request());
    expect(stop.audit.resultingStatus).toBe("cancelled"); expect(stop.audit.externalCleanupCertified).toBe(false);
    expect(f.disposal.inspect(scope).disposalStatus).toBe("ready_to_retire");
    const request = f.request("retire"), result = await f.disposal.dispose(request);
    expect(f.disposal.inspect(scope).disposalStatus).toBe("retired");
    expect((await f.disposal.dispose(request)).replayed).toBe(true);
    expect(f.disposal.audit({ ...scope, commandId: "retire" })).toEqual(result.audit);
    await expect(f.disposal.dispose({ ...request, commandId: "again" })).rejects.toThrow("already retired");
    expect(f.runtime.load("run")!.status).toBe("cancelled");
    expect(() => f.command({ type: "resume_run", reason: "No", requestedBy: "operator", at })).toThrow();
  });
  it("does not treat a running or paused Run as retired", async () => {
    const f = fixture(); await expect(f.disposal.dispose(f.request("retire"))).rejects.toThrow("stopped");
    expect(f.disposal.inspect(scope).disposalStatus).toBe("stop_required");
  });
  it.each(["missing", "denied", "expired", "empty"])("requires independent valid authorization: %s", async mode => {
    const f = fixture(), control = new ScenarioRunDisposalControl(f.sqlite, mode === "missing" ? undefined : { async authorize() {
      return mode === "denied" ? { decision: "denied" } : { decision: "allowed", authorizationRef: mode === "empty" ? "" : "grant",
        expiresAt: mode === "expired" ? "2020-01-01T00:00:00.000Z" : "2099-01-01T00:00:00.000Z" };
    } });
    await expect(control.dispose(f.request())).rejects.toThrow("authorization"); expect(f.runtime.load("run")!.revision).toBe(4);
  });
  it("reauthorizes replays and rejects command identity conflicts", async () => {
    let calls = 0; const f = fixture({ async authorize(request) { calls++; return allowed.authorize(request); } });
    const input = f.request(); await Promise.all([f.disposal.dispose(input), f.disposal.dispose(input)]);
    expect(calls).toBe(2); expect(f.runtime.load("run")!.revision).toBe(5);
    await expect(f.disposal.dispose({ ...input, reason: "Other" })).rejects.toThrow("conflict");
    await expect(new ScenarioRunDisposalControl(f.sqlite).dispose(input)).rejects.toThrow("authorization");
  });
  it("rejects stale revisions and changes while authorization is pending", async () => {
    const f = fixture(), input = f.request(); let release!: () => void;
    const control = new ScenarioRunDisposalControl(f.sqlite, { async authorize(request) { await new Promise<void>(r => { release = r; }); return allowed.authorize(request); } });
    const pending = control.dispose(input);
    await Promise.resolve(); f.command({ type: "resume_run", reason: "Changed", requestedBy: "operator", at }); release();
    await expect(pending).rejects.toThrow("changed");
    await expect(f.disposal.dispose(input)).rejects.toThrow("changed");
  });
  it("snapshots the request before asynchronous authorization", async () => {
    const f = fixture(), input = f.request(); let release!: () => void;
    const control = new ScenarioRunDisposalControl(f.sqlite, { async authorize(request) { await new Promise<void>(r => { release = r; }); return allowed.authorize(request); } });
    const pending = control.dispose(input); await Promise.resolve(); input.reason = "mutated"; release();
    expect((await pending).audit.reason).toBe("Retire unavailable material");
  });
  it.each(["event", "audit"])("rolls back state, leases and audit on %s write failure", async kind => {
    const changes = new BlackboardChangeBus(), notifications = vi.fn(); changes.subscribe(notifications);
    const f = fixture(allowed, changes), before = f.runtime.load("run");
    f.sqlite.exec(`CREATE TEMP TRIGGER fail_disposal BEFORE INSERT ON ${kind === "event" ? "scenario_events" : "scenario_run_disposal_audits"} BEGIN SELECT RAISE(ABORT,'injected'); END`);
    await expect(f.disposal.dispose(f.request())).rejects.toThrow("injected"); expect(f.runtime.load("run")).toEqual(before);
    expect(f.sqlite.prepare("SELECT count(*) n FROM scenario_run_disposal_audits").get()).toEqual({ n: 0 }); expect(notifications).not.toHaveBeenCalled();
  });
  it("preserves state when recovery storage is exhausted", async () => {
    const f = fixture(); registerPhysicalStorageFunctions(f.sqlite, () => ({ databaseBytes: 0, walBytes: 0, shmBytes: 0, availableBytes: 0 }));
    await expect(f.disposal.dispose(f.request())).rejects.toThrow(); expect(f.runtime.load("run")!.status).toBe("paused");
  });
  it("bounds mass stop projection writes and preserves all pending records on rejection", async () => {
    const f = fixture();
    f.sqlite.transaction(() => {
      const insert = f.sqlite.prepare("INSERT INTO scenario_work_approvals VALUES (?,'run','case','work','action','observe','read_only','Review','input','pending','worker',NULL,?,NULL)");
      for (let i = 0; i < 1025; i++) insert.run(`pending-${i}`, at);
    })();
    await expect(f.disposal.dispose(f.request())).rejects.toThrow("projection budget");
    expect(f.runtime.load("run")!.status).toBe("paused");
    expect(f.sqlite.prepare("SELECT count(*) n FROM scenario_work_approvals WHERE status='pending'").get()).toEqual({ n: 1025 });
  });
  it("refuses retirement when occupancy recovery tables are not initialized", async () => {
    const f = fixture(); await f.disposal.dispose(f.request()); f.sqlite.exec("DROP TABLE process_execution_occupancy");
    await expect(f.disposal.dispose(f.request("retire"))).rejects.toThrow();
    expect(f.sqlite.prepare("SELECT count(*) n FROM scenario_run_disposal_audits WHERE operation='retire'").get()).toEqual({ n: 0 });
  });
  it("keeps committed state despite notification failure and republishes on replay", async () => {
    const changes = new BlackboardChangeBus(), listener = vi.fn(() => { throw new Error("broken listener"); }); changes.subscribe(listener);
    const f = fixture(allowed, changes), input = f.request(); await f.disposal.dispose(input); await f.disposal.dispose(input);
    expect(listener).toHaveBeenCalledTimes(2); expect(f.runtime.load("run")!.status).toBe("cancelled");
  });
  it.each(["processes", "managed", "invocations"])("does not release or retire unresolved %s", async kind => {
    const f = fixture();
    if (kind === "processes") f.sqlite.prepare("INSERT INTO process_execution_occupancy VALUES ('external','key',?,'unknown',NULL,NULL,?)")
      .run(JSON.stringify({ attribution: scope }), at);
    if (kind === "managed") f.sqlite.prepare("INSERT INTO managed_execution_occupancy VALUES ('external',?,'old-host','unknown',NULL,NULL,?,?)")
      .run(JSON.stringify({ scheduling: scope }), at, at);
    if (kind === "invocations") await f.bindings.prepare({ idempotencyKey: "external", invocationId: "first",
      tool: { name: "observe", source: "neutral", version: "1", contractFingerprint: "a".repeat(64) }, inputFingerprint: "b".repeat(64), attribution: { ...scope, workId: "work" } });
    await f.disposal.dispose(f.request());
    const view = f.disposal.inspect(scope); expect(view.disposalStatus).toBe("stopped_unresolved");
    expect(view.blockers.some(b => b.kind === kind && b.sampleIds.includes("external"))).toBe(true);
    await expect(f.disposal.dispose(f.request("retire"))).rejects.toThrow("Unresolved");
    expect(f.disposal.records({ ...scope, kind }).records).toHaveLength(1);
  });
  it("only retires after independent cleanup has released occupancy", async () => {
    const f = fixture(); f.sqlite.prepare("INSERT INTO process_execution_occupancy VALUES ('external','key',?,'unknown',NULL,NULL,?)").run(JSON.stringify({ attribution: scope }), at);
    await f.disposal.dispose(f.request()); await expect(f.disposal.dispose(f.request("retire"))).rejects.toThrow("Unresolved");
    // Fixture stands in for the separately tested signed-cleanup control. Disposal never performs this write.
    f.sqlite.prepare("UPDATE process_execution_occupancy SET state='released',proof_ref='independent-fixture-proof' WHERE id='external'").run();
    await f.disposal.dispose(f.request("retire")); expect(f.disposal.inspect(scope).disposalStatus).toBe("retired");
  });
  it("enforces case identity, page bounds and read-only cursor traversal", () => {
    const f = fixture(), before = f.runtime.load("run");
    expect(() => f.disposal.inspect({ caseId: "other", runId: "run" })).toThrow("scope");
    expect(() => f.disposal.events({ ...scope, limit: 101 })).toThrow();
    expect(() => f.disposal.records({ ...scope, kind: "unknown" })).toThrow();
    const first = f.disposal.events({ ...scope, limit: 2 }), second = f.disposal.events({ ...scope, limit: 2, after: first.next });
    expect(first.events.map(e => e.sequence)).toEqual([1, 2]); expect(second.events.map(e => e.sequence)).toEqual([3, 4]); expect(second.hasMore).toBe(false);
    expect(f.runtime.load("run")).toEqual(before); expect(f.disposal.inspect(scope).executionAuthorized).toBe(false);
  });
  it("refuses corrupt projections without losing the raw paginated event view", async () => {
    const f = fixture(), input = f.request(); f.sqlite.prepare("UPDATE scenario_event_streams SET status='running' WHERE run_id='run'").run();
    expect(() => f.disposal.inspect(scope)).toThrow("integrity"); await expect(f.disposal.dispose(input)).rejects.toThrow("integrity");
    expect(f.disposal.events(scope).events).toHaveLength(4);
  });
  it("protects immutable audit and detects referenced event corruption", async () => {
    const f = fixture(); await f.disposal.dispose(f.request());
    expect(() => f.sqlite.prepare("DELETE FROM scenario_run_disposal_audits").run()).toThrow("immutable");
    expect(() => f.sqlite.prepare("UPDATE scenario_run_disposal_audits SET audit_hash='bad'").run()).toThrow("immutable");
    f.sqlite.prepare("UPDATE scenario_events SET payload_json=? WHERE run_id='run' AND command_id='disposal:stop'")
      .run(JSON.stringify({ type: "run_cancelled", reason: "tampered", at }));
    expect(() => f.disposal.audit({ ...scope, commandId: "stop" })).toThrow("integrity");
  });
  it("keeps the full-host control protected and default denied even when the package is absent", async () => {
    const host = await foundationHost({ ready: () => false }); hosts.push(host); await host.start(); await host.close(false);
    const reopened = await foundationHost({ root: host.root, empty: true, ready: () => false }); hosts.push(reopened);
    expect((await reopened.app.inject({ url: "/api/scenarios/runs/run/disposal?caseId=case" })).statusCode).toBe(401);
    expect((await reopened.request("/api/scenarios/runs/run/disposal?caseId=case")).run.id).toBe("run");
    await expect(reopened.request("/api/scenarios/runs/run/disposal", { ...scope, operation: "stop", commandId: "stop", expectedRevision: 2, actor: "operator", reason: "Stop" })).rejects.toThrow("authorization");
  });
  it("cancels an in-flight tool after signed package revocation and retains unknown results across restart", async () => {
    const p = migrationPackages(), pkg = p.source;
    pkg.definition.requiredCapabilities = ["fixture.read"]; pkg.definition.authorizationActions = ["fixture.read"];
    pkg.definition.phases.forEach(phase => { phase.requiredCapabilities = ["fixture.read"]; });
    pkg.definition.agentTopology.workerPools.forEach(pool => { pool.capabilities = ["fixture.read"]; });
    pkg.authorizationPolicy = { parseScope: payload => ({ payload, allowedActions: ["fixture.read"], deniedActions: [] }) };
    const material = reviewedMaterial(join(root(), "material"), pkg);
    let signal: AbortSignal | undefined, calls = 0, release!: (result: ToolExecutionResult) => void;
    const host = await foundationHost({ foundation: { scenarioPackageRegistry: new ScenarioPackageRegistry([pkg]), scenarioPackageTrust: material.options,
      runDisposalAuthorizer: allowed, toolDiscoverySources: [{ source: "fixture.host", async discover() { return [{
        name: "fixture.read", source: "fixture.host", version: "1", priority: 1, description: "Observe", inputSchema: {}, providedCapabilities: ["fixture.read"],
        dependencyCapabilities: [], permissionRequirements: {}, risk: "read_only", timeoutMs: 60000,
        execute(_input, context) { calls++; signal = context.signal; return new Promise<ToolExecutionResult>(r => { release = r; }); },
      }]; } }] } }); hosts.push(host);
    await host.start(); await eventually(async () => calls === 1);
    await host.request("/api/scenarios/package-trust/revoke", { commandId: "withdraw", package: p.from, actor: "operator", reason: "Withdraw" });
    await expect(host.state()).rejects.toThrow();
    const view = await host.request("/api/scenarios/runs/run/disposal?caseId=case");
    await host.request("/api/scenarios/runs/run/disposal", { ...scope, operation: "stop", commandId: "stop", expectedRevision: view.run.revision, actor: "operator", reason: "Stop withdrawn package" });
    await eventually(async () => signal?.aborted === true);
    release({ status: "succeeded", summary: "Late result", raw: "late", refs: [], retryable: false });
    await eventually(async () => (host.sqlite.prepare("SELECT status FROM tool_invocation_executions").get() as { status: string })?.status === "uncertain");
    expect(host.sqlite.prepare("SELECT count(*) n FROM worker_tool_receipts").get()).toEqual({ n: 0 });
    expect((await host.request("/api/scenarios/runs/run/disposal?caseId=case")).disposalStatus).toBe("stopped_unresolved");
    await host.close(false);
    const reopened = await foundationHost({ root: host.root, empty: true, ready: () => false, foundation: { runDisposalAuthorizer: allowed } }); hosts.push(reopened);
    const restored = await reopened.request("/api/scenarios/runs/run/disposal?caseId=case");
    expect(restored.run.status).toBe("cancelled"); expect(restored.blockers.some((b: { kind: string }) => b.kind === "invocations")).toBe(true);
    expect(calls).toBe(1); expect(reopened.calls()).toBe(0);
  });
  it.each(["event", "audit", "committed", "retire", "retire_audit"])("recovers two fresh hosts after SIGKILL at %s", async phase => {
    const path = root();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../test-fixtures/scenario-run-disposal-crash-host.mjs", import.meta.url)), path, phase], { stdio: ["ignore", "ignore", "pipe"] });
      let errors = ""; child.stderr.on("data", chunk => { errors += chunk; });
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Crash fixture deadline")); }, 15000);
      child.on("error", reject); child.on("exit", (_code, signal) => { clearTimeout(timer); signal === "SIGKILL" ? resolve() : reject(new Error(errors)); });
    });
    for (let pass = 0; pass < 2; pass++) {
      const sqlite = database(join(path, "state.db")); dbs.push(sqlite);
      const control = new ScenarioRunDisposalControl(sqlite, allowed), view = control.inspect(scope);
      expect(view.run.status).toBe(["committed", "retire", "retire_audit"].includes(phase) ? "cancelled" : "paused");
      expect(view.retirement !== null).toBe(phase === "retire");
      expect(sqlite.prepare("SELECT count(*) n FROM scenario_run_disposal_audits").get()).toEqual({ n: phase === "retire" ? 2 : ["committed", "retire_audit"].includes(phase) ? 1 : 0 });
      sqlite.close();
    }
  });
});
