import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createDb,getSqliteClient } from "../src/db/client.ts";
import { readFoundationRestoreFence } from "../src/db/foundation-restore-fence.ts";
import { FoundationRecoveryReadinessControl,recoveryDependencySchema } from "../src/foundation-recovery-readiness.ts";
import { FoundationRecoveryActivationControl } from "../src/foundation-recovery-activation.ts";

const [root,phase]=process.argv.slice(2),restored=getSqliteClient(createDb(join(root,"restores","restore","database.sqlite"))),fence=readFoundationRestoreFence(restored),
  audit=new Database(join(root,"recovery-control.sqlite")),request=JSON.parse(readFileSync(join(root,"crash-request.json"),"utf8"));
const sha=value=>createHash("sha256").update(value).digest("hex"),fingerprints=new Map(recoveryDependencySchema.options.map(item=>[item,sha(item)]));
const allow={async authorize(){return{decision:"allowed",authorizationRef:"crash-recovery-review",expiresAt:"2099-01-01T00:00:00.000Z"};}};
const readiness=new FoundationRecoveryReadinessControl(restored,fence,{auditDb:audit,authorizer:allow,currentFingerprint:item=>fingerprints.get(item),verifier:{async verify(){throw new Error("Crash replay must use persisted readiness");}}});
const control=new FoundationRecoveryActivationControl({auditDb:audit,candidateRoot:join(root,"candidates"),controlRoot:join(root,"activation"),authorizer:allow,
  currentFingerprint:item=>fingerprints.get(item),assembler:{async assemble(input){return{decision:"assembled",assemblyRef:`crash:${input.dependency}`,materialFingerprint:input.materialFingerprint};}},maximumBytes:64*1024*1024},restored,fence,readiness);
audit.function("crash_activation",()=>process.kill(process.pid,"SIGKILL"));
if(phase==="prepare_published")audit.exec("CREATE TEMP TRIGGER crash BEFORE INSERT ON foundation_recovery_activation_events WHEN NEW.event_type='prepared' BEGIN SELECT crash_activation();END");
if(phase==="switch_prepared")audit.exec("CREATE TEMP TRIGGER crash AFTER INSERT ON foundation_recovery_activation_events WHEN NEW.event_type='switch_prepared' BEGIN SELECT crash_activation();END");
if(phase==="switch_published")audit.exec("CREATE TEMP TRIGGER crash BEFORE INSERT ON foundation_recovery_activation_events WHEN NEW.event_type='switch_completed' BEGIN SELECT crash_activation();END");
await control.execute(request);
process.kill(process.pid,"SIGKILL");
