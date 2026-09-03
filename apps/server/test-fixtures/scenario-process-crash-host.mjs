import { dirname, resolve } from "node:path";
import { LocalExecutionNode, NodeSpawnProcessLauncher, permissionProfileFingerprint, resourceLimitsFingerprint } from "@traceforge/execution-node";
import { SCENARIO_PROCESS_PROTOCOL, ScenarioProcessRuntime, ToolProviderFairScheduler } from "@traceforge/worker-runtime";
import { database } from "../src/test-fixtures/execution-recovery.ts";
import { SqliteProcessExecutionJournal } from "../src/execution-process-journal.ts";
import { ProcessExecutionCapacity } from "../src/process-execution-capacity.ts";
import { SqliteScenarioProcessSupervisionStore } from "../src/scenario-process-supervision.ts";

const [path,mode]=process.argv.slice(2),sqlite=database(path),store=new SqliteScenarioProcessSupervisionStore(sqlite);
const interrupted=store.recoverInterrupted();
const platform=process.platform==="win32"?"windows":process.platform==="darwin"?"darwin":"linux";
const permissions={version:1,platform,filesystem:{read:[{path:dirname(process.execPath),scope:"tree"},{path:resolve("."),scope:"tree"}],write:[],deny:[]},
  network:"deny",process:{access:"sandboxed",interactive:false,background:false},secrets:"deny",sources:["fixture"]};
const resources={cpuTimeMs:60_000,memoryBytes:256*1024*1024,maximumProcesses:2,writeBytes:1024*1024};
const launcher=new NodeSpawnProcessLauncher(request=>({executable:request.executable,arguments:request.arguments,workingDirectory:request.workingDirectory,
  environment:request.environment,detached:false,windowsHide:true,enforcement:{sandboxBackend:"attested-neutral-fixture",sandboxed:true,
    filesystemPolicyApplied:true,permissionProfileFingerprint:permissionProfileFingerprint(request.permissions),resourceLimitsApplied:true,
    resourceLimitsFingerprint:resourceLimitsFingerprint(request.resources),network:"deny"}}));
const node=new LocalExecutionNode(launcher,{platform,sandboxBackends:["attested-neutral-fixture"],processJournal:new SqliteProcessExecutionJournal(sqlite),
  maximumOutputBytesPerProcess:64*1024*1024,capabilities:{process:{spawn:true,stdio:true,tty:false,adoption:true,resourceLimits:true,
    executionObservation:true,signals:["interrupt","terminate","kill"]}}});
const scheduler=new ToolProviderFairScheduler({global:4,perProvider:4,perTool:4,perRun:4,perWork:4}),capacity=new ProcessExecutionCapacity(sqlite,scheduler);
const manifest={protocol:SCENARIO_PROCESS_PROTOCOL,protocolVersion:1,id:"fixture.process-package",version:"1.0.0",source:"scenario:fixture.process-package",
  entrypoint:"package://runtime/main.mjs",providedCapabilities:["fixture.observe"],hostCapabilities:[]};
const attribution={caseId:"foundation",runId:"scenario-services",workId:"fixture.process-package",workerId:"scenario-process-host",scopeRef:"fixture-scope",
  leaseId:"fixture-service",leaseExpiresAt:"2100-01-01T00:00:00.000Z",actionId:"scenario-process.start",idempotencyKey:"scenario-process:fixture.process-package"};
const runtime=new ScenarioProcessRuntime({manifest,capabilityHandlers:[],executionNode:node,supervision:store,
  launch:{executable:process.execPath,arguments:[resolve("apps/server/test-fixtures/scenario-process.mjs")],workingDirectory:resolve("."),
    attribution,permissions,resources,expectedSandboxBackend:"attested-neutral-fixture"},
  processCapacity:{acquire:(generation,current)=>capacity.acquire({source:manifest.source,version:manifest.version,
    operation:`scenario-process:generation:${generation}`,kind:"service",attribution:current})}});
await runtime.discover();
if(mode==="crash"){
  process.stdout.write(JSON.stringify({ready:true,generation:runtime.status().generation,pid:runtime.status().pid})+"\n");
  setInterval(()=>{},1000);
}else if(mode==="recover"){
  await runtime.close();
  process.stdout.write(JSON.stringify({interrupted,generation:runtime.status().generation,snapshot:store.snapshot(manifest),
    occupancies:capacity.list("foundation","scenario-services").items.map(item=>item.state),integrity:sqlite.pragma("integrity_check",{simple:true})})+"\n");
  sqlite.close();
}else throw new Error("Unknown Scenario Process crash fixture mode");
