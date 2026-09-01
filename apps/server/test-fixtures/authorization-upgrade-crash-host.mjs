import { database } from "../src/test-fixtures/execution-recovery.ts";
import { migrationFixture } from "../src/test-fixtures/run-migration.ts";
import { ScenarioAuthorizationUpgradeControl } from "../src/scenario-authorization-upgrade.ts";

const [path,phase]=process.argv.slice(2),sqlite=database(path),f=migrationFixture(sqlite);
const control=new ScenarioAuthorizationUpgradeControl(sqlite,f.packages,{assertTrusted(){},authorizer:{async authorize(){return {decision:"allowed",authorizationRef:"reviewed",expiresAt:"2099-01-01T00:00:00.000Z"};}}});
const input={caseId:"case",scopeRef:"scope",expectedRevision:1,target:f.to},preview=control.preview(input);
if(!preview.eligible)throw new Error(preview.blockers.join(","));
sqlite.function("crash_policy_upgrade",()=>process.kill(process.pid,"SIGKILL"));
if(phase==="binding")sqlite.exec("CREATE TEMP TRIGGER crash AFTER UPDATE ON scenario_authorization_bindings BEGIN SELECT crash_policy_upgrade(); END");
if(phase==="audit")sqlite.exec("CREATE TEMP TRIGGER crash AFTER INSERT ON scenario_authorization_upgrades BEGIN SELECT crash_policy_upgrade(); END");
await control.upgrade({...input,commandId:"upgrade",actor:"operator",reason:"Upgrade",planFingerprint:preview.planFingerprint});
process.kill(process.pid,"SIGKILL");
