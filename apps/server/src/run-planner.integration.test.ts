import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import {
  DurableScenarioRuntime,
  ScenarioDefinitionRegistry,
} from "@traceforge/orchestration-core";
import { WEB_BLACKBOX_CAPABILITIES, WEB_BLACKBOX_SCENARIO } from "./test-fixtures/web-blackbox-descriptor.js";
import { createDb, getSqliteClient } from "./db/client.js";
import { SqliteEvidenceGraphStore } from "./evidence-graph-store.js";
import { SqliteScenarioEventStore } from "./scenario-event-store.js";
import {
  planningFingerprint,
  RunPlannerSupervisor,
  type RunPlannerDecision,
  type RunPlannerModel,
} from "@traceforge/cognitive-runtime";
import { SqliteRunPlannerStore } from "./run-planner.js";

const open: Database.Database[] = [];
const at = "2026-08-25T09:00:00.000Z";
const capabilities = Object.values(WEB_BLACKBOX_CAPABILITIES);

class SequencePlanner implements RunPlannerModel {
  calls = 0;

  constructor(private readonly decisions: RunPlannerDecision[]) {}

  async evaluate(): Promise<RunPlannerDecision> {
    const decision = this.decisions[this.calls];
    this.calls += 1;
    if (!decision) throw new Error("Unexpected Planner evaluation");
    return decision;
  }
}

function setup(decisions: RunPlannerDecision[]) {
  const sqlite = getSqliteClient(createDb(":memory:"));
  open.push(sqlite);
  const definitions = new ScenarioDefinitionRegistry([WEB_BLACKBOX_SCENARIO]);
  const events = new SqliteScenarioEventStore(sqlite);
  const runtime = new DurableScenarioRuntime(events, definitions);
  const graphs = new SqliteEvidenceGraphStore(sqlite);
  const plannerStore = new SqliteRunPlannerStore(sqlite);
  const model = new SequencePlanner(decisions);
  let evaluationSequence = 0;
  runtime.execute({
    runId: "run_1",
    commandId: "start",
    expectedRevision: 0,
    definitionKind: "web_blackbox",
    definitionVersion: 1,
    command: {
      type: "start_run",
      runId: "run_1",
      caseId: "case_1",
      goal: "Assess the authorized surface",
      scopeRef: "scope_1",
      scenarioPackage: { id: "traceforge.web-blackbox", version: "0.1.0", schemaRevision: 1 },
      availableCapabilities: capabilities,
      at,
    },
  });
  const supervisor = new RunPlannerSupervisor(
    runtime,
    definitions,
    events,
    graphs,
    plannerStore,
    model,
    3,
    () => `evaluation_${++evaluationSequence}`,
    () => at,
  );
  return { runtime, graphs, plannerStore, model, supervisor };
}

afterEach(() => {
  while (open.length) open.pop()!.close();
});

describe("independent Run Planner", () => {
  it.each(["known-work", "work:known-work"])("does not accept a Work identity as evidence: %s", async ref => {
    const f = setup([{ action: "plan", rationale: "Follow up", proposals: [{ kind: "research", title: "Follow up",
      objective: "Assess a second independent observation", priority: 50, requiredCapabilities: [], hypothesisIds: [],
      evidenceRefs: [ref], maxAttempts: 1 }], cancellations: [], reprioritizations: [] }]);
    f.runtime.execute({ runId: "run_1", commandId: "known", expectedRevision: 1,
      command: { type: "propose_work", proposal: { id: "known-work", kind: "research", title: "First",
        objective: "Assess first observation", idempotencyKey: "first" }, at } });
    await expect(f.supervisor.tick()).rejects.toThrow("unknown Evidence");
    expect(f.runtime.load("run_1")!.workItems).toHaveLength(1);
  });
  it.each(["queued","blocked"])("rejects a renamed duplicate direction while original Work is %s",async(status)=>{
    const f=setup([{action:"plan",rationale:"Duplicate",proposals:[{kind:"research",title:"Different label",objective:"Inspect   first resource",priority:50,requiredCapabilities:[],hypothesisIds:[],evidenceRefs:[],maxAttempts:1}],cancellations:[],reprioritizations:[]}]);
    const command=(command:Parameters<typeof f.runtime.execute>[0]["command"])=>f.runtime.execute({runId:"run_1",commandId:`direction:${f.runtime.load("run_1")!.revision}`,expectedRevision:f.runtime.load("run_1")!.revision,command});
    command({type:"propose_work",proposal:{id:"original",kind:"research",title:"Original label",objective:"Inspect first resource",idempotencyKey:"original"},at});
    if(status==="blocked"){
      command({type:"claim_work",workId:"original",leaseId:"lease",workerId:"worker",workerRoles:["researcher"],workerCapabilities:capabilities,workerCurrentWork:0,workerMaxConcurrentWork:1,leaseExpiresAt:"2099-01-01T00:00:00.000Z",at});
      command({type:"block_work",workId:"original",leaseId:"lease",reason:"Prerequisite missing",at});
    }
    await expect(f.supervisor.tick()).rejects.toThrow("duplicate Work");expect(f.runtime.load("run_1")!.workItems).toHaveLength(1);
  });
  it("answers a durable inquiry in one evaluation and queues the original checkpoint without a new Work",async()=>{
    const f=setup([{action:"answer",workId:"question-work",inquiryId:"question",answer:"Inspect the second candidate using the existing scope",rationale:"Resolve ambiguity"},{action:"wait",rationale:"Work can continue"}]);
    const command=(command:Parameters<typeof f.runtime.execute>[0]["command"])=>f.runtime.execute({runId:"run_1",commandId:`test:${f.runtime.load("run_1")!.revision}`,expectedRevision:f.runtime.load("run_1")!.revision,command});
    command({type:"propose_work",proposal:{id:"question-work",kind:"research",title:"Inspect",objective:"Inspect",idempotencyKey:"question-work"},at});
    command({type:"claim_work",workId:"question-work",leaseId:"question-lease",workerId:"worker",workerRoles:["researcher"],workerCapabilities:capabilities,workerCurrentWork:0,workerMaxConcurrentWork:1,leaseExpiresAt:"2099-01-01T00:00:00.000Z",at});
    command({type:"checkpoint_work",workId:"question-work",leaseId:"question-lease",checkpointId:"checkpoint",payloadRef:"checkpoint:question",progressSummary:"Question persisted",at});
    command({type:"block_work",workId:"question-work",leaseId:"question-lease",reason:"Which candidate next?",inquiry:{id:"question",refs:[]},at});
    expect(f.runtime.load("run_1")!.status).toBe("running");
    expect(()=>command({type:"continue_work",workId:"question-work",checkpointRef:"checkpoint:question",authorizationRef:"audit",reason:"Continue",at})).toThrow("Pending inquiry");
    expect(()=>command({type:"retry_blocked_work",workId:"question-work",replacementWorkId:"replacement",idempotencyKey:"replacement",authorizationRef:"audit",reason:"Retry",at})).toThrow("Pending inquiry");
    expect(()=>command({type:"advance_phase",to:"surface_mapping",at})).toThrow("unsettled work");
    await f.supervisor.tick();expect(f.model.calls).toBe(1);
    expect(f.runtime.load("run_1")!.workItems).toMatchObject([{id:"question-work",status:"queued",resumeFromCheckpoint:true,inquiry:{status:"answered"}}]);
    expect(f.runtime.load("run_1")!.directives.at(-1)).toMatchObject({issuedBy:"planner",targetWorkId:"question-work"});
    await f.supervisor.tick();await f.supervisor.tick();expect(f.model.calls).toBe(2);
  });
  it("reevaluates shared work that changes while the model is thinking", async () => {
    const wait = {action:"wait", rationale:"Await active work"} as const;
    const {runtime, model, supervisor, plannerStore} = setup([wait, wait]);
    const evaluate = model.evaluate.bind(model);
    model.evaluate = async () => {
      const state = runtime.load("run_1")!;
      runtime.execute({runId:state.id, commandId:"concurrent", expectedRevision:state.revision,
        command:{type:"propose_work", proposal:{id:"new_work",kind:"research",title:"First candidate",
          objective:"Inspect shared evidence",idempotencyKey:"first_effect"}, at}});
      return evaluate();
    };
    await expect(supervisor.tick()).rejects.toThrow("context changed");
    expect(plannerStore.list("run_1")[0].applied).toBe(false);
    model.evaluate = evaluate;
    await supervisor.tick(); await supervisor.tick();
    expect(model.calls).toBe(2);
  });
  it("persists a bounded plan and creates server-owned Work exactly once", async () => {
    const plan: RunPlannerDecision = {
      action: "plan",
      rationale: "The active phase has no scope inventory Work.",
      proposals: [{
        kind: "research",
        title: "Capture scope and capability inventory",
        objective: "Record the authorized scope and available execution capabilities.",
        priority: 80,
        requiredCapabilities: [WEB_BLACKBOX_CAPABILITIES.scopeRead],
        hypothesisIds: [],
        evidenceRefs: ["scope_1"],
        maxAttempts: 2,
      }],
      cancellations: [],
      reprioritizations: [],
    };
    const { runtime, plannerStore, model, supervisor } = setup([
      plan,
      { action: "wait", rationale: "The planned Work is queued for execution." },
    ]);

    await supervisor.tick();
    expect(runtime.load("run_1")!.workItems).toEqual([
      expect.objectContaining({
        id: "planner-work-evaluation_1-0",
        status: "queued",
        priority: 80,
        idempotencyKey: "planner-effect:evaluation_1:0",
      }),
    ]);
    expect(plannerStore.list("run_1")[0]).toMatchObject({ id: "evaluation_1", applied: true, decision: plan });

    await supervisor.tick();
    await supervisor.tick();
    expect(model.calls).toBe(2);
    expect(runtime.load("run_1")!.workItems).toHaveLength(1);
  });

  it("does not replan for lease ownership and heartbeat-only execution changes", () => {
    const { runtime, graphs } = setup([]);
    let state = runtime.execute({
      runId: "run_1",
      commandId: "work",
      expectedRevision: runtime.load("run_1")!.revision,
      command: {
        type: "propose_work",
        proposal: {
          id: "work_1",
          kind: "research",
          title: "Record scope",
          objective: "Record authorized scope state.",
          idempotencyKey: "effect_work_1",
        },
        at,
      },
    }).state;
    const graph = graphs.ensure("case_1", at);
    const before = planningFingerprint(state, graph, 200, 100);
    state = runtime.execute({
      runId: "run_1",
      commandId: "claim",
      expectedRevision: state.revision,
      command: {
        type: "claim_work",
        workId: "work_1",
        workerId: "researcher_1",
        workerRoles: ["researcher"],
        workerCapabilities: capabilities,
        workerCurrentWork: 0,
        workerMaxConcurrentWork: 1,
        leaseId: "lease_1",
        leaseExpiresAt: "2026-08-25T09:01:00.000Z",
        at,
      },
    }).state;
    expect(planningFingerprint(state, graph, 200, 100)).toBe(before);
  });

  it("uses deterministic transition guards after phase requirements are satisfied", async () => {
    const { runtime, model, supervisor } = setup([
      { action: "wait", rationale: "No additional Work is required before the guarded transition." },
    ]);
    let state = runtime.execute({
      runId: "run_1",
      commandId: "scope-work",
      expectedRevision: runtime.load("run_1")!.revision,
      command: {
        type: "propose_work",
        proposal: {
          id: "scope_work",
          kind: "research",
          title: "Record scope",
          objective: "Record authorized scope and execution capabilities.",
          idempotencyKey: "effect_scope_work",
        },
        at,
      },
    }).state;
    state = runtime.execute({
      runId: "run_1",
      commandId: "claim-scope-work",
      expectedRevision: state.revision,
      command: {
        type: "claim_work",
        workId: "scope_work",
        workerId: "researcher_1",
        workerRoles: ["researcher"],
        workerCapabilities: capabilities,
        workerCurrentWork: 0,
        workerMaxConcurrentWork: 1,
        leaseId: "lease_scope",
        leaseExpiresAt: "2026-08-25T09:01:00.000Z",
        at,
      },
    }).state;
    state = runtime.execute({
      runId: "run_1",
      commandId: "complete-scope-work",
      expectedRevision: state.revision,
      command: {
        type: "complete_work",
        workId: "scope_work",
        leaseId: "lease_scope",
        summary: "Scope and capabilities recorded.",
        outputs: [
          { id: "scope_output", kind: "scope_snapshot", summary: "Authorized scope", refs: ["scope_1"], createdAt: at },
          { id: "capability_output", kind: "capability_inventory", summary: "Available capabilities", refs: ["scope_1"], createdAt: at },
        ],
        at,
      },
    }).state;
    expect(state.activePhaseId).toBe("scope_setup");

    await supervisor.tick();
    expect(model.calls).toBe(1);
    expect(runtime.load("run_1")!.activePhaseId).toBe("surface_mapping");
  });
});
