import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { AgentEventSequenceReader } from "@traceforge/shared";
import type { ContextCompactionRecord } from "@traceforge/cognitive-runtime";
import { AgentAuditProjection } from "./agent-audit-projection.js";
import { SqliteScenarioAgentEventStream } from "./scenario-agent-event-stream.js";
import { SqliteContextCompactionStore } from "./context-compaction-store.js";
import { SqliteCognitiveSnapshotStore } from "./cognitive-context-snapshots.js";
import { at, database, initialize, uncertain, signEvidence, evidence } from "./test-fixtures/execution-recovery.js";
import { foundationHost, eventually, type FoundationHost } from "./test-fixtures/foundation-host.js";
import { archiveExecutionRow } from "./db/execution-archive.js";

const databases: Database.Database[] = [], roots: string[] = [], hosts: FoundationHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0).reverse()) if (host.sqlite.open) await host.close();
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true});
});
function open(path?: string) { const sqlite=database(path); databases.push(sqlite); return sqlite; }
function project(sqlite: Database.Database) { const stream = new SqliteScenarioAgentEventStream(sqlite); return {stream,audit:new AgentAuditProjection(sqlite,stream)}; }
function compaction(id="summary"): ContextCompactionRecord {
  return {id,caseId:"case",runId:"run",consumer:"worker",inputFingerprint:"input",protectedFingerprint:"anchors",sourceFingerprint:"source",
    compactorVersion:"extract-v1",sourceIds:["/work/resultSummary"],status:"prepared",entries:null,error:null};
}

describe("Durable audit facts and recovery reads", () => {
  it.each(["source_committed","batch_uncommitted","batch_committed"])("recovers an actual killed writer at %s without duplicate facts", async (phase) => {
    const root=mkdtempSync(join(tmpdir(),"traceforge-audit-crash-")); roots.push(root); const path=join(root,"state.db");
    await new Promise<void>((resolve,reject) => {
      const child=spawn(process.execPath,["--import","tsx",fileURLToPath(new URL("../test-fixtures/agent-audit-crash-host.mjs",import.meta.url)),path,phase],{stdio:["ignore","pipe","pipe"]});
      let output="",errors="",ready=false,failure:Error|undefined;
      const fail=(message:string)=>{failure=new Error(message);child.kill("SIGKILL");};
      const timer=setTimeout(()=>fail("Audit crash fixture timed out"),10000);
      child.stdout.on("data",(chunk)=>{output+=String(chunk);if(output.length>4096)return fail("Audit fixture output limit");
        if(output.includes("\n")){ready=true;child.kill("SIGKILL");}});
      child.stderr.on("data",(chunk)=>{errors+=String(chunk);if(errors.length>8192)fail("Audit fixture stderr limit");});
      child.on("error",(error)=>{clearTimeout(timer);reject(error);});
      child.on("close",(_code,signal)=>{clearTimeout(timer); if(failure)reject(failure);
        else if(!ready || signal!=="SIGKILL")reject(new Error(`Audit fixture failed: ${errors}`));else resolve();});
    });
    const sqlite=open(path), {stream,audit}=project(sqlite);
    if(phase!=="batch_committed") expect(stream.list("run").events).toEqual([]);
    audit.reconcile(); const page=stream.replay("case","run");
    expect(page.events.filter((event)=>"item" in event.params && event.params.item.type==="controlChange" && event.params.item.audit?.source==="compaction")).toHaveLength(1);
    expect(audit.reconcile()).toBe(0); sqlite.close();
    const restarted=project(open(path)); expect(restarted.audit.reconcile()).toBe(0);
    expect(restarted.stream.replay("case","run",page.nextCursor).events).toEqual([]);
  });
  it("repairs a cancelled Run from durable control events across a disk reopen without executing actions", () => {
    const root=mkdtempSync(join(tmpdir(),"traceforge-audit-")); roots.push(root); const path=join(root,"state.db");
    const sqlite=open(path), c=initialize(sqlite); const before=c.runtime.load("run")!;
    c.runtime.execute({runId:"run",commandId:"cancel",expectedRevision:before.revision,
      command:{type:"cancel_run",reason:"Operator requested stop",at}});
    sqlite.close();
    const reopened=open(path), {stream,audit}=project(reopened);
    expect(audit.reconcile()).toBeGreaterThan(0);
    const first=stream.replay("case","run",undefined,2); const remaining=stream.replay("case","run",first.nextCursor);
    const all=[...first.events,...remaining.events];
    expect(all.some((event) => "item" in event.params && event.params.item.type==="controlChange" && event.params.item.eventType==="run_cancelled")).toBe(true);
    expect(audit.reconcile()).toBe(0);
    expect(reopened.prepare("SELECT count(*) AS n FROM tool_invocation_executions").get()).toEqual({n:0});
    reopened.close(); const again=open(path), next=project(again);
    expect(next.audit.reconcile()).toBe(0);
    expect(next.stream.replay("case","run",remaining.nextCursor).events).toEqual([]);
  });

  it("records compaction identity, fallback and read-only provenance without promoting summaries to evidence", () => {
    const sqlite=open(); initialize(sqlite); const store=new SqliteContextCompactionStore(sqlite), {stream,audit}=project(sqlite);
    store.prepare(compaction()); audit.reconcile();
    store.recoverPrepared(); audit.reconcile();
    store.prepare(compaction("second")); store.finish("second",[{id:"/work/resultSummary",text:"private summary"}],null); audit.reconcile();
    const facts=stream.list("run").events.flatMap((event) => "item" in event.params && event.params.item.type==="controlChange" && event.params.item.audit ? [event.params.item.audit] : []);
    expect(facts.map((f) => [f.sourceId,f.state])).toEqual([["summary","prepared"],["summary","failed"],["second","completed"]]);
    new SqliteCognitiveSnapshotStore(sqlite).prepare({id:"decision",caseId:"case",runId:"run",workId:"work",consumer:"worker",sourceRunRevision:3,at,
      request:{system:"private prompt",user:"private context",schema:{}},contextManifest:{contextCompaction:{id:"second",status:"fallback",compactorVersion:"extract-v1"}}});
    audit.reconcile();
    expect(audit.read("case","run","contextSnapshot","decision")).toMatchObject({workId:"work",state:{compactionId:"second",status:"fallback"}});
    sqlite.pragma("query_only=ON");
    const metadata=audit.read("case","run","compaction","second");
    expect(metadata.state).toMatchObject({compactorVersion:"extract-v1",semanticQualityVerified:false,sourceIds:["/work/resultSummary"]});
    expect(JSON.stringify(metadata)).not.toContain("private summary");
    expect(JSON.stringify(audit.read("case","run","contextSnapshot","decision"))).not.toContain("private prompt");
    expect(() => audit.read("case","another","compaction","second")).toThrow("another Case/Run");
    expect(stream.replay("case","run").events.length).toBeGreaterThan(0);
  });

  it("keeps uncertain observation separate from independently verified resolution, including archived references", async () => {
    const sqlite=open(), c=await uncertain(sqlite), {stream,audit}=project(sqlite); audit.reconcile();
    const observed=stream.list("run").events.find((event) => "item" in event.params && event.params.item.type==="controlChange" && event.params.item.audit?.source==="invocation")!;
    expect(observed.params).toMatchObject({item:{audit:{state:"uncertain",semantics:"observed_state",automaticRetryAllowed:false}}});
    await c.recovery.recover({idempotencyKey:"call",commandId:"recover",actor:"operator",reason:"Independent evidence",
      resolution:"confirmed_no_effect",evidence:signEvidence(evidence(c))});
    audit.reconcile();
    const reconciliation=c.reconciliation.listAudits("call")[0]!;
    const recorded=audit.read("case","run","reconciliation",reconciliation.commandId);
    expect(recorded.state).toMatchObject({outcome:"resolved",requestedResolution:"confirmed_no_effect",authorizationDecision:"allowed"});
    sqlite.transaction(() => { archiveExecutionRow(sqlite,"reconciliation",reconciliation.commandId,at); archiveExecutionRow(sqlite,"command","recover",at); })();
    expect(audit.read("case","run","reconciliation",reconciliation.commandId)).toEqual(recorded);
    expect(audit.reconcile()).toBe(0);
    expect(audit.read("case","run","invocation","call").state.status).toBe("completed");
    expect(c.runtime.load("run")!.workItems).toHaveLength(1);
    expect(sqlite.prepare("SELECT count(*) AS n FROM worker_tool_receipts").get()).toEqual({n:0});
    expect(stream.list("run").events.find((event) => event.id===observed.id)).toEqual(observed);
  });

  it("rejects denied reconciliation as cleanup proof and reads never resume a recovery command", async () => {
    const sqlite=open(), c=await uncertain(sqlite), {audit,stream}=project(sqlite);
    await expect(c.recovery.recover({idempotencyKey:"call",commandId:"bad",actor:"operator",reason:"Untrusted evidence",
      resolution:"confirmed_no_effect",evidence:{untrusted:true}})).rejects.toThrow();
    audit.reconcile();
    const request=audit.read("case","run","recoveryCommand","bad"); expect(request.state.status).toBe("registered");
    const state=c.bindings.execution("call");
    sqlite.pragma("query_only=ON");
    stream.replay("case","run"); audit.read("case","run","invocation","call");
    expect(c.bindings.execution("call")).toEqual(state); expect(state?.status).toBe("uncertain");
  });

  it("bounds each repair pass and preserves durable sources when projection capacity is exhausted", () => {
    const sqlite=open(); initialize(sqlite); const {stream,audit}=project(sqlite), store=new SqliteContextCompactionStore(sqlite);
    for (let i=0;i<4;i++) {store.prepare(compaction(`summary${i}`)); store.finish(`summary${i}`,null,"interrupted");}
    audit.reconcile(1);
    expect(sqlite.prepare("SELECT count(*) AS n FROM scenario_agent_fact_projections WHERE source_key LIKE 'compaction:%'").get()).toEqual({n:1});
    sqlite.prepare("UPDATE scenario_agent_event_policy SET maximum_records=1").run();
    expect(() => audit.synchronize()).toThrow("capacity"); expect(audit.status().status).toBe("delayed");
    expect(sqlite.prepare("SELECT count(*) AS n FROM context_compactions").get()).toEqual({n:4});
    const saved=stream.list("run").events.length;
    sqlite.prepare("UPDATE scenario_agent_event_policy SET maximum_records=200000").run(); audit.synchronize();
    expect(audit.status().error).toBeNull(); expect(stream.list("run").events.length).toBeGreaterThan(saved);
    expect(audit.reconcile()).toBe(0);
  });

  it("reconnects a live HTTP foundation after an audit outage without blocking cancellation or restarting tools", async () => {
    let toolCalls=0,signal:AbortSignal|undefined,release!:()=>void;
    const h=await foundationHost({foundation:{toolDiscoverySources:[{source:"fixture.host",async discover(){return [{
      name:"fixture.read",source:"fixture.host",version:"1",priority:1,description:"Observe",inputSchema:{},providedCapabilities:["fixture.read"],
      dependencyCapabilities:[],permissionRequirements:{},risk:"read_only",timeoutMs:60000,
      execute(_input,context){ toolCalls++;signal=context.signal;return new Promise((resolve)=>{release=()=>resolve({status:"succeeded",summary:"late",raw:"late",refs:[],retryable:false});});},
    }];}}]}});hosts.push(h);
    await h.start();await eventually(async()=>toolCalls===1);
    const prefix=await h.request("/api/scenarios/runs/run/agent-event-replay?caseId=case");
    h.sqlite.prepare("UPDATE scenario_agent_event_policy SET maximum_records=1").run();
    const state=await h.state(); await h.request("/api/scenarios/runs/run/cancel",{commandId:"stop",expectedRevision:state.revision,reason:"Stop requested"});
    await eventually(async()=>!!signal?.aborted);release();
    const delayed=await h.request(`/api/scenarios/runs/run/agent-event-replay?caseId=case&cursor=${prefix.nextCursor}`);
    expect(delayed.auditProjection.status).toBe("delayed");
    h.sqlite.prepare("UPDATE scenario_agent_event_policy SET maximum_records=200000").run();
    let tail:any;
    await eventually(async()=>{tail=await h.request(`/api/scenarios/runs/run/agent-event-replay?caseId=case&cursor=${prefix.nextCursor}`);
      return tail.events.some((event:any)=>event.params.item?.audit?.source==="invocation");});
    const reader=new AgentEventSequenceReader({caseId:"case",runId:"run"});
    for (const event of [...prefix.events,...tail.events,...tail.events]) reader.accept(event);
    expect(reader.cursor).toBe([...prefix.events,...tail.events].at(-1).sequence);
    expect(toolCalls).toBe(1);expect((await h.state()).status).toBe("cancelled");
    await h.close(false);const restarted=await foundationHost({root:h.root,ready:()=>false});hosts.push(restarted);
    expect(restarted.calls()).toBe(0);
    const replay=await restarted.request(`/api/scenarios/runs/run/agent-event-replay?caseId=case&cursor=${tail.nextCursor}`);
    expect(replay.replayOnly).toBe(true);
    expect(restarted.sqlite.prepare("SELECT status FROM tool_invocation_executions").get()).toEqual({status:"uncertain"});
  });
});
