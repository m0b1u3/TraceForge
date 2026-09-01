import { writeSync } from "node:fs";
import { database } from "../src/test-fixtures/execution-recovery.ts";
import { seedGovernanceHistory, archiveAllow, archiveAt, archiveRequest } from "../src/test-fixtures/governance-history.ts";
import { GovernanceHistoryControl } from "../src/governance-history-control.ts";
const [path,phase,kind]=process.argv.slice(2),sqlite=database(path);
await seedGovernanceHistory(sqlite,"managedCleanup");await seedGovernanceHistory(sqlite,"processCleanup");
function stop(){writeSync(1,JSON.stringify({phase})+"\n");Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20000);throw new Error("Parent did not terminate fixture");}
if(phase!=="committed"){
  sqlite.function("crash_boundary",()=>{stop();return 0;});
  sqlite.exec(phase==="cold-written"?"CREATE TEMP TRIGGER stop_archive AFTER INSERT ON execution_archives BEGIN SELECT crash_boundary(); END":
    `CREATE TEMP TRIGGER stop_archive AFTER UPDATE ON ${kind==="managedCleanup"?"managed_execution_cleanup_audits":"process_cleanup_commands"} BEGIN SELECT crash_boundary(); END`);
}
await new GovernanceHistoryControl(sqlite,archiveAllow,()=>archiveAt).archive(archiveRequest(kind));stop();
