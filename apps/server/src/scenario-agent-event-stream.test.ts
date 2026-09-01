import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDb, getSqliteClient } from "./db/client.js";
import { registerScenarioAgentEventRoutes, SqliteScenarioAgentEventStream } from "./scenario-agent-event-stream.js";
import { SqliteCognitiveSnapshotStore } from "./cognitive-context-snapshots.js";
import { SqliteModelExecutionStore } from "./model-execution-runtime.js";
import { DEFAULT_MODEL_RESOURCE_POLICY, ModelAdmissionController, SqliteModelAdmissionStore } from "./model-admission-controller.js";
import type { ScenarioAgentEventDraft } from "@traceforge/shared";

const databases: Database.Database[] = [];
const at = "2026-08-25T12:00:00.000Z";

afterEach(() => {
  while (databases.length) databases.pop()!.close();
});

function fixture() {
  const sqlite = getSqliteClient(createDb(":memory:")); databases.push(sqlite);
  let id = 0;
  const stream = new SqliteScenarioAgentEventStream(sqlite,undefined,() => `event_${++id}`,() => at);
  const draft: ScenarioAgentEventDraft = {runId:"run",caseId:"case",workId:null,turnId:"turn",role:"system",createdAt:at,
    method:"turn/completed",params:{status:"completed",outcome:null,checkpointRef:null,error:null}};
  return {sqlite,stream,draft};
}

describe("Agent audit replay integrity", () => {
  it("never completes a live Worker Turn just because its model snapshot completed", () => {
    const {sqlite,stream}=fixture();const snapshots=new SqliteCognitiveSnapshotStore(sqlite);
    snapshots.prepare({id:"live",consumer:"worker",caseId:"case",runId:"run",workId:"work",sourceRunRevision:1,
      request:{system:"system",user:"state",schema:{}},contextManifest:{},at});
    snapshots.complete("live",{type:"invoke_tool"},at,{deferTurnCompletion:true});
    expect(stream.reconcileFromProjections(0)).toBe(0);
    expect(stream.list("run").events).toEqual([]);
    // A subsequent host explicitly takes over the old snapshot; it records interruption, not success.
    expect(stream.reconcileFromProjections()).toBe(2);
    expect(stream.list("run").events.at(-1)?.params).toMatchObject({status:"interrupted",outcome:null});
  });
  it("keeps queued cancellation and permit release independent of an exhausted audit sink", async () => {
    const {sqlite,stream}=fixture();let failures=0;
    const admission=new ModelAdmissionController({...DEFAULT_MODEL_RESOURCE_POLICY,maximumConcurrentCalls:1},new SqliteModelAdmissionStore(sqlite),
      undefined,undefined,undefined,stream.bestEffortWriter(()=>{failures++;}));
    const context={role:"worker" as const,snapshotId:"first",runId:"run",caseId:"case",workId:"work"};
    const permit=await admission.acquire(context);
    const queued=admission.acquire({...context,snapshotId:"second"}).then(()=>"admitted",()=>"cancelled");
    sqlite.prepare("UPDATE scenario_agent_event_policy SET maximum_records=1").run();
    admission.cancelRun("run"); expect(await queued).toBe("cancelled");
    expect(()=>permit.release("cancelled","Operator stopped")).not.toThrow(); expect(failures).toBeGreaterThan(0);
    sqlite.prepare("UPDATE scenario_agent_event_policy SET maximum_records=200000").run();
    expect(stream.reconcileFromProjections()).toBe(2);
    expect(stream.list("run").events.filter((event)=>event.method==="item/completed")).toHaveLength(2);
    admission.shutdown();
  });
  it("recovers cancellation from structured model metadata rather than guessing from error text", () => {
    const {sqlite,stream} = fixture(); const calls=new SqliteModelExecutionStore(sqlite);
    calls.reserve({id:"call",context:{role:"worker",snapshotId:"snapshot",runId:"run",caseId:"case",workId:"work"},routeId:"primary",routeAttempt:1,reservedTokens:1,maximumRunTokens:100,at});
    calls.finish("call","failed",{promptTokens:0,completionTokens:0,totalTokens:0},"operator ended wait",at,"cancelled");
    stream.reconcileFromProjections();
    expect(stream.list("run").events[0]?.params).toMatchObject({item:{type:"modelCall",status:"cancelled"}});
    expect(stream.reconcileFromProjections()).toBe(0);
  });

  it("finishes a recovered approval Turn even if its terminal Item was already committed", () => {
    const {sqlite,stream} = fixture();
    sqlite.prepare(`INSERT INTO scenario_work_approvals
      (id,run_id,case_id,work_id,action_key,tool_name,risk,rationale,input_ref,status,requested_by_worker_id,created_at,resolved_at)
      VALUES ('approval','run','case','work','action','observe','read_only','Observe','input','cancelled','worker',?,?)`).run(at,at);
    stream.append({runId:"run",caseId:"case",workId:"work",turnId:"approval:approval",role:"system",createdAt:at,
      method:"item/completed",params:{item:{type:"approval",id:"approval",tool:"observe",status:"cancelled",risk:"read_only",reason:null}}});
    expect(stream.reconcileFromProjections()).toBe(3);
    expect(stream.list("run").events.at(-1)?.params).toMatchObject({status:"cancelled"});
    expect(stream.reconcileFromProjections()).toBe(0);
  });
  it("binds reconnect cursors to Case, Run and the actual last event", () => {
    const {stream,draft} = fixture(); stream.append(draft);
    const first = stream.replay("case","run"); stream.append(draft);
    expect(stream.replay("case","run",first.nextCursor).events.map((e) => e.sequence)).toEqual([2]);
    expect(() => stream.replay("case","other",first.nextCursor)).toThrow("different Case/Run");
    expect(() => stream.replay("other","run",first.nextCursor)).toThrow("different Case/Run");
    const tampered = JSON.parse(Buffer.from(first.nextCursor,"base64url").toString()); tampered.eventId="replacement";
    expect(() => stream.replay("case","run",Buffer.from(JSON.stringify(tampered)).toString("base64url"))).toThrow("same durable event");
  });
  it.each(["gap","tail","version","attribution"])("fails closed for durable %s corruption", (mode) => {
    const {sqlite,stream,draft} = fixture(); for (let n=0;n<3;n++) stream.append(draft);
    // Simulated disk/old-writer corruption, not an allowed production API.
    sqlite.exec("DROP TRIGGER agent_event_keep; DROP TRIGGER agent_event_immutable");
    if (mode==="gap" || mode==="tail") sqlite.prepare("DELETE FROM scenario_agent_protocol_events WHERE sequence=?").run(mode==="gap" ? 2 : 3);
    else sqlite.prepare("UPDATE scenario_agent_protocol_events SET event_json=json_set(event_json,?,?) WHERE sequence=2")
      .run(mode==="version" ? "$.protocolVersion" : "$.workId",mode==="version" ? 9 : "foreign");
    expect(() => stream.list("run")).toThrow();
  });
  it("rejects future cursors and invalid direct bounds", () => {
    const {stream,draft} = fixture(); stream.append(draft);
    expect(() => stream.list("run",2)).toThrow("ahead");
    expect(() => stream.list("run",-1)).toThrow("bounds");
    expect(() => stream.list("run",0,1001)).toThrow("bounds");
    expect(() => stream.replay("case","run","not-a-cursor")).toThrow("Malformed");
  });
  it("commits a fact batch and its key atomically, detects identity conflicts", () => {
    const {sqlite,stream,draft} = fixture();
    sqlite.prepare("UPDATE scenario_agent_event_policy SET maximum_records=1").run();
    expect(() => stream.appendFact("first",[draft,draft])).toThrow("capacity");
    expect(stream.list("run").events).toEqual([]);
    expect(sqlite.prepare("SELECT count(*) AS n FROM scenario_agent_fact_projections").get()).toEqual({n:0});
    sqlite.prepare("UPDATE scenario_agent_event_policy SET maximum_records=10").run();
    expect(stream.appendFact("first",[draft,draft])).toBe(true);
    expect(stream.appendFact("first",[draft,draft])).toBe(false);
    expect(() => stream.appendFact("first",[draft])).toThrow("identity changed");
    expect(stream.list("run").events).toHaveLength(2);
    expect(() => sqlite.exec("DELETE FROM scenario_agent_protocol_events")).toThrow("immutable");
    expect(() => sqlite.exec("DELETE FROM scenario_agent_fact_projections")).toThrow("permanent");
  });
  it("isolates listener failure and never publishes an outer transaction rollback", async () => {
    const {sqlite,draft} = fixture();
    const stream = new SqliteScenarioAgentEventStream(sqlite,() => { throw new Error("offline"); });
    const delivered: number[] = []; stream.subscribe(() => { throw new Error("closed socket"); });
    stream.subscribe((event) => delivered.push(event.sequence));
    expect(() => sqlite.transaction(() => {stream.append(draft);throw new Error("rollback");})()).toThrow("rollback");
    await Promise.resolve(); expect(delivered).toEqual([]);
    sqlite.transaction(() => {stream.append(draft); expect(delivered).toEqual([]);})();
    await Promise.resolve(); expect(delivered).toEqual([1]);
    expect(stream.list("run").events).toHaveLength(1);
  });
  it("fences Case and Turn ownership on append", () => {
    const {stream,draft} = fixture(); stream.append(draft);
    for (const change of [{caseId:"foreign"},{workId:"foreign"},{role:"worker" as const}]) expect(() => stream.append({...draft,...change})).toThrow();
    expect(stream.list("run").events).toHaveLength(1);
  });
  it("serves explicit error codes without executing writes during GET", async () => {
    const {sqlite,stream,draft} = fixture(); stream.append(draft);
    const app = Fastify(); registerScenarioAgentEventRoutes(app,stream);
    sqlite.pragma("query_only=ON");
    try {
      const page = await app.inject("/api/scenarios/runs/run/agent-event-replay?caseId=case");
      expect(page.statusCode).toBe(200); expect(page.json().replayOnly).toBe(true);
      const foreign = await app.inject(`/api/scenarios/runs/other/agent-event-replay?caseId=case&cursor=${page.json().nextCursor}`);
      expect(foreign.statusCode).toBe(409); expect(foreign.json().code).toBe("scope_mismatch");
      expect((await app.inject("/api/scenarios/runs/run/agent-events?after=3")).json().code).toBe("future_cursor");
      expect((await app.inject("/api/scenarios/runs/run/agent-events?limit=1001")).statusCode).toBe(400);
    } finally { await app.close(); }
  });
});

describe("scenario agent event stream", () => {
  it("assigns durable per-Run sequence numbers and replays from a cursor", async () => {
    const sqlite = getSqliteClient(createDb(":memory:"));
    databases.push(sqlite);
    const published: number[] = [];
    let id = 0;
    const stream = new SqliteScenarioAgentEventStream(sqlite, (event) => published.push(event.sequence), () => `event_${++id}`, () => at);
    const base = { runId: "run_1", caseId: "case_1", workId: null, turnId: "turn_1", role: "planner" as const, createdAt: at };
    stream.append({ ...base, method: "turn/started", params: { agentInstanceId: "planner:run_1", sourceRunRevision: 1, sourceGraphRevision: 0 } });
    stream.append({
      ...base, method: "item/started",
      params: { item: { type: "modelCall", id: "call_1", routeId: "primary", attempt: 1, status: "inProgress", reservedTokens: 10, usage: null, error: null } },
    });
    stream.append({ ...base, method: "turn/completed", params: { status: "completed", outcome: "finish", checkpointRef: null, error: null } });

    expect(stream.list("run_1", 0, 2)).toMatchObject({ nextCursor: 2, hasMore: true });
    const tail = stream.list("run_1", 2, 2);
    expect(tail.events.map((event) => [event.sequence, event.method])).toEqual([[3, "turn/completed"]]);
    expect(published).toEqual([1, 2, 3]);

    const reopened = new SqliteScenarioAgentEventStream(sqlite, undefined, () => `event_${++id}`, () => at);
    reopened.append({ ...base, method: "turn/completed", params: { status: "failed", outcome: null, checkpointRef: null, error: "retry failed" } });
    expect(reopened.list("run_1").events.at(-1)?.sequence).toBe(4);
  });

  it("exposes bounded cursor replay over HTTP", async () => {
    const sqlite = getSqliteClient(createDb(":memory:"));
    databases.push(sqlite);
    const stream = new SqliteScenarioAgentEventStream(sqlite, undefined, () => "event_1", () => at);
    stream.append({
      runId: "run_1", caseId: "case_1", workId: null, turnId: "turn_1", role: "observer",
      method: "turn/completed", params: { status: "completed", outcome: "finish", checkpointRef: null, error: null },
    });
    const app = Fastify();
    registerScenarioAgentEventRoutes(app, stream);
    const response = await app.inject({ method: "GET", url: "/api/scenarios/runs/run_1/agent-events?after=0&limit=10" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ nextCursor: 1, hasMore: false, events: [{ protocolVersion: 2, sequence: 1 }] });
    await app.close();
  });

  it("backfills terminal lifecycle events left between projection commit and publication", () => {
    const sqlite = getSqliteClient(createDb(":memory:"));
    databases.push(sqlite);
    const context = { role: "worker" as const, snapshotId: "turn_1", runId: "run_1", caseId: "case_1", workId: "work_1" };
    const snapshots = new SqliteCognitiveSnapshotStore(sqlite);
    snapshots.prepare({
      id: "turn_1", consumer: "worker", runId: "run_1", caseId: "case_1", workId: "work_1",
      sourceRunRevision: 3, request: { system: "system", user: "state", schema: {} }, contextManifest: {}, at,
    });
    snapshots.complete("turn_1", { type: "block", reason: "bounded" }, at);
    const calls = new SqliteModelExecutionStore(sqlite);
    calls.reserve({ id: "call_1", context, routeId: "primary", routeAttempt: 1, reservedTokens: 4, maximumRunTokens: 100, at });
    calls.finish("call_1", "completed", { promptTokens: 2, completionTokens: 1, totalTokens: 3 }, null, at);
    const admissions = new SqliteModelAdmissionStore(sqlite);
    admissions.enqueue("admission_1", context, 60, at);
    admissions.finish("admission_1", "cancelled", "cancelled", "Run closed", at);

    let eventId = 0;
    const stream = new SqliteScenarioAgentEventStream(sqlite, undefined, () => `event_${++eventId}`, () => at);
    expect(stream.reconcileFromProjections()).toBe(4);
    expect(stream.reconcileFromProjections()).toBe(0);
    expect(stream.list("run_1").events.map((event) => event.method)).toEqual([
      "turn/started", "turn/completed", "item/completed", "item/completed",
    ]);
    const terminal = stream.list("run_1").events.find((event) => event.method === "turn/completed");
    expect(terminal?.params).toMatchObject({ status: "completed", outcome: "blocked" });
  });

  it("reconstructs approval Turns from the durable approval projection", () => {
    const sqlite = getSqliteClient(createDb(":memory:"));
    databases.push(sqlite);
    sqlite.prepare(`
      INSERT INTO scenario_work_approvals
        (id, run_id, case_id, work_id, action_key, tool_name, risk, rationale, input_ref, status,
         requested_by_worker_id, resolution_reason, created_at, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "approval_1", "run_1", "case_1", "work_1", "action_1", "http.request", "bounded_write",
      "Operator authorization is required", "artifact:input", "cancelled", "worker_1", "Run closed", at, at,
    );

    let eventId = 0;
    const stream = new SqliteScenarioAgentEventStream(sqlite, undefined, () => `event_${++eventId}`, () => at);
    expect(stream.reconcileFromProjections()).toBe(4);
    expect(stream.reconcileFromProjections()).toBe(0);
    expect(stream.list("run_1").events.map((event) => [
      event.method,
      "item" in event.params ? event.params.item.status : "status" in event.params ? event.params.status : undefined,
    ])).toEqual([
      ["turn/started", undefined],
      ["item/started", "pending"],
      ["item/completed", "cancelled"],
      ["turn/completed", "cancelled"],
    ]);
  });
});
