import {afterEach,expect,it} from "vitest";
import type Database from "better-sqlite3";
import {database,at} from "./test-fixtures/execution-recovery.js";
import {migrationFixture} from "./test-fixtures/run-migration.js";
import {DesktopPermissionChange} from "./desktop-permission-change.js";
import {SqliteScenarioAuthorizationService} from "./scenario-authorization.js";
import Fastify from "fastify";
import {ScenarioDefinitionRegistry} from "@traceforge/orchestration-core";
import {HttpWorkerControlPlaneClient,WorkerHost,BoundedOutputDistiller} from "@traceforge/worker-runtime";
import {registerScenarioRoutes} from "./scenario-routes.js";
const databases:Database.Database[]=[];
afterEach(()=>databases.splice(0).forEach(db=>db.close()));
function setup(){const db=database();databases.push(db);const f=migrationFixture(db,{},p=>{
  p.source.authorizationPolicy={format:"traceforge.scenario-scope-policy.v1",allowedActions:["observe"],deniedActions:[],payload:{maximumBytes:32768,maximumDepth:8},resources:[{kind:"resource",payloadPath:["targets"]}],form:{version:1,description:"Scope",fields:[{path:["targets"],label:"Targets",description:"Exact identifiers",type:"string-list",required:false,maximumItems:10,maximumLength:100}]}};
});
  db.exec("INSERT INTO desktop_conversations(id,command_id,case_id,title,created_at) VALUES('conversation','created','case','Neutral','2026-09-08')");
  const authorization=new SqliteScenarioAuthorizationService(db,f.packages),control=new DesktopPermissionChange(db,authorization,f.runtime);
  const request=()=>({commandId:"change",runId:"run",expectedRevision:f.runtime.load("run")!.revision,expectedScopeRevision:authorization.binding("scope")!.revision,scope:{targets:["first"]},reason:"Explicit operator request",confirmed:true});
  return {...f,authorization,control,request};
}
it("changes a paused Run scope atomically, preserves expiry, records previous scope and replays without a second grant",()=>{
  const f=setup(),input=f.request(),before=f.authorization.row("scope","case");
  expect(f.control.read("conversation","run")).toMatchObject({status:"paused",expectedScopeRevision:1});
  const result=f.control.change("conversation",input);
  expect(result).toMatchObject({revision:2,previousScope:{},scope:{targets:["first"]},automaticResume:false,replayed:false});
  expect(f.authorization.authorizeResource("scope","case","observe","resource","first").canonicalValue).toBe("first");
  expect(f.authorization.row("scope","case").expires_at).toBe(before.expires_at);
  expect(f.runtime.load("run")!.status).toBe("paused");
  expect(f.control.change("conversation",input)).toMatchObject({revision:2,replayed:true});
  expect(()=>f.control.change("conversation",{...input,scope:{targets:["second"]}})).toThrow("另一份");
  expect(()=>f.sqlite.exec("DELETE FROM desktop_permission_changes")).toThrow("immutable");
});
it("rejects running, revoked, stale, unconfirmed and cross-conversation requests",()=>{
  const f=setup(),input=f.request();
  expect(()=>f.control.change("missing",input)).toThrow();
  expect(()=>f.control.change("conversation",{...input,confirmed:false})).toThrow();
  expect(()=>f.control.change("conversation",{...input,expectedScopeRevision:2})).toThrow("暂停");
  f.command({type:"resume_run",reason:"Continue",requestedBy:"operator",at});
  expect(()=>f.control.change("conversation",f.request())).toThrow("暂停");
  f.sqlite.prepare("UPDATE scenario_authorizations SET status='revoked' WHERE id='scope'").run();
  expect(()=>f.control.change("conversation",input)).toThrow("revoked");
});
it("rolls back authorization and binding when audit persistence fails",()=>{
  const f=setup();f.sqlite.exec("CREATE TEMP TRIGGER fail_change BEFORE INSERT ON desktop_permission_changes BEGIN SELECT RAISE(ABORT,'injected'); END");
  expect(()=>f.control.change("conversation",f.request())).toThrow("injected");
  expect(f.authorization.requireScope("scope","case").scope.payload).toEqual({});
  expect(f.authorization.binding("scope")!.revision).toBe(1);
});
it.each(["lease","invocation","approval"])("does not change authority while %s remains unsettled",async kind=>{
  const f=setup();
  if(kind==="lease")f.sqlite.prepare("INSERT INTO scenario_work_leases VALUES ('run','work','worker','late','2099-01-01',?)").run(at);
  if(kind==="approval")f.sqlite.prepare("INSERT INTO scenario_work_approvals VALUES ('pending','run','case','work','observe','observe','read_only','Review','ref','pending','worker',NULL,?,NULL)").run(at);
  if(kind==="invocation")await f.bindings.prepare({idempotencyKey:"effect:first",invocationId:"first",tool:{name:"observe",source:"fixture",version:"1",contractFingerprint:"a".repeat(64)},inputFingerprint:"b".repeat(64),attribution:{caseId:"case",runId:"run",workId:"work"}});
  expect(()=>f.control.change("conversation",f.request())).toThrow();expect(f.authorization.binding("scope")!.revision).toBe(1);
});
it("rejects undeclared permission modes rather than saving an ineffective unrestricted flag",()=>{
  const f=setup();expect(()=>f.control.change("conversation",{...f.request(),scope:{targets:["first"],unrestricted:true}})).toThrow("未声明");
  expect(f.authorization.binding("scope")!.revision).toBe(1);
});

function requested() {
  const f=setup();
  f.command({type:"resume_run",reason:"Start",requestedBy:"operator",at});
  f.command({type:"claim_work",workId:"work",leaseId:"second-lease",workerId:"worker",workerRoles:["observer"],workerCapabilities:["observe"],workerCurrentWork:0,workerMaxConcurrentWork:1,leaseExpiresAt:"2099-01-01T00:00:00.000Z",at});
  f.command({type:"checkpoint_work",workId:"work",leaseId:"second-lease",checkpointId:"checkpoint",payloadRef:"checkpoint:permission",progressSummary:"Request persisted",at});
  f.command({type:"block_work",workId:"work",leaseId:"second-lease",reason:"Need another authorized resource",permissionRequest:{id:"request",scope:{targets:["first"]}},at});
  return f;
}
it.each([true,false])("resolves model permission request approved=%s, continues the original checkpoint and replays after restart",approved=>{
  const f=requested();
  expect(()=>f.command({type:"resume_run",reason:"Skip review",requestedBy:"operator",at})).toThrow("permission request");
  expect(f.runtime.load("run")!.status).toBe("paused");
  expect(f.control.read("conversation","run").requests).toMatchObject([{workId:"work",id:"request",status:"pending"}]);
  expect(f.authorization.binding("scope")!.revision).toBe(1);
  const input={...f.request(),scope:approved?{targets:["first"]}:{},resolution:{workId:"work",requestId:"request",approved}};
  const result=f.control.change("conversation",input),run=f.runtime.load("run")!;
  expect(result.automaticResume).toBe(true);expect(run.status).toBe("running");
  expect(run.workItems[0]).toMatchObject({id:"work",status:"queued",resumeFromCheckpoint:true,latestCheckpoint:{payloadRef:"checkpoint:permission"},permissionRequest:{status:approved?"approved":"rejected"}});
  expect(run.directives.at(-1)!.instruction).toContain(approved?"Re-read":"rejected");
  expect(f.authorization.binding("scope")!.revision).toBe(approved?2:1);
  expect(f.authorization.requireRun(run).scope.payload).toEqual(input.scope);
  const reopened=new DesktopPermissionChange(f.sqlite,f.authorization,f.runtime);
  expect(reopened.change("conversation",input)).toMatchObject({replayed:true});
  expect(f.runtime.load("run")!.revision).toBe(run.revision);
  f.command({type:"cancel_run",reason:"Stop after receipt loss",at});
  expect(reopened.change("conversation",input)).toMatchObject({replayed:true});
  expect(f.runtime.load("run")!.status).toBe("cancelled");
});
it("rolls back both resume and scope on audit failure, and rejects expired, cancelled or mismatched requests",()=>{
  const f=requested(),input={...f.request(),resolution:{workId:"work",requestId:"request",approved:true}};
  expect(()=>f.control.change("conversation",{...input,resolution:{...input.resolution,requestId:"other"}})).toThrow("失效");
  f.sqlite.exec("CREATE TEMP TRIGGER fail_permission BEFORE INSERT ON desktop_permission_changes BEGIN SELECT RAISE(ABORT,'injected'); END");
  expect(()=>f.control.change("conversation",input)).toThrow("injected");
  expect(f.runtime.load("run")!.status).toBe("paused");expect(f.authorization.binding("scope")!.revision).toBe(1);
  expect(f.runtime.load("run")!.workItems[0].permissionRequest!.status).toBe("pending");
  f.sqlite.exec("DROP TRIGGER fail_permission");
  f.sqlite.prepare("UPDATE scenario_authorizations SET expires_at='2020-01-01T00:00:00.000Z' WHERE id='scope'").run();
  expect(()=>f.control.change("conversation",input)).toThrow();
  f.sqlite.prepare("UPDATE scenario_authorizations SET expires_at='2099-01-01T00:00:00.000Z' WHERE id='scope'").run();
  f.command({type:"cancel_run",reason:"User stopped",at});
  expect(()=>f.control.change("conversation",{...input,expectedRevision:f.runtime.load("run")!.revision})).toThrow();
});
it.each([true,false])("runs the real Worker HTTP/checkpoint/permission/continuation chain approved=%s",async approved=>{
  const f=setup(),app=Fastify();
  registerScenarioRoutes(app,f.sqlite,{packages:f.packages,definitions:new ScenarioDefinitionRegistry(f.packages.definitions()),now:()=>at});
  await app.ready();
  const transport:typeof fetch=async(url,options)=>{
    const response=await app.inject({method:options?.method as "POST"|"GET",url:new URL(String(url)).pathname,
      ...(options?.body?{payload:String(options.body),headers:{"content-type":"application/json"}}:{})});
    return new Response(response.body,{status:response.statusCode,headers:{"content-type":"application/json"}});
  };
  const client=new HttpWorkerControlPlaneClient("http://local.invalid",transport);
  const worker={id:"worker",roles:["observer"],capabilities:["observe"],maxConcurrentWork:1,status:"online" as const,heartbeatAt:at};
  const gateway={async catalog(){return {tools:[],requestedCapabilities:[],unresolvedCapabilities:[],registryRevision:1};},async execute():Promise<never>{throw new Error("No tool should execute");}};
  try{
    await client.register(worker);
    f.command({type:"resume_run",reason:"Start",requestedBy:"operator",at});
    const claim=(leaseId:string)=>f.command({type:"claim_work",workId:"work",leaseId,workerId:"worker",workerRoles:["observer"],workerCapabilities:["observe"],workerCurrentWork:0,workerMaxConcurrentWork:1,leaseExpiresAt:"2099-01-01T00:00:00.000Z",at});
    claim("request-lease");
    const first=new WorkerHost(worker,client,{async decide(){return {type:"request_permissions",reason:"Need another resource",scope:{targets:["first"]}};}},gateway,{async review(){return {action:"continue"};}},f.checkpoints,new BoundedOutputDistiller());
    expect((await first.execute((await client.assignments("worker"))[0]!)).outcome).toBe("blocked");
    const request=f.control.read("conversation","run").requests[0]!;
    expect(await client.assignments("worker")).toEqual([]);
    expect(f.authorization.requireScope("scope","case").scope.payload).toEqual({});
    f.control.change("conversation",{...f.request(),scope:approved?{targets:["first"]}:{},resolution:{workId:request.workId,requestId:request.id,approved}});
    claim("continued-lease");
    let called=false;
    const restarted=new WorkerHost(worker,client,{async decide(input){called=true;expect(input.steering.join(" ")).toContain(approved?"Re-read":"rejected");return {type:"complete",summary:"Continued the original work",outputs:[]};}},gateway,{async review(){return {action:"continue"};}},f.checkpoints,new BoundedOutputDistiller());
    expect((await restarted.execute((await client.assignments("worker"))[0]!)).outcome).toBe("completed");expect(called).toBe(true);
    expect(f.runtime.load("run")!.workItems).toHaveLength(1);
  }finally{await app.close();}
});
