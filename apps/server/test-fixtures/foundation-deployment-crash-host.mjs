import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { FoundationDeploymentControl } from "../src/foundation-deployment.ts";

const [root, phase] = process.argv.slice(2), audit = new Database(join(root, "audit.sqlite"));
const { request, current } = JSON.parse(readFileSync(join(root, "deployment-crash.json"), "utf8"));
const allow = { async authorize() { return { decision: "allowed", authorizationRef: "crash-host-review", expiresAt: "2099-01-01T00:00:00.000Z" }; } };
const control = new FoundationDeploymentControl({ auditDb: audit, controlRoot: join(root, "control"), authorizer: allow, currentInventory: () => current, startupContext: { databasePath: join(root, "active.sqlite") } });
audit.function("crash_deployment", () => process.kill(process.pid, "SIGKILL"));
if (phase === "stage_started") audit.exec("CREATE TEMP TRIGGER crash AFTER INSERT ON foundation_deployment_events WHEN NEW.event_type='stage_started' BEGIN SELECT crash_deployment();END");
if (phase === "stage_published") audit.exec("CREATE TEMP TRIGGER crash BEFORE INSERT ON foundation_deployment_events WHEN NEW.event_type='staged' BEGIN SELECT crash_deployment();END");
if (phase === "switch_prepared") audit.exec("CREATE TEMP TRIGGER crash AFTER INSERT ON foundation_deployment_events WHEN NEW.event_type='switch_prepared' BEGIN SELECT crash_deployment();END");
if (phase === "switch_published") audit.exec("CREATE TEMP TRIGGER crash BEFORE INSERT ON foundation_deployment_events WHEN NEW.event_type='switch_completed' BEGIN SELECT crash_deployment();END");
await control.execute(request);
process.kill(process.pid, "SIGKILL");
