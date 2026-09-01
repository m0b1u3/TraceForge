import { join } from "node:path";
import { createDb, getSqliteClient } from "../src/db/client.ts";
import { FoundationBackupControl } from "../src/foundation-backup.ts";
const [root, phase, manifestDigest] = process.argv.slice(2);
const sqlite = getSqliteClient(createDb(join(root, "source.sqlite")));
const control = new FoundationBackupControl(sqlite, { backupRoot: join(root, "backups"), restoreRoot: join(root, "restores"),
  authorizer: { async authorize() { return { decision: "allowed", authorizationRef: "crash-fixture", expiresAt: "2099-01-01T00:00:00.000Z" }; } } });
sqlite.function("crash_backup", () => process.kill(process.pid, "SIGKILL"));
if (phase !== "completed") sqlite.exec(`CREATE TEMP TRIGGER crash ${phase === "published" ? "BEFORE" : "AFTER"} INSERT ON foundation_backup_audits
  WHEN NEW.command_id='restore1' AND NEW.phase='${phase === "prepared" ? "prepared" : "completed"}' BEGIN SELECT crash_backup(); END`);
await control.execute({ commandId: "restore1", operation: "restore", backupId: "backup1", manifestDigest, actor: "operator", reason: "Disaster recovery rehearsal" });
process.kill(process.pid, "SIGKILL");
