import type Database from "better-sqlite3";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { managedWorkspacePath } from "@traceforge/worker-runtime";

/** Application ownership mapping only. Core receives an opaque shared key, never
 * a conversation concept or a user-supplied filesystem path. Grants remain per Run. */
export class ConversationWorkspaces {
  readonly base: string;
  constructor(private readonly sql: Database.Database, projectRoot: string) {
    this.base = resolve(projectRoot, "data", "run-workspaces");
    sql.exec(`CREATE TABLE IF NOT EXISTS desktop_conversation_workspaces (
      conversation_id TEXT PRIMARY KEY, case_id TEXT NOT NULL UNIQUE, workspace_key TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS desktop_run_workspaces (
      run_id TEXT PRIMARY KEY, case_id TEXT NOT NULL, workspace_key TEXT NOT NULL);`);
  }
  ensure(conversationId: string, caseId: string): string {
    const owner = this.sql.prepare("SELECT case_id AS caseId FROM desktop_conversations WHERE id=?").get(conversationId) as {caseId:string}|undefined;
    if (owner?.caseId !== caseId) throw new Error("Conversation workspace ownership mismatch");
    const key = `conversation:${conversationId}`;
    const prior = this.sql.prepare("SELECT case_id AS caseId,workspace_key AS key FROM desktop_conversation_workspaces WHERE conversation_id=?").get(conversationId) as {caseId:string;key:string}|undefined;
    if (prior && (prior.caseId !== caseId || prior.key !== key)) throw new Error("Conversation workspace binding changed");
    const path = managedWorkspacePath(this.base, caseId, "creation", key);
    const check = (directory: string): void => {
      if (dirname(directory) !== directory) check(dirname(directory));
      try { if (!lstatSync(directory).isDirectory()) throw new Error("Workspace ancestor is not a plain directory"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    };
    check(path);
    // Do not silently recreate a previously bound directory after deletion.
    if (prior && !existsSync(path)) throw new Error("Conversation workspace is missing; recovery required");
    mkdirSync(path, {recursive:true,mode:0o700});
    if (realpathSync(path) !== path) throw new Error("Workspace path is not canonical");
    this.sql.prepare("INSERT OR IGNORE INTO desktop_conversation_workspaces VALUES(?,?,?)").run(conversationId,caseId,key);
    return path;
  }
  bind(conversationId: string, caseId: string, runId: string): void {
    this.ensure(conversationId,caseId);
    const key = `conversation:${conversationId}`;
    const prior = this.sql.prepare("SELECT case_id AS caseId,workspace_key AS key FROM desktop_run_workspaces WHERE run_id=?").get(runId) as {caseId:string;key:string}|undefined;
    if (prior && (prior.caseId !== caseId || prior.key !== key)) throw new Error("Run workspace ownership mismatch");
    if (!prior && this.sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scenario_event_streams'").get()
      && this.sql.prepare("SELECT 1 FROM scenario_event_streams WHERE run_id=?").get(runId)) return;
    this.sql.prepare("INSERT OR IGNORE INTO desktop_run_workspaces VALUES(?,?,?)").run(runId,caseId,key);
  }
  key(caseId: string, runId: string): string | undefined {
    const row = this.sql.prepare("SELECT case_id AS caseId,workspace_key AS key FROM desktop_run_workspaces WHERE run_id=?").get(runId) as {caseId:string;key:string}|undefined;
    if (row && row.caseId !== caseId) throw new Error("Run workspace ownership mismatch");
    if (row) {
      if (!this.sql.prepare("SELECT 1 FROM desktop_conversation_workspaces WHERE case_id=? AND workspace_key=?").get(caseId,row.key)) throw new Error("Conversation workspace binding is missing");
      const path = managedWorkspacePath(this.base,caseId,runId,row.key);
      if (!existsSync(path) || !lstatSync(path).isDirectory() || realpathSync(path) !== path) throw new Error("Conversation workspace is unavailable; recovery required");
    }
    return row?.key;
  }
  root(caseId: string, runId: string): string {
    return managedWorkspacePath(this.base,caseId,runId,this.key(caseId,runId));
  }
}
