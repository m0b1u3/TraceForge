import { readFileSync } from "node:fs";
import { join } from "node:path";
import { database } from "../src/test-fixtures/execution-recovery.ts";
import { migrationPackages } from "../src/test-fixtures/run-migration.ts";
import { ScenarioPackageRegistry } from "@traceforge/scenario-sdk";
import { ScenarioPackageTrustControl } from "../src/scenario-package-trust.ts";

const [root,phase]=process.argv.slice(2),{installation,authority}=JSON.parse(readFileSync(join(root,"fixture.json"),"utf8")),sqlite=database(join(root,"state.db"));
const p=migrationPackages();new ScenarioPackageTrustControl(sqlite,new ScenarioPackageRegistry());
sqlite.function("crash_package_trust",()=>process.kill(process.pid,"SIGKILL"));
if(phase==="enrollment")sqlite.exec("CREATE TEMP TRIGGER crash AFTER INSERT ON scenario_package_materials BEGIN SELECT crash_package_trust(); END");
const control=new ScenarioPackageTrustControl(sqlite,new ScenarioPackageRegistry([p.source]),{installations:[installation],authority:()=>authority,
  assertAssembly(pkg,review){if(pkg!==p.source || review.assemblyRef!=="fixture-reviewed-object")throw new Error("Unexpected fixture assembly");},
  revokeAuthorizer:{async authorize(){return {decision:"allowed",authorizationRef:"reviewed",expiresAt:"2099-01-01T00:00:00.000Z"};}}});
if(control.snapshot().packages[0].status!=="reviewed_available")throw new Error(JSON.stringify(control.snapshot()));
if(phase==="revocation")sqlite.exec("CREATE TEMP TRIGGER crash AFTER INSERT ON scenario_package_revocations BEGIN SELECT crash_package_trust(); END");
await control.revoke({commandId:"withdraw",package:p.from,actor:"operator",reason:"Withdraw"});process.kill(process.pid,"SIGKILL");
