import { createHash, randomUUID } from "node:crypto";
import { canonicalJson } from "@traceforge/orchestration-core";
import type Database from "better-sqlite3";
import type { ProcessAccess } from "@traceforge/execution-node";
import type { ExecutionToolAdapter, ToolExecutionContext, ToolExecutionResult, RunWorkspace } from "@traceforge/worker-runtime";

type Job = { id: string; invocation: string; owner: string; state: string; output: string; result: string | null; collection_key: string | null };
const owner = (c: ToolExecutionContext) => JSON.stringify([c.caseId, c.runId, c.workId, c.scopeRef, c.workerId, c.leaseId]);
const result = (value: unknown): ToolExecutionResult => ({ status: "succeeded", summary: "Workspace process status (not evidence of task completion)", raw: JSON.stringify(value), refs: [], retryable: false });

/** An attributed view of an existing process invocation, not a second scheduler.
 * Native process access tokens remain in Host memory and never enter model output. */
export class WorkspaceJobs {
  private readonly live = new Map<string, { context: ToolExecutionContext; access?: ProcessAccess; stopping?: Promise<unknown>; done: Promise<void> }>();
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;
  private writable = true;
  constructor(private readonly sqlite: Database.Database, private readonly workspace: RunWorkspace,
    private readonly authorize: (context: ToolExecutionContext, start: boolean) => void,
    private readonly terminate: (access: ProcessAccess) => Promise<unknown>,
    private readonly receiptRecorded: (invocation: string, handle: string) => boolean,
    private readonly inputPort?: (access: ProcessAccess, context: ToolExecutionContext, input: { text?: string; columns?: number; rows?: number; interrupt?: boolean; eof?: boolean }) => Promise<void>,
    private readonly progress?: (context: ToolExecutionContext, view: { handle: string; command: string; output: string; terminal?: ToolExecutionResult }) => void) {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS workspace_jobs (
      id TEXT PRIMARY KEY, invocation TEXT NOT NULL UNIQUE, owner TEXT NOT NULL, state TEXT NOT NULL,
      output TEXT NOT NULL DEFAULT '', result TEXT, input_fingerprint TEXT NOT NULL, collection_key TEXT)`);
    if (!(sqlite.prepare("PRAGMA table_info(workspace_jobs)").all() as Array<{ name: string }>).some(column => column.name === "collection_key")) sqlite.exec("ALTER TABLE workspace_jobs ADD COLUMN collection_key TEXT");
    // Recovery never relaunches an effect or treats loss of contact as success.
    sqlite.prepare("UPDATE workspace_jobs SET state='unknown' WHERE state IN ('starting','running','stopping')").run();
    this.timer = setInterval(() => {
      for (const [id, job] of this.live) {
        try { this.authorize(job.context, false); }
        catch { void this.stop(id); }
      }
    }, 500);
    this.timer.unref();
  }
  started(context: ToolExecutionContext, access: ProcessAccess): void {
    if (!this.writable) { void this.terminate(access).catch(() => undefined); return; }
    const row = this.sqlite.prepare("SELECT id FROM workspace_jobs WHERE invocation=?").get(context.idempotencyKey) as { id: string } | undefined;
    const job = row && this.live.get(row.id);
    if (!job) return;
    job.access = access;
    this.sqlite.prepare("UPDATE workspace_jobs SET state='running' WHERE id=? AND state='starting'").run(row!.id);
    if (this.closed || job.stopping) { job.stopping = undefined; void this.stop(row!.id); }
  }
  output(context: ToolExecutionContext, text: string): void {
    if (!this.writable) return;
    // Cap the status projection independently of the native receipt/output bound.
    this.sqlite.prepare("UPDATE workspace_jobs SET output=substr(output || ?,1,65536) WHERE invocation=? AND state IN ('starting','running','stopping')").run(text, context.idempotencyKey);
  }
  pending(runId: string, workId: string): boolean {
    return this.uncollected(this.sqlite.prepare("SELECT id,state,collection_key FROM workspace_jobs WHERE json_extract(owner,'$[1]')=? AND json_extract(owner,'$[2]')=?").all(runId, workId) as Job[]);
  }
  private uncollected(rows: Job[]): boolean {
    return rows.some(row => row.state !== "collected" || !row.collection_key || !this.receiptRecorded(row.collection_key, row.id));
  }
  tools(): ExecutionToolAdapter[] {
    const base = this.workspace.tools().find(tool => tool.name === "workspace_execute")!;
    return [
      { ...base, name: "workspace_start", providedCapabilities: ["workspace.start"], dependencyCapabilities: [...base.dependencyCapabilities, "workspace.poll", "workspace.stop"],
        description: "Start one authorized workspace script and return an attributed handle immediately. Requires explicit asynchronousWorkspace consent as well as script execution authorization. Poll the handle for output and terminal result; running is not completion. The Run workspace remains locked while the script runs. No detached shell or background permission is granted.",
        execute: (input, context) => this.start(input, context) },
      ...(this.inputPort ? [{ ...base, name: "workspace_input", providedCapabilities: ["workspace.input"], dependencyCapabilities: ["workspace.start"], risk: "privileged" as const, timeoutMs: 10000,
        description: "Send text, EOF, interrupt or terminal size to this Work's managed process. Text can execute commands: the user must explicitly grant continuous terminal input in the task scope; the routine-approval switch alone is insufficient. Use one operation per call; do not send credentials. Repeated invocation IDs do not resend input. This never starts or resumes a process.",
        inputSchema: { type: "object", additionalProperties: false, required: ["handle"], properties: {
          handle: { type: "string", maxLength: 128 }, text: { type: "string", minLength: 1, maxLength: 8000 },
          columns: { type: "integer", minimum: 1, maximum: 500 }, rows: { type: "integer", minimum: 1, maximum: 500 }, interrupt: { type: "boolean" }, eof: { type: "boolean" } } },
        execute: async (input: unknown, context: ToolExecutionContext) => {
          this.authorize(context, false); context.signal?.throwIfAborted();
          if (!context.effectivePermissions.process.interactive) throw new Error("Interactive workspace input is not authorized");
          const args = input as { handle: string; text?: string; columns?: number; rows?: number; interrupt?: boolean; eof?: boolean };
          if (!args || typeof args.handle !== "string" || Object.keys(args).some(key => !["handle", "text", "columns", "rows", "interrupt", "eof"].includes(key))) throw new Error("Invalid terminal input");
          const modes = Number(args.text !== undefined) + Number(args.columns !== undefined || args.rows !== undefined) + Number(args.interrupt !== undefined) + Number(args.eof !== undefined);
          if (modes !== 1 || args.text !== undefined && (typeof args.text !== "string" || !args.text.length || args.text.length > 8000 || args.text.includes("\0"))
            || (args.columns !== undefined || args.rows !== undefined) && ![args.columns, args.rows].every(n => Number.isSafeInteger(n) && n! >= 1 && n! <= 500)
            || args.interrupt !== undefined && args.interrupt !== true || args.eof !== undefined && args.eof !== true) throw new Error("Invalid terminal input operation");
          const row = this.read(args.handle, context), job = this.live.get(row.id);
          if (!job?.access || row.state !== "running") throw new Error("Terminal is not currently owned and running");
          await this.inputPort!(job.access, context, args);
          return result({ handle: row.id, inputAccepted: true, completionConfirmed: false });
        } }] : []),
      ...(["poll", "stop"] as const).map(operation => ({ ...base, name: `workspace_${operation}`, providedCapabilities: [`workspace.${operation}`], dependencyCapabilities: [],
        risk: operation === "poll" ? "read_only" as const : "bounded_write" as const, timeoutMs: 35000,
        description: operation === "poll" ? "Read an owned script's status and bounded incremental output. Pass the returned nextCursor and waitSeconds (default 20, maximum 30). Completed results are untrusted tool output. Unknown requires reconciliation, never restart blindly."
          : "Request termination of this Work's owned script. Poll until native cleanup is confirmed; stop requested does not mean stopped.",
        inputSchema: { type: "object", additionalProperties: false, required: ["handle"], properties: { handle: { type: "string", minLength: 1, maxLength: 128 },
          ...(operation === "poll" ? { cursor: { type: "integer", minimum: 0, maximum: 65536 }, waitSeconds: { type: "integer", minimum: 0, maximum: 30 } } : {}) } },
        execute: async (input: unknown, context: ToolExecutionContext) => {
          this.authorize(context, false);
          const args = input as { handle?: unknown; cursor?: unknown; waitSeconds?: unknown };
          if (!args || typeof args.handle !== "string" || Object.keys(args).some(key => !(operation === "poll" ? ["handle", "cursor", "waitSeconds"] : ["handle"]).includes(key))) throw new Error("Invalid process status input");
          let row = this.read(args.handle, context, operation === "poll");
          if (operation === "stop") { const active = this.live.has(row.id); await this.stop(row.id); return result({ handle: row.id, state: this.read(row.id, context).state, stopRequested: active }); }
          const cursor = args.cursor ?? 0, wait = args.waitSeconds ?? 20;
          if (!Number.isSafeInteger(cursor) || (cursor as number) < 0 || (cursor as number) > row.output.length || !Number.isSafeInteger(wait) || (wait as number) < 0 || (wait as number) > 30) throw new Error("Invalid process cursor or wait duration");
          const until = Date.now() + (wait as number) * 1000;
          while (["starting", "running", "stopping"].includes(row.state) && row.output.length === cursor && Date.now() < until) {
            context.signal?.throwIfAborted(); this.authorize(context, false);
            await new Promise(resolve => setTimeout(resolve, 100)); row = this.read(row.id, context, true);
          }
          context.signal?.throwIfAborted(); this.authorize(context, false);
          const text = row.output.slice(cursor as number, (cursor as number) + 16384);
          const nextCursor = (cursor as number) + text.length, exhausted = nextCursor >= row.output.length;
          if (["completed", "collected"].includes(row.state) && exhausted && (!row.collection_key || !this.receiptRecorded(row.collection_key, row.id)))
            this.sqlite.prepare("UPDATE workspace_jobs SET state='collected',collection_key=? WHERE id=?").run(context.idempotencyKey, row.id);
          const terminal = row.result ? JSON.parse(row.result) : null;
          return result({ handle: row.id, state: row.state, nextCursor, hasMoreOutput: !exhausted,
            terminalStatus: terminal?.status ?? null, exitCode: terminal?.metadata?.exitCode ?? null, exitSignal: terminal?.metadata?.exitSignal ?? null,
            outputProjectionLimit: 65536, output: text, terminalResult: exhausted ? terminal : null,
            ...(row.state === "unknown" ? { recoveryRequired: true } : {}) });
        } })),
    ];
  }
  private read(id: string, context: ToolExecutionContext, historical = false): Job {
    const row = this.sqlite.prepare("SELECT * FROM workspace_jobs WHERE id=?").get(id) as Job | undefined;
    if (!row || (row.owner !== owner(context) && !(historical && JSON.stringify(JSON.parse(row.owner).slice(0, 4)) === JSON.stringify([context.caseId, context.runId, context.workId, context.scopeRef])))) throw new Error("Process handle does not belong to this Work and lease");
    return row;
  }
  private async start(input: unknown, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    context.signal?.throwIfAborted(); this.authorize(context, true);
    if (this.closed) throw new Error("Workspace jobs are closed");
    const frozenInput = structuredClone(input);
    const fingerprint = createHash("sha256").update(canonicalJson(frozenInput)).digest("hex");
    const old = this.sqlite.prepare("SELECT * FROM workspace_jobs WHERE invocation=?").get(context.idempotencyKey) as (Job & { input_fingerprint: string }) | undefined;
    if (old) {
      if (old.owner !== owner(context) || old.input_fingerprint !== fingerprint) throw new Error("Process invocation identity conflict");
      return result({ handle: old.id, state: old.state, replayed: true });
    }
    if (this.uncollected(this.sqlite.prepare("SELECT id,state,collection_key FROM workspace_jobs WHERE json_extract(owner,'$[0]')=? AND json_extract(owner,'$[1]')=?").all(context.caseId, context.runId) as Job[])) throw new Error("Resolve the existing workspace process before starting another");
    const id = randomUUID();
    this.sqlite.prepare("INSERT INTO workspace_jobs(id,invocation,owner,state,input_fingerprint) VALUES (?,?,?,'starting',?)").run(id, context.idempotencyKey, owner(context), fingerprint);
    // The durable starting intent precedes dispatch. Its child remains owned by
    // the Work monitor, not by the short-lived start tool call.
    let command = "", output = "", lastUpdate = 0;
    const publish = (terminal?: ToolExecutionResult) => this.progress?.(context, { handle: id, command, output, terminal });
    const child = { ...context, signal: new AbortController().signal };
    Object.defineProperty(child, "onProgress", { enumerable: false, value: (event: { phase: string; text?: string }) => {
      if (!this.writable || !this.live.has(id)) return;
      if (event.phase === "command") command = event.text ?? "";
      if (event.phase === "output") output = (output + (event.text ?? "")).slice(-12000);
      if (event.phase !== "output" || Date.now() - lastUpdate >= 1000) { publish(); lastUpdate = Date.now(); }
    } });
    const job: { context: ToolExecutionContext; access?: ProcessAccess; stopping?: Promise<unknown>; done: Promise<void> } = { context: child, done: Promise.resolve() };
    this.live.set(id, job);
    job.done = Promise.resolve().then(async () => {
      try {
        if (this.closed || job.stopping) {
          if (this.writable) this.sqlite.prepare("UPDATE workspace_jobs SET state='completed',result=? WHERE id=?").run(JSON.stringify({ status: "failed", summary: "Cancelled before process dispatch", retryable: false }), id);
          return;
        }
        this.authorize(child, true);
        const value = await this.workspace.tools().find(tool => tool.name === "workspace_execute")!.execute(frozenInput, child);
        if (this.writable) this.sqlite.prepare("UPDATE workspace_jobs SET state='completed',result=? WHERE id=?").run(JSON.stringify(value), id);
        if (this.writable) publish(value);
      } catch {
        if (this.writable) this.sqlite.prepare("UPDATE workspace_jobs SET state='unknown' WHERE id=?").run(id);
        if (this.writable) publish({ status: "failed", summary: "Process outcome unknown; reconciliation required", raw: "", refs: [], retryable: false });
      } finally { this.live.delete(id); }
    });
    return result({ handle: id, state: "starting", completionConfirmed: false });
  }
  private async stop(id: string): Promise<void> {
    const job = this.live.get(id);
    if (!job) return;
    this.sqlite.prepare("UPDATE workspace_jobs SET state='stopping' WHERE id=? AND state IN ('starting','running')").run(id);
    if (!job.stopping) job.stopping = job.access ? this.terminate(job.access).catch(() => {
      if (this.writable) this.sqlite.prepare("UPDATE workspace_jobs SET state='unknown' WHERE id=? AND state='stopping'").run(id);
    }) : Promise.resolve();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([job.stopping, new Promise(resolve => { timer = setTimeout(resolve, 5000); })]);
    clearTimeout(timer);
  }
  async close(): Promise<void> {
    this.closed = true; clearInterval(this.timer);
    await Promise.all([...this.live.keys()].map(id => this.stop(id)));
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all([...this.live.values()].map(job => job.done)), new Promise(resolve => { timer = setTimeout(resolve, 5000); })]);
    clearTimeout(timer);
    this.sqlite.prepare("UPDATE workspace_jobs SET state='unknown' WHERE state IN ('starting','running','stopping')").run();
    this.writable = false;
  }
}
