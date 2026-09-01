import { join } from "node:path";
import { database } from "../src/test-fixtures/execution-recovery.ts";
import { migrationFixture } from "../src/test-fixtures/run-migration.ts";
import { ScenarioRunDisposalControl } from "../src/scenario-run-disposal.ts";

const [root, phase] = process.argv.slice(2), sqlite = database(join(root, "state.db"));
migrationFixture(sqlite);
const control = new ScenarioRunDisposalControl(sqlite, { async authorize() {
  return { decision: "allowed", authorizationRef: "fixture-reviewed", expiresAt: "2099-01-01T00:00:00.000Z" };
} });
sqlite.function("crash_disposal", () => process.kill(process.pid, "SIGKILL"));
if (phase === "event" || phase === "audit") sqlite.exec(`CREATE TEMP TRIGGER crash AFTER INSERT ON ${phase === "event" ? "scenario_events" : "scenario_run_disposal_audits"} BEGIN SELECT crash_disposal(); END`);
const input = { caseId: "case", runId: "run", commandId: "stop", operation: "stop", expectedRevision: 4, actor: "operator", reason: "Stop" };
await control.dispose(input);
if (phase === "retire_audit") sqlite.exec("CREATE TEMP TRIGGER crash_retire AFTER INSERT ON scenario_run_disposal_audits WHEN NEW.operation='retire' BEGIN SELECT crash_disposal(); END");
if (phase === "retire" || phase === "retire_audit") await control.dispose({ ...input, operation: "retire", commandId: "retire", expectedRevision: 5 });
process.kill(process.pid, "SIGKILL");
