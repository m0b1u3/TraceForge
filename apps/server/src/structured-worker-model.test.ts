import { describe, expect, it } from "vitest";
import type { LlmProvider } from "@traceforge/llm";
import type { WorkerModelRequest } from "@traceforge/worker-runtime";
import { StructuredWorkerModel } from "@traceforge/cognitive-runtime";
import { createDb, getSqliteClient } from "./db/client.js";
import { SqliteCognitiveSnapshotStore } from "./cognitive-context-snapshots.js";
import { SqliteScenarioAgentEventStream } from "./scenario-agent-event-stream.js";

function request(): WorkerModelRequest {
  return {
    turnId: "worker_context_1",
    worker: {
      id: "worker_1", roles: ["researcher"], capabilities: ["knowledge.graph.read"], maxConcurrentWork: 1,
      status: "online", heartbeatAt: "2026-08-24T08:00:00.000Z",
    },
    assignment: {
      runId: "run_1", leaseId: "lease_1", leaseExpiresAt: "2026-08-24T09:00:00.000Z", runRevision: 3,
      runContext: { caseId: "case_1", goal: "Assess", scopeRef: "scope_1", activePhaseId: "phase_1", directives: [] },
      work: {
        id: "work_1", runId: "run_1", phaseId: "phase_1", kind: "research", title: "Work", objective: "Collect facts",
        priority: 50, status: "running", allowedWorkerRoles: ["researcher"], requiredCapabilities: [], hypothesisIds: [], evidenceRefs: [],
        workerId: "worker_1", leaseId: "lease_1", leaseExpiresAt: "2026-08-24T09:00:00.000Z", attempt: 1, maxAttempts: 3,
        idempotencyKey: "effect", latestCheckpoint: null, resumeFromCheckpoint: false, pendingApproval: null, approvalHistory: [], grantedActionKeys: [], resultSummary: null, error: null,
        createdAt: "2026-08-24T08:00:00.000Z", startedAt: "2026-08-24T08:00:01.000Z", finishedAt: null,
      },
    },
    tools: [], toolResolution: { requestedCapabilities: [], unresolvedCapabilities: [], registryRevision: 1 }, transcript: [], steering: [],
  };
}

function provider(result: unknown): LlmProvider {
  return {
    async extractJson(input) {
      expect(input.system).toContain("authorized scope");
      expect(input.system).toContain("do not expose private chain-of-thought");
      return result;
    },
    async runTools() { throw new Error("not used"); },
  };
}

describe("StructuredWorkerModel", () => {
  it("does not suspend for a Planner reported unavailable",async()=>{
    const input=request();input.plannerAvailable=false;
    const model=new StructuredWorkerModel(provider({type:"inquire",reason:"Which next?",refs:[]}));
    expect(await model.decide(input)).toMatchObject({type:"block",reason:expect.stringContaining("Planner is unavailable")});
  });
  it("bounds recall before compaction and preserves a post-compaction excerpt",async()=>{
    const input=request();input.transcript=[{turn:1,kind:"tool",summary:"[recall-page]"+"R".repeat(20000),refs:["receipt:first"]},
      ...Array.from({length:10},(_,i)=>({turn:i+2,kind:"tool" as const,summary:"N".repeat(6000),refs:[]}))];
    const compact={maximumTextCharacters:4800,async prepare(value:{context:unknown}){
      const context=value.context as {transcript:Array<{summary:string}>};
      expect(context.transcript).toHaveLength(11); // Preserve ordinary sources for the compactor's archive/omission accounting.
      expect(context.transcript.find(e=>e.summary.startsWith("[recall-page]"))!.summary).toHaveLength(1600);
      return {context:{},manifest:{}};
    }} as unknown as NonNullable<ConstructorParameters<typeof StructuredWorkerModel>[6]>;
    const model=new StructuredWorkerModel({async extractJson(value){expect(JSON.parse(value.user).recalledText[0].summary).toHaveLength(1600);return {type:"complete",summary:"Done",outputs:[]};}},undefined,undefined,undefined,undefined,undefined,compact);
    await model.decide(input);
  });
  it("exposes the current declarative scope and parses a permission proposal without granting it", async () => {
    const input=request(); input.permissionContext={scope:{targets:["first"]},form:{fields:[{path:["targets"],type:"string-list"}]},expiresAt:"2099-01-01T00:00:00.000Z"};
    const model=new StructuredWorkerModel({async extractJson(value){
      expect(JSON.parse(value.user).authorization).toEqual(input.permissionContext);
      expect(value.system).toContain("it grants nothing");
      return {type:"request_permissions",reason:"Need another resource",scope:{targets:["first","second"]}};
    }});
    expect(await model.decide(input)).toMatchObject({type:"request_permissions",scope:{targets:["first","second"]}});
  });
  it("refuses a stale prepared projection before calling the provider", async () => {
    let checks = 0; let calls = 0;
    const model = new StructuredWorkerModel({ async extractJson() { calls++; return { type: "complete", summary: "Done", outputs: [] }; } },
      undefined, undefined, undefined, undefined, { async prepare(value) {
        checks++; return { request: { ...value, steering: checks === 1 ? ["original"] : ["withdrawn"] }, manifest: {} };
      } });
    await expect(model.decide(request())).rejects.toThrow("authorization changed"); expect(calls).toBe(0); expect(checks).toBe(2);
  });
  it("converts validated provider JSON into a worker decision", async () => {
    const model = new StructuredWorkerModel(provider({
      type: "invoke_tool",
      invocation: { id: "call_1", tool: "knowledge.graph.snapshot", input: { limit: 20 }, rationale: "Read current evidence" },
    }));
    const result = await model.decide(request());
    expect(result).toMatchObject({ type: "invoke_tool", invocation: { id: "call_1" } });
  });

  it("rejects structurally incomplete model actions", async () => {
    const model = new StructuredWorkerModel(provider({
      type: "invoke_tool",
      invocation: { id: "call_1", tool: "knowledge.graph.snapshot", rationale: "Read" },
    }));
    await expect(model.decide(request()))
      .rejects.toThrow(/omitted input/);
  });

  it("records the exact bounded input and validated Worker decision", async () => {
    const sqlite = getSqliteClient(createDb(":memory:"));
    let eventId = 0;
    const events = new SqliteScenarioAgentEventStream(sqlite, undefined, () => `event_${++eventId}`, () => "2026-08-24T08:00:02.000Z");
    const snapshots = new SqliteCognitiveSnapshotStore(sqlite, events);
    const model = new StructuredWorkerModel(
      provider({ type: "block", reason: "The assigned Work lacks a required reference." }),
      undefined,
      snapshots,
      () => "2026-08-24T08:00:02.000Z",
    );
    await expect(model.decide(request())).resolves.toEqual({ type: "block", reason: "The assigned Work lacks a required reference." });
    expect(snapshots.get("worker_context_1")).toMatchObject({
      consumer: "worker",
      runId: "run_1",
      workId: "work_1",
      status: "completed",
      output: { type: "block", reason: "The assigned Work lacks a required reference." },
    });
    expect(events.list("run_1").events.map((event) => event.method)).toEqual([
      "turn/started", "turn/progress", "turn/progress", "turn/progress", "turn/progress",
    ]);
    sqlite.close();
  });
});
