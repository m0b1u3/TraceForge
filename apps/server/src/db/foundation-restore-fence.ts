import type Database from "better-sqlite3";
import { z } from "zod";
import { createHash } from "node:crypto";
import { constants, closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

export const restoreFenceSchema = z.object({
  format: z.literal(1), mode: z.literal("inspection_only"),
  backupId: z.string().min(1).max(80), restoreId: z.string().min(1).max(80),
  manifestDigest: z.string().regex(/^[a-f0-9]{64}$/), restoredAt: z.string().datetime(),
  automaticResume: z.literal(false), externalCleanupCertified: z.literal(false),
}).strict();
export type FoundationRestoreFence = z.infer<typeof restoreFenceSchema>;
function readBounded(path: string, maximum: number) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const stat = fstatSync(fd); if (!stat.isFile() || stat.size > maximum) throw new Error("Invalid restore publication file"); return readFileSync(fd); }
  finally { closeSync(fd); }
}

export function assertNotBackupSource(path: string) {
  if (path !== ":memory:" && existsSync(join(dirname(path), "BACKUP_ONLY"))) throw new Error("Backup source is not a bootable host; use authorized isolated restore");
}
/** Pre-open check: a forged WAL must never be interpreted before the durable fence is inspected. */
export function assertSafeDatabaseOpen(path: string) {
  if (path === ":memory:" || !existsSync(path)) return;
  if (lstatSync(path).isSymbolicLink()) throw new Error("Database path cannot be a symbolic link");
  const root = dirname(path);
  if (!existsSync(join(root, "RESTORE_PENDING"))) return;
  if (["-wal", "-shm", "-journal"].some(suffix => existsSync(path + suffix))) throw new Error("Restored database sidecars are forbidden");
  if (!existsSync(join(root, "READY")) || !existsSync(join(root, "manifest.json"))) throw new Error("Incomplete restore is quarantined");
  const manifest = JSON.parse(readBounded(join(root, "manifest.json"), 128 * 1024).toString()) as { assets?: { id?: unknown }[] };
  const assets = manifest.assets;
  if (!Array.isArray(assets) || assets.length > 128 || assets.some(asset => typeof asset?.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(asset.id)))
    throw new Error("Invalid restore publication manifest");
  const expected = ["READY", "RESTORE_PENDING", "database.sqlite", "manifest.json", ...assets.map(asset => `asset-${asset.id}`)].sort();
  if (JSON.stringify(readdirSync(root).sort()) !== JSON.stringify(expected)) throw new Error("Unexpected restored files or SQLite sidecars");
}
export function assertNoIncompleteRestore(sqlite: Database.Database, fence: FoundationRestoreFence | undefined) {
  if (!fence && sqlite.name !== ":memory:" && existsSync(join(dirname(sqlite.name), "RESTORE_PENDING"))) throw new Error("Incomplete restore is quarantined");
}

export function assertFoundationRestorePublished(sqlite: Database.Database, fence: FoundationRestoreFence) {
  assertSafeDatabaseOpen(sqlite.name);
  if (readBounded(join(dirname(sqlite.name), "READY"), 64).toString() !== fence.manifestDigest
    || createHash("sha256").update(readBounded(join(dirname(sqlite.name), "manifest.json"), 128 * 1024)).digest("hex") !== fence.manifestDigest)
    throw new Error("Restore publication missing or corrupt");
}

/** Called BEFORE schema migrations or any execution-store startup recovery. Corruption fails closed. */
export function readFoundationRestoreFence(sqlite: Database.Database): FoundationRestoreFence | undefined {
  const object = sqlite.prepare("SELECT type FROM sqlite_master WHERE name='foundation_restore_fence'").get();
  if (!object) return undefined;
  const rows = sqlite.prepare("SELECT id,body FROM foundation_restore_fence LIMIT 2").all() as { id: number; body: string }[];
  if (rows.length !== 1 || rows[0]!.id !== 1 || Buffer.byteLength(rows[0]!.body) > 4096) throw new Error("Invalid foundation restore fence");
  return restoreFenceSchema.parse(JSON.parse(rows[0]!.body));
}

export function installFoundationRestoreFence(sqlite: Database.Database, fence: FoundationRestoreFence) {
  const body = JSON.stringify(restoreFenceSchema.parse(fence));
  sqlite.transaction(() => {
    if (readFoundationRestoreFence(sqlite)) throw new Error("Already restored database cannot be activated or refenced");
    sqlite.exec("CREATE TABLE foundation_restore_fence (id INTEGER PRIMARY KEY CHECK(id=1),body TEXT NOT NULL)");
    sqlite.prepare("INSERT INTO foundation_restore_fence VALUES (1,?)").run(body);
    for (const operation of ["INSERT", "UPDATE", "DELETE"]) sqlite.exec(`CREATE TRIGGER foundation_restore_fence_${operation}
      BEFORE ${operation} ON foundation_restore_fence BEGIN SELECT RAISE(ABORT,'Restore inspection fence is permanent'); END;`);
  })();
}
