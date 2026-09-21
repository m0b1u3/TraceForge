import {afterEach,expect,it,vi} from "vitest";
import {ScenarioPackageRegistry} from "@traceforge/scenario-sdk";
import {executionToolContractFingerprint,type ExecutionToolAdapter,type ExecutionToolRuntimeSnapshot,type ToolExecutionContext,type ToolExecutionResult,type WorkerModelRequest} from "@traceforge/worker-runtime";
import {ToolReceiptContext} from "./tool-receipt-context.js";
import {database,initialize} from "./test-fixtures/execution-recovery.js";
import {contextPackage,contextBinding} from "./test-fixtures/context-package.js";
import {SqliteScenarioAuthorizationService} from "./scenario-authorization.js";
import {SqliteToolInvocationBindingStore,SqliteToolReceiptStore} from "./worker-execution-adapters.js";
import {PackageContextDiscoverySource,SqlitePackageContextStore} from "./package-context-resources.js";
import {PackageContextPolicy} from "./package-context-policy.js";
import {RunContextPolicy} from "./run-context-policy.js";
import {SqliteCognitiveSnapshotStore} from "./cognitive-context-snapshots.js";
import {foundationHost,eventually} from "./test-fixtures/foundation-host.js";
import {readFileSync} from "node:fs";
import {projectContextAnchors} from "@traceforge/cognitive-runtime";

const cleanup:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{vi.restoreAllMocks();for(const close of cleanup.splice(0).reverse())await close();});
const text="original observation ".repeat(100);
function recallPackage(capabilities=["observe"]) {
  const pkg=contextPackage(capabilities);
  pkg.definition.authorizationActions.push("tool.recall");
  pkg.authorizationPolicy={parseScope:payload=>({payload,allowedActions:["fixture.read","tool.recall"],deniedActions:[]}),authorizeResource:(_scope,_kind,value)=>value};
  return pkg;
}
async function fixture(shippedPolicy=false,denyNamespace=false) {
  const sqlite=database();cleanup.push(()=>sqlite.close());const control=initialize(sqlite);
  const pkg=recallPackage();
  if(shippedPolicy){
    const descriptor=JSON.parse(readFileSync("scenarios/web-blackbox/scenario.json","utf8"));
    pkg.authorizationPolicy=descriptor.authorizationPolicy;
    pkg.definition.authorizationActions=descriptor.definition.authorizationActions;
  }
  if(denyNamespace)pkg.authorizationPolicy={format:"traceforge.scenario-scope-policy.v1",payload:{maximumBytes:65536,maximumDepth:8},allowedActions:["tool.recall"],deniedActions:[],resources:[
    {kind:"tool.receipt.scope",values:["other-run"]},{kind:"tool.receipt",values:["effect:first"]},
    {kind:"tool.receipt.reader",values:["worker"]},{kind:"tool.source",values:["neutral.provider"]}]};
  const packages=new ScenarioPackageRegistry([pkg]);
  sqlite.prepare("INSERT INTO scenario_authorizations(id,case_id,scenario_kind,scope_json,status,approved_by,expires_at,created_at,updated_at) VALUES ('scope','case','neutral','{}','active','test','2099-01-01','2026-01-01','2026-01-01')").run();
  if(shippedPolicy)sqlite.prepare("UPDATE scenario_authorizations SET scope_json=? WHERE id='scope'").run(JSON.stringify({authorizedActions:["tool.recall"]}));
  new SqliteScenarioAuthorizationService(sqlite,packages).pin("scope","case",contextBinding,0);
  let effects=0;
  const origin:ExecutionToolAdapter={name:"neutral.action",source:"neutral.provider",version:"1",priority:1,description:"An ordinary bounded action",
    inputSchema:{type:"object"},providedCapabilities:["observe"],dependencyCapabilities:[],permissionRequirements:{},risk:"bounded_write",timeoutMs:1000,
    execute:async()=>{effects++;return {status:"succeeded",summary:"Observed",raw:text,refs:["first-ref"],retryable:false};}};
  const inventory={sources:[{source:origin.source,status:"ready",acceptingInvocations:true}],providers:[{tool:origin,lifecycle:"active",health:"healthy"}]} as ExecutionToolRuntimeSnapshot;
  const service=new ToolReceiptContext(sqlite,packages,id=>control.runtime.load(id)??null,()=>inventory,["foundation.context"]);
  const context={caseId:"case",runId:"run",workId:"work",workerId:"worker",scopeRef:"scope",leaseId:"lease",leaseExpiresAt:"2099-01-01",idempotencyKey:"effect:recall",effectivePermissions:{}} as ToolExecutionContext;
  const bindings=new SqliteToolInvocationBindingStore(sqlite),receipts=new SqliteToolReceiptStore(sqlite);
  const persist=async(id:string,tool:ExecutionToolAdapter,result:ToolExecutionResult)=>{
    await bindings.prepare({idempotencyKey:`effect:${id}`,invocationId:id,inputFingerprint:"a".repeat(64),
      tool:{name:tool.name,source:tool.source,version:tool.version,contractFingerprint:executionToolContractFingerprint(tool)},attribution:{caseId:"case",runId:"run",workId:"work"}});
    await receipts.put(`effect:${id}`,result);await bindings.complete(`effect:${id}`);
  };
  await persist("first",origin,await origin.execute({},context));
  const tool=(await service.discover())[0];
  return {sqlite,pkg,packages,control,inventory,service,context,tool,persist,receipts,effects:()=>effects};
}

it("pages an ordinary saved output without repeating its original effect",async()=>{
  const f=await fixture();const first=await f.tool.execute({receiptKey:"effect:first"},f.context);
  expect(first.status).toBe("succeeded");const page=JSON.parse(first.raw);
  expect(page).toMatchObject({trust:"untrusted_observation",originalOutcome:"succeeded",content:text.slice(0,1200),nextOffset:1200});
  const next=await f.tool.execute({receiptKey:"effect:first",offset:page.nextOffset,digest:page.digest},f.context);
  expect(JSON.parse(next.raw).content).toBe(text.slice(1200));expect(f.effects()).toBe(1);
  expect(await f.tool.execute({receiptKey:"effect:first",offset:1},f.context)).toMatchObject({status:"failed",raw:""});
});

it("pages more than 256 tracked sources and preserves withdrawal of an early source", async () => {
  const f = await fixture();
  const origin = f.inventory.providers[0].tool;
  for (let i = 0; i < 300; i++) {
    const id = `history-${String(i).padStart(3, "0")}`;
    await f.persist(id, origin, { status: "succeeded", summary: "Saved", raw: `Detail ${i}`, refs: [], retryable: false });
    expect((await f.tool.execute({ receiptKey: `effect:${id}` }, f.context)).status).toBe("succeeded");
  }
  const run = f.control.runtime.load("run")!;
  const sources = await f.service.lineage(run, "worker", "work");
  expect(sources).toHaveLength(300);
  expect(new Set(sources.map(source => source.key)).size).toBe(300);
  expect(sources.every(source => source.valid)).toBe(true);
  f.service.withdraw("effect:history-000", "Changed conditions");
  const refreshed = await f.service.lineage(run, "worker", "work");
  expect(refreshed.filter(source => !source.valid).map(source => source.key)).toEqual(["effect:history-000"]);
  expect(f.effects()).toBe(1);
});

it("finds saved detail without a known receipt key and excludes withdrawn sources", async () => {
  const f = await fixture();
  const search = (await f.service.discover()).find(tool => tool.name === "tool.search")!;
  const found = await search.execute({ query: "original observation" }, f.context);
  expect(found.status).toBe("succeeded");
  const match = JSON.parse(found.raw).matches[0]; expect(match.receiptKey).toBe("effect:first");
  const read = await f.tool.execute({ receiptKey: match.receiptKey, digest: match.digest, offset: match.offset }, f.context);
  expect(JSON.parse(read.raw).content).toContain("original observation"); expect(f.effects()).toBe(1);
  f.service.withdraw("effect:first", "no longer applicable");
  expect(JSON.parse((await search.execute({ query: "original" }, f.context)).raw).matches).toEqual([]);
});

it("uses the shipped Scenario receipt grant for retained clues and withdraws them without replay",async()=>{
  const f=await fixture(true);
  // Exercise the real declared origin allow-list with a persisted ordinary result.
  f.inventory.sources[0].source="scenario:web_blackbox@1";
  f.inventory.providers[0].tool.source="scenario:web_blackbox@1";
  await f.persist("web",f.inventory.providers[0].tool,{status:"succeeded",summary:"Observation",raw:text,refs:["web-ref"],retryable:false});
  expect((await f.tool.execute({receiptKey:"effect:web"},f.context)).status).toBe("succeeded");
  const graph={caseId:"case",nodes:[{id:"clue",caseId:"case",runId:"run",kind:"fact",status:"active",summary:"Earlier clue",properties:{contextAnchor:{refs:["web-ref"]}}}],edges:[]} as any;
  for(const role of ["worker","planner","observer"] as const){
    const sources=await f.service.lineage(f.control.runtime.load("run")!,role,"work");
    expect(projectContextAnchors(graph,"run",new Set(sources.filter(s=>s.valid).flatMap(s=>s.refs))).entries).toHaveLength(1);
  }
  f.service.withdraw("effect:web","No longer applicable");
  const sources=await f.service.lineage(f.control.runtime.load("run")!,"worker","work");
  expect(projectContextAnchors(graph,"run",new Set(sources.filter(s=>s.valid).flatMap(s=>s.refs))).entries).toEqual([]);
  expect((await f.receipts.get("effect:web"))!.raw).toBe(text);
  expect(f.effects()).toBe(1);
});

it("does not widen a declared namespace denial into exact-key access",async()=>{
  const f=await fixture(false,true);
  expect(()=>new SqliteScenarioAuthorizationService(f.sqlite,f.packages).requireRun(f.control.runtime.load("run")!)).not.toThrow();
  expect((await f.tool.execute({receiptKey:"effect:first"},f.context)).status).toBe("failed");
});

it.each(["scope","contract","retired","unavailable","withdrawal","case","run","work","lease"])("rejects %s and retains the audit original",async mode=>{
  const f=await fixture();await f.tool.execute({receiptKey:"effect:first"},f.context);
  if(mode==="scope")f.sqlite.prepare("UPDATE scenario_authorizations SET status='revoked'").run();
  if(mode==="contract")f.inventory.providers[0].tool.version="2";
  if(mode==="retired")f.inventory.providers[0].lifecycle="retired";
  if(mode==="unavailable")f.inventory.providers[0].health="unavailable";
  if(mode==="withdrawal")f.service.withdraw("effect:first","Withdrawn by host");
  const context={...f.context,...(["case","run","work","lease"].includes(mode)?{[`${mode}Id`]:"other"}:{})};
  expect(await f.tool.execute({receiptKey:"effect:first"},context)).toMatchObject({status:"failed",raw:""});
  expect((await f.receipts.get("effect:first"))!.raw).toBe(text);expect(f.effects()).toBe(1);
});

it("withdraws both original and recall from Worker and role lineage, while preserving receipts",async()=>{
  const f=await fixture();const recalled=await f.tool.execute({receiptKey:"effect:first"},f.context);await f.persist("recall",f.tool,recalled);
  const source=new PackageContextDiscoverySource(f.packages,new SqlitePackageContextStore(f.sqlite),f.sqlite,id=>f.control.runtime.load(id)??null);
  const runContext=new RunContextPolicy(f.sqlite,source,id=>f.control.runtime.load(id)??null,new SqliteCognitiveSnapshotStore(f.sqlite),f.service);
  const policy=new PackageContextPolicy(f.sqlite,source,runContext,f.service);
  let run=f.control.runtime.load("run")!;
  run=f.control.runtime.execute({runId:run.id,commandId:"followup",expectedRevision:run.revision,
    command:{type:"propose_work",proposal:{id:"followup",kind:"observe",title:"Derived work",objective:text,idempotencyKey:"followup-effect"},at:run.updatedAt}}).state;
  f.sqlite.prepare("INSERT INTO context_derivations VALUES ('case','run','work','followup','fixture-snapshot',?)").run(JSON.stringify(["effect:first","effect:recall"]));
  const request={turnId:"turn",worker:{id:"worker"},assignment:{runId:"run",leaseId:"lease",leaseExpiresAt:"2099-01-01",work:run.workItems[0],
    runContext:{caseId:"case",scopeRef:"scope",directives:[]}},transcript:[{turn:1,kind:"tool",summary:"forged",refs:[],receiptKey:"effect:first"},
    {turn:2,kind:"tool",summary:"forged recall",refs:[],receiptKey:"effect:recall"}],steering:[]} as unknown as WorkerModelRequest;
  expect(JSON.stringify((await policy.prepare(request)).request)).toContain("original observation");
  f.service.withdraw("effect:first","Source no longer applicable");
  expect(JSON.stringify((await policy.prepare(request)).request)).not.toContain("original observation");
  const legacy=structuredClone(request);for(const entry of legacy.transcript) {delete entry.receiptKey;entry.summary=text;}
  expect(JSON.stringify((await policy.prepare(legacy)).request)).not.toContain("original observation");
  const projected=await runContext.prepare({run,graph:{caseId:"case",revision:0,nodes:[],edges:[],createdAt:"",updatedAt:""},recentEvents:[]},"planner");
  expect(projected.manifest.contextLineage.sources).toHaveLength(2);
  expect(projected.manifest.contextLineage.sources.every(source=>!source.valid)).toBe(true);
  expect(projected.manifest.contextLineage.withheldWorkIds).toContain("followup");
  expect(JSON.stringify(projected.run.workItems.find(work=>work.id==="followup"))).not.toContain("original observation");
  expect((await f.receipts.get("effect:recall"))!.raw).toBe(recalled.raw);
});

it("closes withdrawal races during asynchronous storage reads and forbids recursive recall",async()=>{
  const f=await fixture();const recalled=await f.tool.execute({receiptKey:"effect:first"},f.context);await f.persist("recall",f.tool,recalled);
  expect(await f.tool.execute({receiptKey:"effect:recall"},f.context)).toMatchObject({status:"failed",raw:""});
  const get=SqliteToolReceiptStore.prototype.get;
  vi.spyOn(SqliteToolReceiptStore.prototype,"get").mockImplementation(async function(this:SqliteToolReceiptStore,key){
    const value=await get.call(this,key);f.service.withdraw("effect:first","Withdrawn during read");return value;
  });
  expect(await f.tool.execute({receiptKey:"effect:first"},f.context)).toMatchObject({status:"failed",raw:""});
});

it.each(["action","reader","resource"])("requires independent %s access",async mode=>{
  const f=await fixture();
  f.pkg.authorizationPolicy={parseScope:payload=>({payload,allowedActions:mode==="action"?["fixture.read"]:["fixture.read","tool.recall"],deniedActions:[]}),
    authorizeResource:(_scope,kind,value)=>{if(kind===(mode==="reader"?"tool.receipt.reader":"tool.receipt"))throw new Error("Denied");return value;}};
  expect(await f.tool.execute({receiptKey:"effect:first"},f.context)).toMatchObject({status:"failed",raw:""});
});

it("runs ordinary tool → recall → completion through HTTP Gateway with one original effect",async()=>{
  let turns=0;
  const h=await foundationHost({foundation:{scenarioPackageRegistry:new ScenarioPackageRegistry([recallPackage(["fixture.read","tool.recall"])])},model:async args=>{
    const c=JSON.parse(args.user);turns++;
    if(turns===1)return {type:"invoke_tool",invocation:{id:"first",tool:"fixture.read",input:{candidate:"first candidate"},rationale:"Observe"}};
    if(turns===2){
      expect(h.sqlite.prepare("SELECT count(*) AS n FROM tool_receipt_context_sources").get()).toEqual({n:1});
      return {type:"invoke_tool",invocation:{id:"recall",tool:"tool.recall",input:{receiptKey:c.transcript.find((entry:any)=>entry.kind==="tool").receiptKey},rationale:"Recall"}};
    }
    expect(args.user).toContain("untrusted_observation");return {type:"complete",summary:"Reference recovered",outputs:[]};
  }});cleanup.push(()=>h.close());await h.start();await eventually(async()=>(await h.state()).workItems[0]?.status==="completed");
  expect(turns).toBe(3);expect(h.calls()).toBe(1);
  expect(h.sqlite.prepare("SELECT count(*) AS n FROM worker_tool_receipts").get()).toEqual({n:2});
});
