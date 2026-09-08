import { createHash, randomUUID } from "node:crypto";
import { mkdir, lstat, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { ToolExecutionContext } from "@traceforge/worker-runtime";

const key = (owner: ToolExecutionContext) => createHash("sha256").update(JSON.stringify([
  owner.caseId, owner.runId, owner.workId, owner.leaseId, owner.idempotencyKey,
])).digest("hex");
type Row = { id: string; root: string; name: string; state: string; process_key: string };

/** Single-host durable allocation journal. A missing/unknown process is never
 * evidence of termination. Only journaled exact children are removed. */
export class BrowserScratchStore {
  constructor(private readonly sqlite: Database.Database) {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS browser_scratch (
      id TEXT PRIMARY KEY, root TEXT NOT NULL, name TEXT NOT NULL, state TEXT NOT NULL,
      process_key TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS browser_scratch_bound BEFORE INSERT ON browser_scratch BEGIN
        SELECT CASE WHEN (SELECT count(*) FROM browser_scratch)>=10000 OR length(NEW.root)>4096
          OR length(NEW.process_key)>2048 THEN RAISE(ABORT,'Browser scratch capacity exceeded') END;
        SELECT execution_physical_admit(execution_floor,maximum_database_bytes,maximum_wal_bytes,8192,'execution')
          FROM execution_physical_policy WHERE id=1;
      END;`);
  }
  async allocate(root: string, owner: ToolExecutionContext) {
    const canonical = await realpath(root), id = key(owner), name = `browser-${randomUUID()}`;
    // Durable intent precedes mkdir, so a crash between them is recoverable.
    this.sqlite.prepare("INSERT INTO browser_scratch VALUES (?,?,?,'prepared',?,?)")
      .run(id, canonical, name, "", new Date().toISOString());
    try { await mkdir(join(canonical, name), { mode: 0o700 }); }
    catch (error) {
      // Never turn a pre-existing path into an allocation owned by this journal.
      if ((error as NodeJS.ErrnoException).code === "EEXIST") this.sqlite.prepare("DELETE FROM browser_scratch WHERE id=?").run(id);
      throw error;
    }
    return join(canonical, name);
  }
  beforeDispatch(owner: ToolExecutionContext, processKey: string) {
    if (typeof processKey !== "string" || !processKey.trim() || processKey.length > 2048) throw new Error("Invalid Browser process identity");
    if (this.sqlite.prepare("UPDATE browser_scratch SET state='dispatched',process_key=? WHERE id=? AND state='prepared'").run(processKey, key(owner)).changes !== 1)
      throw new Error("Browser scratch dispatch is fenced");
  }
  async release(owner: ToolExecutionContext, terminalConfirmed: boolean) {
    if (!terminalConfirmed) return;
    this.sqlite.prepare("UPDATE browser_scratch SET state='terminal' WHERE id=?").run(key(owner));
    const row = this.sqlite.prepare("SELECT * FROM browser_scratch WHERE id=?").get(key(owner)) as Row | undefined;
    if (row) await this.remove(row);
  }
  /** Called once before admitting work after host startup, never during live work. */
  async recover(root: string) {
    const canonical = await realpath(root);
    const rows = this.sqlite.prepare("SELECT * FROM browser_scratch WHERE root=?").all(canonical) as Row[];
    for (const row of rows) {
      if (row.state === "dispatched") {
        const table = this.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='process_execution_occupancy'").get();
        const occupancy = table ? this.sqlite.prepare("SELECT state FROM process_execution_occupancy WHERE process_key=?").all(row.process_key) as { state: string }[] : [];
        if (!occupancy.length || occupancy.some(value => !["released", "terminal_observed"].includes(value.state))) continue;
      } else if (!["prepared", "terminal"].includes(row.state)) continue;
      await this.remove(row);
    }
  }
  private async remove(row: Row) {
    if (!/^[a-f0-9]{64}$/.test(row.id) || !/^browser-[a-f0-9-]{36}$/.test(row.name)
      || await realpath(row.root) !== row.root) throw new Error("Browser scratch identity changed");
    const path = join(row.root, row.name);
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error("Browser scratch is not its allocated directory");
    if (info) await rm(path, { recursive: true, force: false });
    this.sqlite.prepare("DELETE FROM browser_scratch WHERE id=?").run(row.id);
  }
}
