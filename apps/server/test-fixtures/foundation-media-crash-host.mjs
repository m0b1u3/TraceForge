import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createDb,getSqliteClient } from "../src/db/client.ts";
import { FoundationBackupControl } from "../src/foundation-backup.ts";
import { FoundationOfflineMediaControl } from "../src/foundation-offline-media.ts";
const [root,phase,manifestDigest]=process.argv.slice(2),sqlite=getSqliteClient(createDb(join(root,"control.sqlite"))),allow={async authorize(){return{decision:"allowed",authorizationRef:"crash-review",expiresAt:"2099-01-01T00:00:00.000Z"};}};
const backups=new FoundationBackupControl(sqlite,{backupRoot:join(root,"backups"),restoreRoot:join(root,"restores"),authorizer:allow,minimumFreeBytes:1});
const media=new FoundationOfflineMediaControl(sqlite,backups,{mediaRoot:join(root,"media"),signingKeyId:"signer",signingPrivateKeyPem:readFileSync(join(root,"signing.pem"),"utf8"),
  encryptionKeyId:"cipher",encryptionKey:()=>readFileSync(join(root,"encryption.key")),authority:()=>({publicKeyPem:readFileSync(join(root,"public.pem"),"utf8"),validFrom:"2026-01-01T00:00:00.000Z",validUntil:"2099-01-01T00:00:00.000Z"}),authorizer:allow,chunkBytes:65536,minimumFreeBytes:1});
sqlite.function("crash_media",()=>process.kill(process.pid,"SIGKILL"));
if(phase!=="completed")sqlite.exec(`CREATE TEMP TRIGGER crash ${phase==="published"?"BEFORE":"AFTER"} INSERT ON foundation_media_audits
  WHEN NEW.command_id='crash_export' AND NEW.phase='${phase==="prepared"?"prepared":"completed"}' BEGIN SELECT crash_media();END`);
await media.execute({commandId:"crash_export",operation:"export",mediaId:"crash_media",backupId:"backup1",backupManifestDigest:manifestDigest,actor:"operator",reason:"Crash fixture"});
process.kill(process.pid,"SIGKILL");
