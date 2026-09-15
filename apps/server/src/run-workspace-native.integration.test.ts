import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalExecutionNode, MacosProcessLauncher } from "@traceforge/execution-node";
import { RunWorkspace, type ToolExecutionContext } from "@traceforge/worker-runtime";
import { ExecutionNodeProcessTool } from "./worker-execution-adapters.js";
import Database from "better-sqlite3";
import { WorkspaceJobs } from "./workspace-jobs.js";
import { SqliteProcessOperationJournal } from "./execution-process-operation-journal.js";
import { createDb, getSqliteClient } from "./db/client.js";
import Fastify from "fastify";
import { registerConversationRoutes } from "./conversation-routes.js";
import { ConversationWorkspaces } from "./conversation-workspaces.js";

describe.skipIf(process.env.TRACEFORGE_TEST_MACOS_SEATBELT !== "1")("Run Workspace through real macOS native execution", () => {
  let root: string, node: LocalExecutionNode, workspace: RunWorkspace, operations: Database.Database;
  beforeAll(() => {
    expect(process.platform).toBe("darwin"); expect(process.arch).toBe("arm64");
    root = realpathSync(mkdtempSync(join(tmpdir(), "traceforge-workspace-native-")));
    const path = realpathSync(resolve("packages/execution-node/native/darwin-arm64/traceforge-macos-sandbox"));
    const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
    operations = getSqliteClient(createDb(join(root, "operations.sqlite")));
    node = new LocalExecutionNode(new MacosProcessLauncher({ path, sha256 }), { platform: "darwin", architecture: "arm64",
      sandboxBackends: ["traceforge-macos-native"], sandboxMeasurements: { "traceforge-macos-native": sha256 }, acceptedSampledResourceBackends: ["traceforge-macos-native"], operationJournal: new SqliteProcessOperationJournal(operations),
      capabilities: { process: { spawn: true, stdio: true, tty: true, adoption: true, resourceLimits: false, resourcePolicy: "sampled_terminate", signals: ["interrupt", "terminate", "kill"] } } });
    workspace = new RunWorkspace(join(root, "runs"), new ExecutionNodeProcessTool(node), () => {}, undefined, undefined, () => 180);
  });
  afterAll(async () => { if (node) await node.shutdown(); operations?.close(); if (root) rmSync(root, { recursive: true, force: true }); });
  it("reuses an automatically created conversation directory across native Run execution and reload",async()=>{
    const db=createDb(":memory:"),sql=getSqliteClient(db),app=Fastify();
    const storage=new ConversationWorkspaces(sql,root);
    registerConversationRoutes(app,db,storage);
    try{
      const response=await app.inject({url:"/api/desktop/conversations",method:"POST",payload:{commandId:"native-conversation",title:"Shared task files"}});
      expect(response.statusCode).toBe(201);
      const conversation=response.json();
      storage.bind(conversation.id,conversation.caseId,"first");storage.bind(conversation.id,conversation.caseId,"second");
      const make=()=>new RunWorkspace(storage.base,new ExecutionNodeProcessTool(node),()=>{},undefined,undefined,()=>60,(c,r)=>new ConversationWorkspaces(sql,root).key(c,r));
      let shared=make();
      const invoke=async(runId:string,op:string,input:unknown)=>shared.tools().find(t=>t.name===`workspace_${op}`)!.execute(input,{
        caseId:conversation.caseId,runId,workId:"work",workerId:"worker",scopeRef:"scope",leaseId:"lease",leaseExpiresAt:new Date(Date.now()+120000).toISOString(),idempotencyKey:randomUUID(),
        effectivePermissions:{...shared.profile(conversation.caseId,runId,`workspace_${op}`,true),sources:["native-test"]},
      });
      const file=JSON.parse((await invoke("first","write",{path:"run.sh",content:"printf saved > result.txt",expectedDigest:null})).raw);
      expect((await invoke("first","execute",{path:"run.sh",expectedDigest:file.digest})).status).toBe("succeeded");
      shared=make();
      const result=JSON.parse((await invoke("second","read",{path:"result.txt"})).raw);
      expect(result.content).toBe("saved");
      await invoke("second","edit",{path:"result.txt",before:"saved",after:"continued",expectedDigest:result.digest});
      expect(JSON.parse((await invoke("first","read",{path:"result.txt"})).raw).content).toBe("continued");
      expect(shared.root(conversation.caseId,"first")).toBe(storage.root(conversation.caseId,"second"));
    }finally{await app.close();sql.close();}
  },20000);
  async function call(op: string, input: unknown, runId = "run") {
    const context: ToolExecutionContext = { caseId: "case", runId, workId: "work", workerId: "worker", scopeRef: "scope", leaseId: "lease",
      leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(), idempotencyKey: randomUUID(),
      effectivePermissions: { ...workspace.profile("case", runId, `workspace_${op}`, true), sources: ["native-test"] } };
    return workspace.tools().find(tool => tool.name === `workspace_${op}`)!.execute(input, context);
  }
  it("writes, runs, reads output, edits and reruns without a model or unrestricted launcher", async () => {
    const first = JSON.parse((await call("write", { path: "scripts/run.sh", content: "printf first > result.txt\nprintf first", expectedDigest: null })).raw);
    expect(await call("execute", { path: "scripts/run.sh", expectedDigest: first.digest })).toMatchObject({ status: "succeeded", raw: "first", metadata: { enforcement: { network: "deny", processTreeEmptyBarrier: true } } });
    expect(JSON.parse((await call("read", { path: "result.txt" })).raw).content).toBe("first");
    const second = JSON.parse((await call("write", { path: "scripts/run.sh", content: "printf second > result.txt\nprintf second", expectedDigest: first.digest })).raw);
    expect(await call("execute", { path: "scripts/run.sh", expectedDigest: second.digest })).toMatchObject({ status: "succeeded", raw: "second" });
    expect(JSON.parse((await call("read", { path: "result.txt" })).raw).content).toBe("second");
  }, 20_000);
  it("returns before native exit, reads live output, and stops the same owned script", async () => {
    const sqlite = new Database(":memory:"); let jobs!: WorkspaceJobs;
    const processTool = new ExecutionNodeProcessTool(node, undefined, undefined, undefined, {
      started: (c, access) => jobs.started(c, access), output: (c, text) => jobs.output(c, text),
    });
    const asynchronous = new RunWorkspace(join(root, "async"), processTool, () => {});
    jobs = new WorkspaceJobs(sqlite, asynchronous, () => {}, access => node.terminateProcess({ ...access, operationId: `stop:${access.processId}`, force: true }), () => true);
    const ctx: ToolExecutionContext = { caseId: "case", runId: "async", workId: "work", workerId: "worker", scopeRef: "scope", leaseId: "lease", leaseExpiresAt: new Date(Date.now() + 120000).toISOString(), idempotencyKey: "async-start",
      effectivePermissions: { ...asynchronous.profile("case", "async", "workspace_start", true), sources: ["native-test"] } };
    try {
      const file = JSON.parse((await asynchronous.tools().find(t => t.name === "workspace_write")!.execute({ path: "run.sh", content: "printf ready\n/bin/sleep 15\nprintf unexpected", expectedDigest: null }, ctx)).raw);
      const invoke = async (name: string, input: unknown) => JSON.parse((await jobs.tools().find(t => t.name === name)!.execute(input, ctx)).raw);
      const at = Date.now(); const started = await invoke("workspace_start", { path: "run.sh", expectedDigest: file.digest });
      expect(Date.now() - at).toBeLessThan(2000);
      const live = await invoke("workspace_poll", { handle: started.handle, waitSeconds: 5 });
      expect(live.state).toBe("running"); expect(live.output).toContain("ready");
      await expect(asynchronous.tools().find(t => t.name === "workspace_read")!.execute({ path: "run.sh" }, ctx)).rejects.toThrow(/busy|reconciliation/);
      await invoke("workspace_stop", { handle: started.handle });
      const terminal = await invoke("workspace_poll", { handle: started.handle, cursor: live.nextCursor, waitSeconds: 5 });
      expect(terminal.state).toBe("completed");
      expect(terminal.terminalResult.metadata.enforcement.processTreeEmptyBarrier).toBe(true);
      expect(terminal.terminalResult.raw).not.toContain("unexpected");
      expect(jobs.pending("async", "work")).toBe(false);
    } finally { await jobs.close(); sqlite.close(); }
  }, 20000);
  it("runs the workspace terminal input journey with ownership, approval profile and replay checks", async () => {
    const sqlite = new Database(":memory:"); let jobs!: WorkspaceJobs;
    const processTool = new ExecutionNodeProcessTool(node, undefined, undefined, undefined, {
      started: (c,a)=>jobs.started(c,a), output:(c,text)=>jobs.output(c,text),
    });
    const space = new RunWorkspace(join(root,'terminal'),processTool,()=>{});
    jobs = new WorkspaceJobs(sqlite,space,()=>{},a=>node.terminateProcess({...a,operationId:`stop:${a.processId}`,force:true}),()=>true,
      async (a,c,input)=>{const operationId=`input:${c.idempotencyKey}`;
        if(input.columns!==undefined)await node.resizeProcessTerminal({...a,operationId,columns:input.columns,rows:input.rows!});
        else await node.writeProcessInput({...a,operationId,dataBase64:Buffer.from(input.text??'').toString('base64'),closeAfterWrite:input.eof===true});
      });
    const ctx:ToolExecutionContext={caseId:'case',runId:'terminal',workId:'work',workerId:'worker',scopeRef:'scope',leaseId:'lease',leaseExpiresAt:new Date(Date.now()+120000).toISOString(),idempotencyKey:'start-terminal',
      effectivePermissions:{...space.profile('case','terminal','workspace_start',true,false,true),sources:['native-test']}};
    const invoke=async(name:string,input:unknown,c=ctx)=>JSON.parse((await jobs.tools().find(t=>t.name===name)!.execute(input,c)).raw);
    try {
      const file=JSON.parse((await space.tools().find(t=>t.name==='workspace_write')!.execute({path:'input.sh',content:'test -t 0 || exit 8\nprintf ready\\n\nread -r value\nprintf "VALUE:%s\\n" "$value"',expectedDigest:null},ctx)).raw);
      const started=await invoke('workspace_start',{path:'input.sh',expectedDigest:file.digest,terminal:true});
      let view=await invoke('workspace_poll',{handle:started.handle,waitSeconds:3});expect(view.state).toBe('running');
      const payload={handle:started.handle,text:'hello'};
      await expect(invoke('workspace_input',payload,{...ctx,leaseId:'other'})).rejects.toThrow('belong');
      await expect(invoke('workspace_input',payload,{...ctx,effectivePermissions:{...ctx.effectivePermissions,process:{...ctx.effectivePermissions.process,interactive:false}}})).rejects.toThrow('authorized');
      await invoke('workspace_input',{handle:started.handle,columns:100,rows:30},{...ctx,idempotencyKey:'size'});
      await invoke('workspace_input',payload,{...ctx,idempotencyKey:'text'});
      await invoke('workspace_input',payload,{...ctx,idempotencyKey:'text'});
      await invoke('workspace_input',{handle:started.handle,text:'\n'},{...ctx,idempotencyKey:'newline'});
      for(let i=0;i<50&&!view.terminalResult;i++){await new Promise(resolve=>setTimeout(resolve,20));view=await invoke('workspace_poll',{handle:started.handle,cursor:view.nextCursor,waitSeconds:1});}
      expect(view.terminalResult.raw).toContain('VALUE:hello');expect(view.terminalResult.raw).not.toContain('VALUE:hellohello');
      expect(view.terminalResult.metadata.enforcement.processTreeEmptyBarrier).toBe(true);
      expect(JSON.stringify(sqlite.prepare('SELECT * FROM workspace_jobs').all())).not.toContain('adoptionToken');
    } finally {await jobs.close();sqlite.close();}
  },20000);
  it.skipIf(process.env.TRACEFORGE_TEST_LONG_SCRIPT !== "1")("runs beyond the former 60 second ceiling with native cleanup proof", async () => {
    const file = JSON.parse((await call("write", { path: "long.sh", content: "/bin/sleep 65\nprintf completed", expectedDigest: null }, "long")).raw);
    const started = Date.now();
    const result = await call("execute", { path: "long.sh", expectedDigest: file.digest, timeoutSeconds: 90 }, "long");
    expect(Date.now() - started).toBeGreaterThan(60000);
    expect(result).toMatchObject({ status: "succeeded", raw: "completed", metadata: { enforcement: { network: "deny", processTreeEmptyBarrier: true } } });
  }, 110_000);
  it("denies reading and writing outside the Run, including another Run", async () => {
    const outside = join(root, "private.txt"); writeFileSync(outside, "never-disclose");
    await call("write", { path: "other.txt", content: "another-run-secret", expectedDigest: null }, "other");
    const script = JSON.parse((await call("write", { path: "boundary.sh", content: 'if /bin/cat "$1"; then exit 9; fi\nif printf changed > "$1"; then exit 10; fi\nprintf denied', expectedDigest: null })).raw);
    for (const path of [outside, join(workspace.root("case", "other"), "other.txt")]) {
      const result = await call("execute", { path: "boundary.sh", expectedDigest: script.digest, arguments: [path] });
      expect(result.status).toBe("succeeded"); expect(result.raw).toContain("denied");
      expect(result.raw).not.toMatch(/never-disclose|another-run-secret/);
    }
    expect(readFileSync(outside, "utf8")).toBe("never-disclose");
  }, 20_000);
});
