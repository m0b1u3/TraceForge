import { describe, expect, it } from "vitest";
import type { LlmProvider } from "@traceforge/llm";
import type { WorkerModelRequest } from "@traceforge/worker-runtime";
import { parallelTool } from "@traceforge/worker-runtime";
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

it("restricts the actual model schema and parser during read-only conclusion",async()=>{
  const input={...request(),executionMode:"conclude" as const};
  const model=new StructuredWorkerModel({async extractJson(value){expect(value.schema.properties.type).toEqual({const:"block"});expect(JSON.parse(value.user).executionMode).toBe("conclude");return {type:"block",reason:"Observed result; further work required"};}});
  expect((await model.decide(input)).type).toBe("block");
  await expect(new StructuredWorkerModel(provider({type:"complete",summary:"Forbidden",outputs:[]})).decide(input)).rejects.toThrow();
});

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
  it("sends explicit object roots for native tools and rejects incompatible roots before model dispatch", async () => {
    const input = request();
    input.tools = [{ name: "fixture.mutate", source: "fixture", version: "1", priority: 1,
      description: "Mutate a neutral record", inputSchema: { oneOf: [{ type: "object", properties: { id: { type: "string" } } }] },
      providedCapabilities: ["fixture.write"], dependencyCapabilities: [], permissionRequirements: {}, risk: "bounded_write", timeoutMs: 1000 }];
    let calls = 0;
    const model = new StructuredWorkerModel({ async extractJson() { throw new Error("JSON path"); },
      async streamTools(value) {
        calls++;
        const schema = value.tools.find(item => item.description.startsWith("fixture.mutate:"))?.input_schema;
        expect(schema).toEqual({ type: "object", oneOf: [{ type: "object", properties: { id: { type: "string" } } }] });
        return { text: "", done: false, toolCalls: [{ id: "stop", name: "tf_block", input: { reason: "Done" } }] };
      } });
    expect(await model.decide(input)).toEqual({ type: "block", reason: "Done" });
    expect(calls).toBe(1);
    input.tools[0] = { ...input.tools[0]!, inputSchema: { type: "array", items: { type: "string" } } };
    await expect(model.decide(input)).rejects.toThrow("requires an object input Schema");
    expect(calls).toBe(1);
  });
  it("uses native function calling for Worker tools and maps the call back to the governed catalog", async () => {
    const input = request();
    input.tools = [{ name: "fixture.read", source: "fixture", version: "1", priority: 1,
      description: "Read a neutral record", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      providedCapabilities: ["fixture.read"], dependencyCapabilities: [], permissionRequirements: {}, risk: "read_only", timeoutMs: 1000 }];
    let nativeCalls = 0;
    const model = new StructuredWorkerModel({
      async extractJson() { throw new Error("JSON decision path must not run"); },
      async streamTools(value) {
        nativeCalls++;
        const tool = value.tools.find(item => item.description.startsWith("fixture.read:"));
        expect(tool?.name).toMatch(/^tf_fixture_read_[a-f0-9]{12}$/);
        expect(value.tools.some(item => item.name === "tf_complete")).toBe(true);
        return { text: "Read the record", done: false,
          toolCalls: [{ id: "provider-call", name: tool!.name, input: { id: "first" } }] };
      },
    });
    const first = await model.decide(input);
    const again = await model.decide(input);
    expect(first).toMatchObject({ type: "invoke_tool", invocation: { tool: "fixture.read", input: { id: "first" }, rationale: "Read the record" } });
    expect(first).toEqual(again);
    expect(nativeCalls).toBe(2);
  });
  it("rejects native calls outside the current catalog or with multiple actions", async () => {
    const input = request();
    const bad = (toolCalls: Array<{ id: string; name: string; input: unknown }>) =>
      new StructuredWorkerModel({ async extractJson() { throw new Error("JSON path"); },
        async streamTools() { return { text: "", done: false, toolCalls }; } });
    await expect(bad([{ id: "first", name: "unlisted", input: {} }]).decide(input)).rejects.toThrow(/outside its current catalog/);
    await expect(bad([{ id: "first", name: "tf_block", input: { reason: "A" } },
      { id: "second", name: "tf_complete", input: { summary: "B", outputs: [] } }]).decide(input)).rejects.toThrow(/incompatible simultaneous/);
    expect(await bad([{ id: "first", name: "tf_block", input: {
      type: "invoke_tool", invocation: { id: "forged", tool: "unlisted", input: {} }, reason: "Stop",
    } }]).decide(input)).toEqual({ type: "block", reason: "Stop" });
  });
  it("groups simultaneous independent native reads through the existing durable parallel tool", async () => {
    const input = request();
    input.tools = [parallelTool, { name: "fixture.read", source: "fixture", version: "1", priority: 1,
      description: "Read a neutral record", inputSchema: { type: "object" },
      providedCapabilities: ["fixture.read"], dependencyCapabilities: [], permissionRequirements: {}, risk: "read_only", timeoutMs: 1000 }];
    const model = new StructuredWorkerModel({ async extractJson() { throw new Error("JSON path"); },
      async streamTools(value) {
        expect(value.tools.some(item => item.description.startsWith("tools.parallel_read:"))).toBe(false);
        expect(JSON.parse(value.messages[0]!.content).tools.some((tool: {name:string}) => tool.name === "tools.parallel_read")).toBe(false);
        const name = value.tools.find(item => item.description.startsWith("fixture.read:"))!.name;
        return { text: "Read both records", done: false, toolCalls: [
          { id: "one", name, input: { id: "first" } }, { id: "two", name, input: { id: "second" } },
        ] };
      } });
    expect(await model.decide(input)).toMatchObject({ type: "invoke_tool", invocation: { tool: "tools.parallel_read",
      input: { calls: [{ id: "one", tool: "fixture.read", input: { id: "first" } },
        { id: "two", tool: "fixture.read", input: { id: "second" } }] } } });
  });
  it("preserves the actual completion contract outside compaction and rejects invented kinds",async()=>{
    const input=request();input.outputContract={allowedKinds:["neutral.observation","neutral.summary"],requiredAnyOf:["neutral.observation"]};
    const compact={maximumTextCharacters:4800,async prepare(){return {context:{outputContract:{allowedKinds:["invented"]}},manifest:{}};}} as unknown as NonNullable<ConstructorParameters<typeof StructuredWorkerModel>[6]>;
    const model=new StructuredWorkerModel({async extractJson(value){expect(JSON.parse(value.user).outputContract).toEqual(input.outputContract);expect(value.schema.oneOf[1].properties.outputs.items.properties.kind.enum).toEqual(input.outputContract!.allowedKinds);return {type:"complete",summary:"Observed",outputs:[{id:"result",kind:"neutral.observation",summary:"Observed",refs:[]}]};}},undefined,undefined,undefined,undefined,undefined,compact);
    expect((await model.decide(input)).type).toBe("complete");
    for(const kind of ["invented","neutral.summary"]){await expect(new StructuredWorkerModel(provider({type:"complete",summary:"Observed",outputs:[{id:"result",kind,summary:"Observed",refs:[]}]})).decide(input)).rejects.toThrow(/output kind/);}
  });
  it("keeps exact output references outside compaction and distinguishes recall handles",async()=>{
    const input=request();input.transcript=[{turn:1,kind:"tool",summary:"Observed",refs:["artifact:first"],receiptKey:"lookup:first"}];
    const compact={maximumTextCharacters:4800,async prepare(){return {context:{referenceCatalog:{evidenceRefs:["invented"]}},manifest:{}};}} as unknown as NonNullable<ConstructorParameters<typeof StructuredWorkerModel>[6]>;
    const model=new StructuredWorkerModel({async extractJson(value){
      expect(JSON.parse(value.user).referenceCatalog).toEqual({evidenceRefs:["scope_1","artifact:first"]});
      expect(value.system).toContain("receiptKey is a lookup handle");
      return {type:"complete",summary:"Observed only",outputs:[]};
    }},undefined,undefined,undefined,undefined,undefined,compact);
    await model.decide(input);
  });
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
    const input=request(); input.permissionContext={scope:{targets:["first"]},form:{fields:[{path:["targets"],type:"string-list"}]},expiresAt:"2099-01-01T00:00:00.000Z",
      allowedActions:["records.inspect"],deniedActions:["records.modify"],capabilityAuthorization:[{source:"neutral",capability:"records.preview",authorizationAction:"records.inspect"}]};
    const model=new StructuredWorkerModel({async extractJson(value){
      expect(JSON.parse(value.user).authorization).toEqual(input.permissionContext);
      expect(value.system).toContain("it grants nothing");
      expect(value.system).toContain("different namespaces");
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
