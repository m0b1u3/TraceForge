import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { DurableScenarioRuntime, ScenarioDefinitionRegistry, replayScenario, type ScenarioEvent } from "@traceforge/orchestration-core";
import { database, at } from "./test-fixtures/execution-recovery.js";
import { migrationFixture } from "./test-fixtures/run-migration.js";
import { ScenarioHistoryControl, type ScenarioHistoryAuthorizer } from "./scenario-history-control.js";
import { SqliteScenarioEventStore, SqliteWorkerRegistry } from "./scenario-event-store.js";
import { ScenarioRunDisposalControl } from "./scenario-run-disposal.js";
import { ScenarioRunRecoveryService } from "./scenario-run-recovery.js";
import { AgentAuditProjection } from "./agent-audit-projection.js";
import { SqliteScenarioAgentEventStream } from "./scenario-agent-event-stream.js";
import { registerPhysicalStorageFunctions } from "./db/physical-storage.js";
import { foundationHost, type FoundationHost } from "./test-fixtures/foundation-host.js";

const dbs: Database.Database[] = [], roots: string[] = [], hosts: FoundationHost[] = [];
const scope = { caseId: "case", runId: "run" };
const grant: ScenarioHistoryAuthorizer = { async authorize() { return { decision: "allowed", authorizationRef: "reviewed-history", expiresAt: "2099-01-01T00:00:00.000Z" }; } };
afterEach(async () => {
  vi.restoreAllMocks();
  for (const host of hosts.splice(0).reverse()) if (host.sqlite.open) await host.close();
  for (const db of dbs.splice(0)) if (db.open) db.close();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
function root() { const path = mkdtempSync(join(tmpdir(), "traceforge-run-history-")); roots.push(path); return path; }
function fixture(authorizer: ScenarioHistoryAuthorizer | undefined = grant) {
  const sqlite = database(); dbs.push(sqlite); const f = migrationFixture(sqlite), events = new SqliteScenarioEventStore(sqlite);
  const history = new ScenarioHistoryControl(sqlite, authorizer);
  const request = (throughRevision = events.revision("run"), commandId = `archive:${throughRevision}`) => {
    const range = { ...scope, expectedRevision: events.revision("run"), throughRevision };
    return { ...range, commandId, actor: "operator", reason: "Preserve long history", planFingerprint: history.preview(range).planFingerprint };
  };
  return { ...f, events, history, requestMigration: f.request, request };
}

describe("Bounded Run snapshots and atomic cold event history", () => {
  it("roundtrips original events and state while keeping permanent command metadata", async () => {
    const f = fixture(), before = f.events.load("run"), state = f.runtime.load("run");
    const result = await f.history.archive(f.request());
    expect(result.audit.compressedBytes).toBeLessThan(result.audit.originalBytes);
    expect(f.events.load("run")).toEqual(before); expect(f.runtime.load("run")).toEqual(state);
    expect(f.sqlite.prepare("SELECT count(*) n FROM scenario_events WHERE payload_json LIKE 'run-history:%'").get()).toEqual({ n: 3 });
    expect(f.sqlite.prepare("SELECT count(*) n FROM scenario_commands").get()).toEqual({ n: 4 });
    expect(f.history.inspect(scope).archivedThrough).toBe(4);
  });
  it("uses the snapshot path without loading a full event array", async () => {
    const f = fixture(); await f.history.archive(f.request());
    vi.spyOn(f.events, "load").mockImplementation(() => { throw new Error("Full replay forbidden"); });
    const runtime = new DurableScenarioRuntime(f.events, new ScenarioDefinitionRegistry(f.packages.definitions()), f.packages);
    expect(runtime.load("run")!.revision).toBe(4);
    runtime.execute({ runId: "run", commandId: "resume", expectedRevision: 4, command: { type: "resume_run", reason: "Continue", requestedBy: "operator", at } });
    expect(runtime.load("run")!.status).toBe("running");
  });
  it("rejects oversized new state before committing events", () => {
    const f = fixture();
    expect(() => f.runtime.execute({ runId: "large", commandId: "start", expectedRevision: 0, definitionKind: "neutral", definitionVersion: 1,
      command: { type: "start_run", runId: "large", caseId: "case", goal: "x".repeat(2 * 1024 * 1024), scopeRef: "scope", scenarioPackage: f.from,
        availableCapabilities: ["observe"], at } })).toThrow("capacity exceeded before commit");
    expect(f.events.revision("large")).toBe(0);
  });
  it("replays old commands from cold bodies without producing new events", async () => {
    const f = fixture(), before = f.events.findCommand("run", "propose"); await f.history.archive(f.request());
    const result = f.runtime.execute({ runId: "run", commandId: "propose", expectedRevision: 1,
      command: { type: "propose_work", proposal: { id: "work", kind: "observe", title: "Observe", objective: "Observe", idempotencyKey: "effect" }, at } });
    expect(result.idempotentReplay).toBe(true); expect(f.events.findCommand("run", "propose")).toEqual(before); expect(f.events.revision("run")).toBe(4);
    expect(() => f.runtime.execute({ runId: "run", commandId: "propose", expectedRevision: 4,
      command: { type: "pause_run", reason: "Other", requestedBy: "operator", at } })).toThrow("different content");
  });
  it("keeps lease identities non-reusable after archived claim events", async () => {
    const f = fixture(); await f.history.archive(f.request()); f.command({ type: "resume_run", reason: "Resume", requestedBy: "operator", at });
    expect(() => f.command({ type: "claim_work", workId: "work", leaseId: "lease", workerId: "worker", workerRoles: ["observer"], workerCapabilities: ["observe"],
      workerCurrentWork: 0, workerMaxConcurrentWork: 1, leaseExpiresAt: "2099-01-01T00:00:00.000Z", at })).toThrow("previously used");
  });
  it("backfills legacy lease history only as part of the atomic archive", async () => {
    const f = fixture(); f.sqlite.exec("DROP TRIGGER scenario_lease_history_DELETE; DELETE FROM scenario_lease_history");
    expect(f.events.hasUsedLease("run", "lease")).toBe(true); await f.history.archive(f.request());
    expect(f.sqlite.prepare("SELECT lease_id FROM scenario_lease_history WHERE run_id='run'").all()).toEqual([{ lease_id: "lease" }]);
  });
  it("reconstructs arbitrary old revisions and a command crossing the hot/cold boundary", async () => {
    const f = fixture();
    const events: ScenarioEvent[] = [{ type: "run_resumed", reason: "Continue", requestedBy: "operator", at }, { type: "run_paused", reason: "Hold", requestedBy: "operator", at }];
    f.events.append({ runId: "run", commandId: "batch", expectedRevision: 4, fingerprint: "batch", events });
    const before = f.events.load("run"); await f.history.archive(f.request(5));
    expect(f.events.findCommand("run", "batch")!.events).toEqual(events);
    for (let revision = 1; revision <= 6; revision++) expect(f.events.loadState("run", revision)).toEqual(replayScenario(before.events.slice(0, revision)));
    const recovery = new ScenarioRunRecoveryService(f.runtime, f.events, new SqliteWorkerRegistry(f.sqlite));
    expect(recovery.replay("run", 3)!.state).toEqual(replayScenario(before.events.slice(0, 3)));
  });
  it("retains package migration events and current trust checks across snapshots", async () => {
    const f = fixture(); await f.history.archive(f.request()); await f.control.migrate(await f.requestMigration());
    await f.history.archive(f.request()); expect(f.runtime.load("run")!.scenarioPackage).toEqual(f.to);
    expect(f.events.loadState("run", 4)!.scenarioPackage).toEqual(f.from);
  });
  it("does not turn an archived state into permission to use a revoked package", async () => {
    const f = fixture(); await f.history.archive(f.request());
    const denied = new DurableScenarioRuntime(f.events, new ScenarioDefinitionRegistry(f.packages.definitions()), { requireAvailable() { throw new Error("revoked"); } });
    expect(() => denied.load("run")).toThrow("revoked");
    expect(new ScenarioRunDisposalControl(f.sqlite).inspect(scope).run.revision).toBe(4);
  });
  it("reads a history longer than the old full-replay ceiling and can stop it without a package", async () => {
    const f = fixture(), all = f.events.load("run").events;
    for (let i = 0; i < 5100; i++) {
      const event: ScenarioEvent = i % 2 === 0 ? { type: "run_resumed", reason: "Continue", requestedBy: "operator", at }
        : { type: "run_paused", reason: "Hold", requestedBy: "operator", at };
      f.events.append({ runId: "run", commandId: `history:${i}`, expectedRevision: 4 + i, fingerprint: `history:${i}`, events: [event] }); all.push(event);
    }
    expect(() => f.runtime.load("run")).toThrow("tail budget");
    for (let through = 1000; through <= 5000; through += 1000) await f.history.archive(f.request(through));
    expect(f.runtime.load("run")).toEqual(replayScenario(all));
    expect(() => f.events.load("run")).toThrow("export budget");
    const disposal = new ScenarioRunDisposalControl(f.sqlite, { async authorize() { return { decision: "allowed", authorizationRef: "fixture", expiresAt: "2099-01-01T00:00:00.000Z" }; } });
    await disposal.dispose({ ...scope, commandId: "stop", operation: "stop", expectedRevision: 5104, actor: "operator", reason: "Stop" });
    expect(disposal.inspect(scope).run.status).toBe("cancelled");
    expect(disposal.events({ ...scope, after: 4999, limit: 2 }).events.map(e => e.sequence)).toEqual([5000, 5001]);
  });
  it("preserves historical output and evidence references in a snapshot", async () => {
    const f = fixture(); f.command({ type: "resume_run", reason: "Continue", requestedBy: "operator", at });
    f.command({ type: "claim_work", workId: "work", leaseId: "second", workerId: "worker", workerRoles: ["observer"], workerCapabilities: ["observe"], workerCurrentWork: 0,
      workerMaxConcurrentWork: 1, leaseExpiresAt: "2099-01-01T00:00:00.000Z", at });
    f.command({ type: "complete_work", workId: "work", leaseId: "second", summary: "Saved", outputs: [{ id: "output", kind: "decision", schemaVersion: 1, summary: "Observed", refs: ["evidence:first"], createdAt: at }], at });
    const before = f.events.loadState("run"); await f.history.archive(f.request()); expect(f.events.loadState("run")).toEqual(before);
    expect(f.events.loadState("run")!.outputs[0]!.refs).toEqual(["evidence:first"]);
  });
  it("projects missing shared audit items from archived control events", async () => {
    const f = fixture(); await f.history.archive(f.request());
    const stream = new SqliteScenarioAgentEventStream(f.sqlite), audit = new AgentAuditProjection(f.sqlite, stream);
    expect(audit.controls()).toBeGreaterThan(0);
    expect(stream.list("run").events.some(event => event.turnId === "control:run:4")).toBe(true);
  });
  it.each(["missing", "denied", "expired", "empty"])("requires independent archive authorization: %s", async mode => {
    const f = fixture(), control = new ScenarioHistoryControl(f.sqlite, mode === "missing" ? undefined : { async authorize() {
      return mode === "denied" ? { decision: "denied" } : { decision: "allowed", authorizationRef: mode === "empty" ? "" : "grant",
        expiresAt: mode === "expired" ? "2020-01-01T00:00:00.000Z" : "2099-01-01T00:00:00.000Z" };
    } });
    await expect(control.archive(f.request())).rejects.toThrow("authorization"); expect(f.history.inspect(scope).archivedThrough).toBe(0);
  });
  it("reauthorizes concurrent duplicate commands and rejects altered replay", async () => {
    const f = fixture(), input = f.request(); const results = await Promise.all([f.history.archive(input), f.history.archive(input)]);
    expect(results.filter(r => r.replayed)).toHaveLength(1); expect(f.history.inspect(scope).segments).toHaveLength(1);
    await expect(f.history.archive({ ...input, reason: "different" })).rejects.toThrow("conflict");
    await expect(new ScenarioHistoryControl(f.sqlite).archive(input)).rejects.toThrow("authorization");
  });
  it("rejects append races without changing either current state or old event bodies", async () => {
    const f = fixture(), input = f.request(); let release!: () => void;
    const control = new ScenarioHistoryControl(f.sqlite, { async authorize(value) { await new Promise<void>(r => { release = r; }); return grant.authorize(value); } });
    const pending = control.archive(input); await Promise.resolve(); f.command({ type: "resume_run", reason: "Changed", requestedBy: "operator", at }); release();
    await expect(pending).rejects.toThrow("revision"); expect(f.history.inspect(scope).archivedThrough).toBe(0); expect(f.runtime.load("run")!.status).toBe("running");
  });
  it("snapshots mutable request input and rejects changed source facts", async () => {
    const f = fixture(), input = f.request(); let release!: () => void;
    const control = new ScenarioHistoryControl(f.sqlite, { async authorize(value) { await new Promise<void>(r => { release = r; }); return grant.authorize(value); } });
    const pending = control.archive(input); await Promise.resolve(); input.reason = "mutated"; release();
    expect((await pending).audit.reason).toBe("Preserve long history");
    const g = fixture(), stale = g.request(); g.sqlite.prepare("UPDATE scenario_events SET created_at='changed' WHERE sequence=2").run();
    await expect(g.history.archive(stale)).rejects.toThrow("plan changed");
  });
  it("bounds waiting for an unresponsive archive authorizer", async () => {
    const f = fixture({ authorize: () => new Promise(() => {}) }), timeout = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => timeout(5));
    await expect(f.history.archive(f.request())).rejects.toThrow(); expect(spy).toHaveBeenCalledWith(10000);
  });
  it.each(["segment", "source", "audit"])("rolls back every archive component on %s write failure", async kind => {
    const f = fixture(), before = f.events.load("run"), table = kind === "segment" ? "scenario_history_segments" : kind === "source" ? "scenario_events" : "scenario_history_audits";
    f.sqlite.exec(`CREATE TEMP TRIGGER fail BEFORE ${kind === "source" ? "UPDATE" : "INSERT"} ON ${table} BEGIN SELECT RAISE(ABORT,'injected'); END`);
    await expect(f.history.archive(f.request())).rejects.toThrow("injected"); expect(f.events.load("run")).toEqual(before);
    expect(f.history.inspect(scope).segments).toHaveLength(0); expect(f.sqlite.prepare("SELECT bytes,records FROM scenario_history_usage").get()).toEqual({ bytes: 0, records: 0 });
  });
  it.each(["physical", "bytes", "records"])("refuses exhausted %s capacity without removing old facts", async mode => {
    const f = fixture(), input = f.request();
    if (mode === "physical") registerPhysicalStorageFunctions(f.sqlite, () => ({ databaseBytes: 0, walBytes: 0, shmBytes: 0, availableBytes: 0 }));
    else if (mode === "bytes") f.sqlite.prepare("UPDATE scenario_history_policy SET maximum_bytes=1").run();
    else { await f.history.archive(input); f.command({ type: "resume_run", reason: "Continue", requestedBy: "operator", at }); f.sqlite.prepare("UPDATE scenario_history_policy SET maximum_records=1").run(); }
    await expect(f.history.archive(mode === "records" ? f.request() : input)).rejects.toThrow();
    expect(f.events.load("run").events[0]!.type).toBe("run_started");
  });
  it.each(["payload", "snapshot", "missing", "marker", "origin", "sequence"])("fails closed on corrupt or missing %s", async mode => {
    const f = fixture(); await f.history.archive(f.request());
    if (mode === "payload" || mode === "snapshot") { f.sqlite.exec("DROP TRIGGER scenario_history_segments_UPDATE");
      if (mode === "payload") f.sqlite.prepare("UPDATE scenario_history_segments SET payload=?").run(Buffer.from("bad archive"));
      else f.sqlite.prepare("UPDATE scenario_history_segments SET snapshot_json='{}'").run(); }
    if (mode === "missing") f.sqlite.exec("DROP TRIGGER scenario_history_segments_DELETE; DELETE FROM scenario_history_segments");
    if (mode === "marker" || mode === "origin") { f.sqlite.exec("DROP TRIGGER scenario_history_event_update"); f.sqlite.prepare("UPDATE scenario_events SET payload_json='{}' WHERE sequence=?").run(mode === "origin" ? 1 : 2); }
    if (mode === "sequence") f.sqlite.exec("DROP TRIGGER scenario_history_event_delete; DELETE FROM scenario_events WHERE sequence=2");
    expect(() => f.runtime.load("run")).toThrow();
    expect(() => f.command({ type: "resume_run", reason: "No", requestedBy: "operator", at })).toThrow(); expect(f.events.revision("run")).toBe(4);
  });
  it("protects archived identities, commands, snapshots and audits from updates and deletion", async () => {
    const f = fixture(); await f.history.archive(f.request());
    for (const sql of ["UPDATE scenario_events SET event_type='other' WHERE sequence=2", "DELETE FROM scenario_events WHERE sequence=2", "DELETE FROM scenario_commands WHERE command_id='propose'",
      "UPDATE scenario_history_segments SET digest='other'", "DELETE FROM scenario_history_audits", "DELETE FROM scenario_lease_history"])
      expect(() => f.sqlite.exec(sql)).toThrow();
  });
  it("rejects a missing archived lease index rather than forgetting old ownership", async () => {
    const f = fixture(); await f.history.archive(f.request());
    f.sqlite.exec("DROP TRIGGER scenario_lease_history_DELETE; DELETE FROM scenario_lease_history");
    expect(() => f.runtime.load("run")).toThrow("lease identity index");
  });
  it("still validates the current Run projection when the full prefix is snapshotted", async () => {
    const f = fixture(); await f.history.archive(f.request());
    f.sqlite.prepare("UPDATE scenario_event_streams SET scenario_package_version='other' WHERE run_id='run'").run();
    expect(() => f.events.loadState("run")).toThrow("projection integrity");
  });
  it("enforces scope and bounded range/page requests", async () => {
    const f = fixture(); expect(() => f.history.inspect({ ...scope, caseId: "other" })).toThrow("scope");
    expect(() => f.history.preview({ ...scope, expectedRevision: 4, throughRevision: 5 })).toThrow("revision");
    expect(() => f.events.page("run", 0, 1001)).toThrow("bounds");
    await f.history.archive(f.request()); expect(() => f.history.preview({ ...scope, expectedRevision: 4, throughRevision: 4 })).toThrow("contiguous");
  });
  it("exposes protected production archive and cold forensics, then reopens without the package", async () => {
    const host = await foundationHost({ ready: () => false, foundation: { historyArchiveAuthorizer: grant } }); hosts.push(host); await host.start();
    expect((await host.app.inject({ url: "/api/scenarios/runs/run/history?caseId=case" })).statusCode).toBe(401);
    const input = { ...scope, expectedRevision: 2, throughRevision: 2 };
    const preview = await host.request("/api/scenarios/runs/run/history/preview", input);
    await host.request("/api/scenarios/runs/run/history/archive", { ...input, commandId: "archive", actor: "operator", reason: "Preserve", planFingerprint: preview.planFingerprint });
    expect((await host.request("/api/scenarios/runs/run/disposal/events?caseId=case")).events[1].type).toBe("work_proposed");
    await host.close(false);
    const reopened = await foundationHost({ root: host.root, empty: true, ready: () => false }); hosts.push(reopened);
    expect((await reopened.request("/api/scenarios/runs/run/disposal?caseId=case")).run.revision).toBe(2);
    expect((await reopened.request("/api/scenarios/runs/run/history/audit?caseId=case&commandId=archive")).throughRevision).toBe(2); expect(reopened.calls()).toBe(0);
  });
  it.each(["segment", "source", "audit", "committed"])("recovers two fresh hosts after SIGKILL at %s", async phase => {
    const path = root();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../test-fixtures/scenario-history-crash-host.mjs", import.meta.url)), path, phase], { stdio: ["ignore", "ignore", "pipe"] });
      let errors = ""; child.stderr.on("data", chunk => { errors += chunk; });
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Crash deadline")); }, 15000);
      child.on("error", reject); child.on("exit", (_code, signal) => { clearTimeout(timer); signal === "SIGKILL" ? resolve() : reject(new Error(errors)); });
    });
    for (let pass = 0; pass < 2; pass++) {
      const sqlite = database(join(path, "state.db")); dbs.push(sqlite);
      const events = new SqliteScenarioEventStore(sqlite), history = new ScenarioHistoryControl(sqlite, grant);
      expect(events.loadState("run")!.status).toBe("paused"); expect(events.load("run").events).toHaveLength(4); expect(events.hasUsedLease("run", "lease")).toBe(true);
      expect(history.inspect(scope).archivedThrough).toBe(phase === "committed" ? 4 : 0);
      expect(sqlite.prepare("SELECT count(*) n FROM scenario_history_audits").get()).toEqual({ n: phase === "committed" ? 1 : 0 }); sqlite.close();
    }
  });
});
