import { ToolProviderFairScheduler } from "@traceforge/worker-runtime";
import { database, at } from "../src/test-fixtures/execution-recovery.ts";
import { ProcessExecutionCapacity } from "../src/process-execution-capacity.ts";

const [path,phase]=process.argv.slice(2),sqlite=database(path);
const capacity=new ProcessExecutionCapacity(sqlite,new ToolProviderFairScheduler({global:1}),()=>at);
const lease=await capacity.acquire({source:"neutral",version:"1",operation:"discover",kind:"service",attribution:{
  caseId:"case",runId:"run",workId:"service",workerId:"host",leaseId:"service",leaseExpiresAt:"2099-01-01T00:00:00.000Z",
  scopeRef:"host",actionId:"discover",idempotencyKey:"process"}});
function checkpoint(){
  process.stdout.write(JSON.stringify({phase})+"\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,15000);
  throw new Error("Parent did not terminate process capacity fixture");
}
if(phase==="reserved")checkpoint();
lease.beforeStart("request");
if(phase==="dispatched")checkpoint();
if(phase==="settlement_uncommitted")sqlite.transaction(()=>{lease.finish(true);checkpoint();})();
throw new Error("Unknown crash fixture phase");
