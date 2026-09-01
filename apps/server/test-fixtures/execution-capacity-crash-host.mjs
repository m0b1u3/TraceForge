import { ToolProviderFairScheduler } from "@traceforge/worker-runtime";
import { database, initialize, at } from "../src/test-fixtures/execution-recovery.ts";
import { ManagedExecutionCapacity } from "../src/managed-execution-capacity.ts";

const [path, phase] = process.argv.slice(2);
const sqlite = database(path), c = initialize(sqlite);
await c.bindings.prepare({idempotencyKey:"call",invocationId:"first",tool:{name:"observe",source:"neutral",version:"1",contractFingerprint:"a".repeat(64)},
  inputFingerprint:"b".repeat(64),attribution:{caseId:"case",runId:"run",workId:"work"}});
await c.bindings.beginExecution("call","lease","worker");
const scheduler = new ToolProviderFairScheduler({global:1});
const capacity = new ManagedExecutionCapacity(sqlite,scheduler,c.bindings,()=>at);
const identity = {providerId:"neutral.provider",providerVersion:"v2",toolName:"observe",caseId:"case",runId:"run",workId:"work"};
await scheduler.acquire(identity);
capacity.reserve(identity,"neutral",{...identity,idempotencyKey:"call",leaseId:"lease",workerId:"worker"});
function checkpoint() {
  process.stdout.write(JSON.stringify({phase})+"\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,15000);
  throw new Error("Parent did not terminate capacity fixture");
}
if(phase==="reserved")checkpoint();
capacity.beforeStart("call","request");
if(phase==="dispatched")checkpoint();
if(phase==="settlement_uncommitted")sqlite.transaction(()=>{capacity.finish("call",true);checkpoint();})();
throw new Error("Unknown capacity fixture phase");
