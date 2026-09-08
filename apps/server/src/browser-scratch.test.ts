import { mkdtempSync, rmSync, existsSync, symlinkSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createDb, getSqliteClient } from "./db/client.js";
import { BrowserScratchStore } from "./browser-scratch.js";
import type { ToolExecutionContext } from "@traceforge/worker-runtime";

const owner = { caseId: "case", runId: "run", workId: "work", leaseId: "lease", idempotencyKey: "invocation" } as ToolExecutionContext;
it("recovers undispatched allocation across database reopen but retains unknown execution", async () => {
  const root = mkdtempSync(join(tmpdir(), "browser-recovery-")), path = join(root, "state.sqlite"), scratch = join(root, "scratch"); mkdirSync(scratch);
  let db = getSqliteClient(createDb(path));
  try {
    let store = new BrowserScratchStore(db);
    const prepared = await store.allocate(scratch, owner);
    db.close(); db = getSqliteClient(createDb(path)); store = new BrowserScratchStore(db);
    await store.recover(scratch); expect(existsSync(prepared)).toBe(false);
    const running = await store.allocate(scratch, owner); store.beforeDispatch(owner, "actual-browser-launch");
    db.close(); db = getSqliteClient(createDb(path)); store = new BrowserScratchStore(db);
    await store.recover(scratch); expect(existsSync(running)).toBe(true);
    await store.release(owner, false); expect(existsSync(running)).toBe(true);
    db.exec("CREATE TABLE process_execution_occupancy (process_key TEXT, state TEXT)");
    db.prepare("INSERT INTO process_execution_occupancy VALUES (?,?)").run("actual-browser-launch", "terminal_observed");
    await store.recover(scratch); expect(existsSync(running)).toBe(false);
    expect(db.prepare("SELECT count(*) AS n FROM browser_scratch").get()).toEqual({ n: 0 });
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
it("does not follow replacement symlinks or clean unjournaled directories", async () => {
  const root = mkdtempSync(join(tmpdir(), "browser-recovery-")), db = getSqliteClient(createDb(":memory:"));
  try {
    const store = new BrowserScratchStore(db), path = await store.allocate(root, owner), other = join(root, "unrelated"); mkdirSync(other);
    rmSync(path, { recursive: true }); symlinkSync(other, path);
    await expect(store.release(owner, true)).rejects.toThrow("allocated directory");
    expect(existsSync(other)).toBe(true);
    rmSync(path); await store.recover(root);
    expect(readdirSync(root)).toEqual(["unrelated"]);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
