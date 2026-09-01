import { database, initialize } from "../src/test-fixtures/execution-recovery.ts";
import { SqliteContextCompactionStore } from "../src/context-compaction-store.ts";
import { SqliteScenarioAgentEventStream } from "../src/scenario-agent-event-stream.ts";
import { AgentAuditProjection } from "../src/agent-audit-projection.ts";

// Parent test kills this bounded, isolated fixture after the indicated durable boundary.
const [path, phase] = process.argv.slice(2);
const sqlite = database(path);
initialize(sqlite);
const store = new SqliteContextCompactionStore(sqlite);
store.prepare({id:"summary",caseId:"case",runId:"run",consumer:"worker",inputFingerprint:"input",protectedFingerprint:"protected",
  sourceFingerprint:"source",compactorVersion:"extract-v1",sourceIds:["/work/summary"],status:"prepared",entries:null,error:null});
store.finish("summary",null,"interrupted");
const stream = new SqliteScenarioAgentEventStream(sqlite);
const projection = new AgentAuditProjection(sqlite,stream);
function checkpoint() {
  process.stdout.write(JSON.stringify({phase})+"\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,15000);
  throw new Error("Parent did not terminate audit crash fixture");
}
if (phase === "source_committed") checkpoint();
if (phase === "batch_uncommitted") sqlite.transaction(() => { projection.reconcile(); checkpoint(); })();
if (phase === "batch_committed") { projection.reconcile(); checkpoint(); }
throw new Error("Unknown audit fixture phase");
