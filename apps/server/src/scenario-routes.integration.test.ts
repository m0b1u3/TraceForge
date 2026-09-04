import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import {
  DurableScenarioRuntime,
  ScenarioDefinitionRegistry,
} from "@traceforge/orchestration-core";
import { WEB_BLACKBOX_CAPABILITIES, WEB_BLACKBOX_SCENARIO } from "./test-fixtures/web-blackbox-descriptor.js";
import { createDb, getSqliteClient } from "./db/client.js";
import { SqliteScenarioEventStore, SqliteWorkerRegistry } from "./scenario-event-store.js";
import { SqliteEvidenceGraphStore } from "./evidence-graph-store.js";
import { ScenarioEvidenceGraphAdapter } from "./scenario-evidence-store.js";
import { registerScenarioRunRecoveryRoutes, ScenarioRunRecoveryService } from "./scenario-run-recovery.js";
import { registerScenarioRoutes } from "./scenario-routes.js";
import { ScenarioPackageRegistry } from "@traceforge/scenario-sdk";
import { webBlackboxControlPlanePackage } from "./test-fixtures/web-blackbox-control-plane-package.js";

const databases: Database.Database[] = [];
const recoveries = new WeakMap<object, ScenarioRunRecoveryService>();

async function setup(autoScheduleIntervalMs?: number) {
  const webPackage = webBlackboxControlPlanePackage();
  const app = Fastify();
  const db = createDb(":memory:");
  const sqlite = getSqliteClient(db);
  databases.push(sqlite);
  sqlite.prepare("INSERT INTO cases (id, name, status, scope_rules_json, created_at) VALUES (?, ?, ?, ?, ?)")
    .run("case_1", "Authorized assessment", "active", "{}", "2026-08-24T08:00:00.000Z");
  const ids = ["lease_1", "lease_2"];
  registerScenarioRoutes(app, sqlite, {
    definitions: new ScenarioDefinitionRegistry([WEB_BLACKBOX_SCENARIO]),
    packages: new ScenarioPackageRegistry([webPackage]),
    evidence: new ScenarioEvidenceGraphAdapter(new SqliteEvidenceGraphStore(sqlite)),
    now: () => "2026-08-24T08:00:10.000Z",
    createId: () => ids.shift()!,
    controlPlane: { leaseDurationMs: 60_000, heartbeatTimeoutMs: 30_000, concurrencyRetries: 3 },
    autoScheduleIntervalMs,
  });
  const events = new SqliteScenarioEventStore(sqlite);
  const runtime = new DurableScenarioRuntime(events, new ScenarioDefinitionRegistry([WEB_BLACKBOX_SCENARIO]));
  const recovery = new ScenarioRunRecoveryService(runtime, events, new SqliteWorkerRegistry(sqlite));
  recoveries.set(app, recovery);
  registerScenarioRunRecoveryRoutes(app, recovery);
  await app.ready();
  return app;
}

async function authorize(app: Awaited<ReturnType<typeof setup>>) {
  return app.inject({
    method: "POST",
    url: "/api/scenarios/authorizations",
    payload: {
      id: "scope_1",
      caseId: "case_1",
      scenarioKind: "web_blackbox",
      scope: {
        targets: ["https://authorized.example"],
        allowedActions: [
          "scope.read",
          "evidence.write",
          "web.browser.navigate",
          "web.traffic.read",
          "web.request.replay",
          "report.write",
        ],
        deniedActions: ["artifact.analyze"],
      },
      approvedBy: "operator_1",
      expiresAt: "2026-08-24T09:00:00.000Z",
    },
  });
}

afterEach(() => {
  while (databases.length) databases.pop()!.close();
});

describe("scenario control-plane routes", () => {
  it("starts with an empty definition catalog when no scenario is installed", async () => {
    const app = Fastify();
    const db = createDb(":memory:");
    const sqlite = getSqliteClient(db);
    databases.push(sqlite);
    registerScenarioRoutes(app, sqlite);
    await app.ready();
    const response = await app.inject({ method: "GET", url: "/api/scenarios/definitions" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
    await app.close();
  });

  it("exposes registered Scenario Profiles and their authorization contract", async () => {
    const app = await setup();
    const response = await app.inject({ method: "GET", url: "/api/scenarios/definitions" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([expect.objectContaining({
      kind: "web_blackbox",
      version: 1,
      authorizationActions: expect.arrayContaining(["scope.read", "web.request.replay", "report.write"]),
      agentTopology: expect.objectContaining({ planner: expect.objectContaining({ enabled: true }) }),
    })]);
  });

  it("keeps an unavailable Package binding diagnosable without silently using the installed version", async () => {
    const app = await setup();
    expect((await authorize(app)).statusCode).toBe(201);
    const started = await app.inject({
      method: "POST",
      url: "/api/scenarios/runs",
      payload: {
        commandId: "command_start_unavailable",
        runId: "run_unavailable",
        caseId: "case_1",
        goal: "Preserve exact Package ownership",
        scopeRef: "scope_1",
        scenarioKind: "web_blackbox",
        definitionVersion: 1,
      },
    });
    expect(started.statusCode).toBe(201);

    const sqlite = databases.at(-1)!;
    const row = sqlite.prepare("SELECT payload_json FROM scenario_events WHERE run_id = ? AND sequence = 1")
      .get("run_unavailable") as { payload_json: string };
    const event = JSON.parse(row.payload_json) as { state: { scenarioPackage: { version: string } } };
    event.state.scenarioPackage.version = "0.0.9";
    sqlite.prepare("UPDATE scenario_events SET payload_json = ? WHERE run_id = ? AND sequence = 1")
      .run(JSON.stringify(event), "run_unavailable");
    sqlite.prepare("UPDATE scenario_event_streams SET scenario_package_version = ? WHERE run_id = ?")
      .run("0.0.9", "run_unavailable");

    const bindingList = await app.inject({ method: "GET", url: "/api/scenarios/runs?caseId=case_1" });
    expect(bindingList.json()[0]).toMatchObject({
      runId: "run_unavailable",
      packageAvailability: "recovery_required",
      packageDiagnostic: expect.stringContaining("required by Run is not installed"),
    });
    const loaded = await app.inject({ method: "GET", url: "/api/scenarios/runs/run_unavailable" });
    expect(loaded.statusCode).toBe(409);
    expect(loaded.json()).toMatchObject({ recoveryRequired: true });
    expect(loaded.json().error).toContain("traceforge.web-blackbox@0.0.9");
    const revoked = await app.inject({
      method: "POST", url: "/api/scenarios/authorizations/scope_1/revoke",
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().cancelledRunIds).toEqual([]);
  });

  it("runs the worker dispatch, checkpoint, completion, and phase transition protocol", async () => {
    const app = await setup();
    expect((await authorize(app)).statusCode).toBe(201);
    const registered = await app.inject({
      method: "POST",
      url: "/api/scenarios/workers",
      payload: {
        id: "worker_1",
        roles: ["researcher", "reviewer", "validator", "reporter"],
        capabilities: Object.values(WEB_BLACKBOX_CAPABILITIES),
        maxConcurrentWork: 2,
        status: "online",
      },
    });
    expect(registered.statusCode).toBe(201);

    const startPayload = {
      commandId: "command_start",
      runId: "run_1",
      caseId: "case_1",
      goal: "Assess the authorized web application",
      scopeRef: "scope_1",
      scenarioKind: "web_blackbox",
      definitionVersion: 1,
    };
    const started = await app.inject({ method: "POST", url: "/api/scenarios/runs", payload: startPayload });
    expect(started.statusCode).toBe(201);
    expect(started.json().state.revision).toBe(1);
    expect(started.json().state.scenarioPackage).toEqual({
      id: "traceforge.web-blackbox", version: "0.3.0", schemaRevision: 1,
    });
    const replayed = await app.inject({ method: "POST", url: "/api/scenarios/runs", payload: startPayload });
    expect(replayed.statusCode).toBe(200);
    expect(replayed.json().idempotentReplay).toBe(true);

    const bindingList = await app.inject({ method: "GET", url: "/api/scenarios/runs?caseId=case_1" });
    expect(bindingList.json()[0]).toMatchObject({
      scenarioPackage: { id: "traceforge.web-blackbox", version: "0.3.0", schemaRevision: 1 },
      packageAvailability: "available",
      packageDiagnostic: null,
    });

    const proposed = await app.inject({
      method: "POST",
      url: "/api/scenarios/runs/run_1/work",
      payload: {
        commandId: "command_propose",
        expectedRevision: 1,
        proposal: {
          id: "work_scope",
          kind: "research",
          title: "Bind authorized scope",
          objective: "Record the scope and available execution inventory",
          idempotencyKey: "effect_scope",
        },
      },
    });
    expect(proposed.statusCode).toBe(200);
    expect(proposed.json().state.revision).toBe(2);

    const ticked = await app.inject({ method: "POST", url: "/api/scenarios/runs/run_1/tick" });
    expect(ticked.statusCode).toBe(200);
    expect(ticked.json().assignments).toEqual([{
      workId: "work_scope",
      workerId: "worker_1",
      leaseId: "lease_1",
      leaseExpiresAt: "2026-08-24T08:01:10.000Z",
    }]);
    const assignments = await app.inject({ method: "GET", url: "/api/scenarios/workers/worker_1/assignments" });
    expect(assignments.statusCode).toBe(200);
    expect(assignments.json()).toMatchObject([{
      runId: "run_1",
      leaseId: "lease_1",
      runRevision: 3,
      work: { id: "work_scope", status: "running" },
    }]);

    const rejectedOwner = await app.inject({
      method: "POST",
      url: "/api/scenarios/runs/run_1/work/work_scope/checkpoint",
      payload: {
        commandId: "command_wrong_owner",
        expectedRevision: 3,
        workerId: "worker_2",
        leaseId: "lease_1",
        checkpointId: "checkpoint_wrong",
        progressSummary: "Untrusted update",
        payloadRef: "artifact://wrong",
      },
    });
    expect(rejectedOwner.statusCode).toBe(409);

    const checkpointed = await app.inject({
      method: "POST",
      url: "/api/scenarios/runs/run_1/work/work_scope/checkpoint",
      payload: {
        commandId: "command_checkpoint",
        expectedRevision: 3,
        workerId: "worker_1",
        leaseId: "lease_1",
        checkpointId: "checkpoint_1",
        progressSummary: "Scope captured",
        payloadRef: "artifact://checkpoint_1",
      },
    });
    expect(checkpointed.statusCode).toBe(200);
    expect(checkpointed.json().state.workItems[0].latestCheckpoint.id).toBe("checkpoint_1");

    const approvalRequested = await app.inject({
      method: "POST",
      url: "/api/scenarios/runs/run_1/work/work_scope/request-approval",
      payload: {
        commandId: "command_request_approval",
        expectedRevision: 4,
        workerId: "worker_1",
        leaseId: "lease_1",
        approvalId: "approval_1",
        actionKey: "effect_scope:call_1",
        toolName: "bounded.tool",
        risk: "privileged",
        rationale: "Validate an operator-approved action",
        inputRef: "artifact://checkpoint_1",
      },
    });
    expect(approvalRequested.statusCode).toBe(200);
    expect(approvalRequested.json().state.workItems[0]).toMatchObject({ status: "waiting_approval", leaseId: null });
    const pendingApprovals = await app.inject({ method: "GET", url: "/api/scenarios/approvals?status=pending&caseId=case_1" });
    expect(pendingApprovals.json()).toMatchObject([{ id: "approval_1", workId: "work_scope", status: "pending" }]);
    const approved = await app.inject({
      method: "POST",
      url: "/api/scenarios/approvals/approval_1/resolve",
      payload: { commandId: "command_resolve_approval", expectedRevision: 5, approved: true, reason: "Operator approved bounded execution" },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().state.workItems[0]).toMatchObject({ status: "queued", grantedActionKeys: ["effect_scope:call_1"] });
    const reassigned = await app.inject({ method: "POST", url: "/api/scenarios/runs/run_1/tick" });
    expect(reassigned.json().assignments[0]).toMatchObject({ workId: "work_scope", leaseId: "lease_2" });

    const completed = await app.inject({
      method: "POST",
      url: "/api/scenarios/runs/run_1/work/work_scope/complete",
      payload: {
        commandId: "command_complete",
        expectedRevision: 7,
        workerId: "worker_1",
        leaseId: "lease_2",
        summary: "Scope and inventory persisted",
        outputs: [
          { id: "output_scope", kind: "scope_snapshot", summary: "Authorized scope", refs: ["scope_1"] },
          { id: "output_inventory", kind: "capability_inventory", summary: "Worker inventory", refs: ["worker_1"] },
        ],
      },
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().state.revision).toBe(8);
    expect(completed.json().state.outputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "output_scope", schemaVersion: 1 }),
      expect.objectContaining({ id: "output_inventory", schemaVersion: 1 }),
    ]));
    expect(completed.json().evidenceRefs).toEqual(expect.arrayContaining([
      "knowledge-node:output_scope",
      "knowledge-node:output_inventory",
    ]));
    expect(databases.at(-1)!.prepare(`
      SELECT id, kind, run_id FROM evidence_graph_nodes WHERE run_id = 'run_1' ORDER BY id
    `).all()).toEqual([
      { id: "output_inventory", kind: "fact", run_id: "run_1" },
      { id: "output_scope", kind: "fact", run_id: "run_1" },
    ]);

    const advanced = await app.inject({
      method: "POST",
      url: "/api/scenarios/runs/run_1/advance",
      payload: { commandId: "command_advance", expectedRevision: 8, to: "surface_mapping" },
    });
    expect(advanced.statusCode).toBe(200);
    expect(advanced.json().state.activePhaseId).toBe("surface_mapping");

    const listed = await app.inject({ method: "GET", url: "/api/scenarios/runs?caseId=case_1" });
    expect(listed.json()).toMatchObject([{
      runId: "run_1",
      caseId: "case_1",
      status: "running",
      activePhaseId: "surface_mapping",
      revision: 9,
    }]);
    const revoked = await app.inject({ method: "POST", url: "/api/scenarios/authorizations/scope_1/revoke" });
    expect(revoked.json().cancelledRunIds).toEqual(["run_1"]);
    const cancelled = await app.inject({ method: "GET", url: "/api/scenarios/runs/run_1" });
    expect(cancelled.json()).toMatchObject({ status: "cancelled", blockedReason: "Scope authorization scope_1 is no longer active" });
    const noAssignments = await app.inject({ method: "GET", url: "/api/scenarios/workers/worker_1/assignments" });
    expect(noAssignments.json()).toEqual([]);
    await app.close();
  });

  it("persists pause and resume boundaries with checkpoint recovery and deterministic replay", async () => {
    const app = await setup();
    expect((await authorize(app)).statusCode).toBe(201);
    expect((await app.inject({
      method: "POST", url: "/api/scenarios/workers",
      payload: {
        id: "worker_1", roles: ["researcher"], capabilities: Object.values(WEB_BLACKBOX_CAPABILITIES),
        maxConcurrentWork: 1, status: "online",
      },
    })).statusCode).toBe(201);
    expect((await app.inject({
      method: "POST", url: "/api/scenarios/runs",
      payload: {
        commandId: "start_pause", runId: "run_pause", caseId: "case_1", goal: "Assess authorized scope",
        scopeRef: "scope_1", scenarioKind: "web_blackbox", definitionVersion: 1,
      },
    })).statusCode).toBe(201);
    expect((await app.inject({
      method: "POST", url: "/api/scenarios/runs/run_pause/work",
      payload: {
        commandId: "propose_pause", expectedRevision: 1,
        proposal: { id: "work_pause", kind: "research", title: "Collect", objective: "Collect evidence", idempotencyKey: "effect_pause" },
      },
    })).statusCode).toBe(200);
    const assigned = await app.inject({ method: "POST", url: "/api/scenarios/runs/run_pause/tick" });
    expect(assigned.json().assignments[0].leaseId).toBe("lease_1");
    expect((await app.inject({
      method: "POST", url: "/api/scenarios/runs/run_pause/work/work_pause/checkpoint",
      payload: {
        commandId: "checkpoint_pause", expectedRevision: 3, workerId: "worker_1", leaseId: "lease_1",
        checkpointId: "checkpoint_pause", progressSummary: "Durable progress", payloadRef: "artifact://checkpoint_pause",
      },
    })).statusCode).toBe(200);

    const paused = await app.inject({
      method: "POST", url: "/api/scenarios/runs/run_pause/pause",
      payload: { commandId: "pause_1", expectedRevision: 4, reason: "Operator maintenance" },
    });
    expect(paused.statusCode).toBe(200);
    expect(paused.json().state).toMatchObject({
      status: "paused", suspension: { reason: "Operator maintenance", requestedBy: "operator" },
      workItems: [{ status: "queued", attempt: 1, resumeFromCheckpoint: true, leaseId: null }],
    });
    const diagnostic = await app.inject({ method: "GET", url: "/api/scenarios/runs/run_pause/recovery" });
    expect(diagnostic.statusCode).toBe(200);
    expect(diagnostic.json()).toMatchObject({
      status: "paused", runRevision: 5, projectionMatchesReplay: true,
      activeLeases: [], queuedCheckpointWorkIds: ["work_pause"], pendingApprovalIds: [],
    });
    const firstReplay = await app.inject({ method: "GET", url: "/api/scenarios/runs/run_pause/replay?revision=5" });
    const secondReplay = await app.inject({ method: "GET", url: "/api/scenarios/runs/run_pause/replay?revision=5" });
    expect(firstReplay.statusCode).toBe(200);
    expect(firstReplay.json().stateDigest).toBe(secondReplay.json().stateDigest);
    expect(firstReplay.json()).toMatchObject({ revision: 5, currentRevision: 5, eventCount: 5, isCurrent: true });

    const resumed = await app.inject({
      method: "POST", url: "/api/scenarios/runs/run_pause/resume",
      payload: { commandId: "resume_1", expectedRevision: 5, reason: "Maintenance complete" },
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().state).toMatchObject({ status: "running", suspension: null });
    const reassigned = await app.inject({ method: "POST", url: "/api/scenarios/runs/run_pause/tick" });
    expect(reassigned.json().assignments).toEqual([expect.objectContaining({ workId: "work_pause", leaseId: "lease_2" })]);
    const state = (await app.inject({ method: "GET", url: "/api/scenarios/runs/run_pause" })).json();
    expect(state.workItems[0]).toMatchObject({ status: "running", attempt: 1, resumeFromCheckpoint: false, leaseId: "lease_2" });
    const historical = await app.inject({ method: "GET", url: "/api/scenarios/runs/run_pause/replay?revision=5" });
    expect(historical.json()).toMatchObject({ revision: 5, currentRevision: 7, isCurrent: false, state: { status: "paused" } });
  });

  it("reclaims an expired startup lease and preserves resumable checkpoint state", async () => {
    const app = await setup();
    expect((await authorize(app)).statusCode).toBe(201);
    await app.inject({
      method: "POST", url: "/api/scenarios/workers",
      payload: {
        id: "worker_1", roles: ["researcher"], capabilities: Object.values(WEB_BLACKBOX_CAPABILITIES),
        maxConcurrentWork: 1, status: "online",
      },
    });
    await app.inject({
      method: "POST", url: "/api/scenarios/runs",
      payload: {
        commandId: "start_recovery", runId: "run_recovery", caseId: "case_1", goal: "Assess authorized scope",
        scopeRef: "scope_1", scenarioKind: "web_blackbox", definitionVersion: 1,
      },
    });
    await app.inject({
      method: "POST", url: "/api/scenarios/runs/run_recovery/work",
      payload: {
        commandId: "propose_recovery", expectedRevision: 1,
        proposal: { id: "work_recovery", kind: "research", title: "Collect", objective: "Collect evidence", idempotencyKey: "effect_recovery" },
      },
    });
    await app.inject({ method: "POST", url: "/api/scenarios/runs/run_recovery/tick" });
    await app.inject({
      method: "POST", url: "/api/scenarios/runs/run_recovery/work/work_recovery/checkpoint",
      payload: {
        commandId: "checkpoint_recovery", expectedRevision: 3, workerId: "worker_1", leaseId: "lease_1",
        checkpointId: "checkpoint_recovery", progressSummary: "Durable progress", payloadRef: "artifact://checkpoint_recovery",
      },
    });

    const report = recoveries.get(app)!.recoverAll("2026-08-24T08:02:00.000Z");
    expect(report.actions).toEqual([expect.objectContaining({
      runId: "run_recovery", workId: "work_recovery", leaseId: "lease_1", action: "requeued",
      checkpointRef: "artifact://checkpoint_recovery",
    })]);
    const recovered = (await app.inject({ method: "GET", url: "/api/scenarios/runs/run_recovery" })).json();
    expect(recovered.workItems[0]).toMatchObject({
      status: "queued", attempt: 1, resumeFromCheckpoint: true, leaseId: null,
      latestCheckpoint: { id: "checkpoint_recovery" },
    });
    const diagnostic = (await app.inject({ method: "GET", url: "/api/scenarios/runs/run_recovery/recovery" })).json();
    expect(diagnostic).toMatchObject({ projectionMatchesReplay: true, queuedCheckpointWorkIds: ["work_recovery"], activeLeases: [] });
  });

  it("rejects unknown cases and stale revisions", async () => {
    const app = await setup();
    const unknown = await app.inject({
      method: "POST",
      url: "/api/scenarios/runs",
      payload: {
        commandId: "unknown_start", runId: "unknown_run", caseId: "missing", goal: "Assess scope",
        scopeRef: "scope_1", scenarioKind: "web_blackbox", definitionVersion: 1,
      },
    });
    expect(unknown.statusCode).toBe(404);

    await app.inject({
      method: "POST", url: "/api/scenarios/workers",
      payload: { id: "worker_1", roles: ["researcher"], capabilities: Object.values(WEB_BLACKBOX_CAPABILITIES), maxConcurrentWork: 1 },
    });
    expect((await authorize(app)).statusCode).toBe(201);
    await app.inject({
      method: "POST", url: "/api/scenarios/runs",
      payload: {
        commandId: "command_start", runId: "run_1", caseId: "case_1", goal: "Assess scope",
        scopeRef: "scope_1", scenarioKind: "web_blackbox", definitionVersion: 1,
      },
    });
    const stale = await app.inject({
      method: "POST", url: "/api/scenarios/runs/run_1/work",
      payload: {
        commandId: "stale", expectedRevision: 0,
        proposal: { id: "work_1", kind: "research", title: "Work", objective: "Collect facts", idempotencyKey: "effect_1" },
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ expectedRevision: 0, actualRevision: 1 });
    await app.close();
  });

  it("blocks a run when its scope authorization has been revoked", async () => {
    const app = await setup();
    await authorize(app);
    const revoked = await app.inject({ method: "POST", url: "/api/scenarios/authorizations/scope_1/revoke" });
    expect(revoked.statusCode).toBe(200);
    const started = await app.inject({
      method: "POST",
      url: "/api/scenarios/runs",
      payload: {
        commandId: "command_start", runId: "run_1", caseId: "case_1", goal: "Assess scope",
        scopeRef: "scope_1", scenarioKind: "web_blackbox", definitionVersion: 1,
      },
    });
    expect(started.statusCode).toBe(403);
    await app.close();
  });

  it("dispatches queued work through the background scheduler", async () => {
    const app = await setup(100);
    await authorize(app);
    await app.inject({
      method: "POST", url: "/api/scenarios/workers",
      payload: { id: "worker_1", roles: ["researcher"], capabilities: Object.values(WEB_BLACKBOX_CAPABILITIES), maxConcurrentWork: 1 },
    });
    await app.inject({
      method: "POST", url: "/api/scenarios/runs",
      payload: {
        commandId: "command_start", runId: "run_1", caseId: "case_1", goal: "Assess scope",
        scopeRef: "scope_1", scenarioKind: "web_blackbox", definitionVersion: 1,
      },
    });
    await app.inject({
      method: "POST", url: "/api/scenarios/runs/run_1/work",
      payload: {
        commandId: "command_propose", expectedRevision: 1,
        proposal: { id: "work_1", kind: "research", title: "Work", objective: "Collect facts", idempotencyKey: "effect_1" },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 180));
    const assignments = await app.inject({ method: "GET", url: "/api/scenarios/workers/worker_1/assignments" });
    expect(assignments.json()).toMatchObject([{ leaseId: "lease_1", work: { id: "work_1", status: "running" } }]);
    const revoked = await app.inject({ method: "POST", url: "/api/scenarios/authorizations/scope_1/revoke" });
    expect(revoked.json().cancelledRunIds).toEqual(["run_1"]);
    const released = await app.inject({ method: "GET", url: "/api/scenarios/workers/worker_1/assignments" });
    expect(released.json()).toEqual([]);
    await app.close();
  });
});
