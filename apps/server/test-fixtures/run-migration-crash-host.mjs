import { database } from "../src/test-fixtures/execution-recovery.ts";
import { migrationFixture } from "../src/test-fixtures/run-migration.ts";
const [path,phase]=process.argv.slice(2),sqlite=database(path),fixture=migrationFixture(sqlite),request=await fixture.request();
const stop=()=>process.kill(process.pid,"SIGKILL");
if(phase!=="committed"){
  sqlite.function("migration_crash",()=>{stop();return 0;});
  sqlite.exec(phase==="projection"?
    "CREATE TEMP TRIGGER crash_projection AFTER UPDATE OF scenario_package_version ON scenario_event_streams BEGIN SELECT migration_crash(); END":
    "CREATE TEMP TRIGGER crash_audit AFTER INSERT ON scenario_run_migrations BEGIN SELECT migration_crash(); END");
}
await fixture.control.migrate(request);stop();
