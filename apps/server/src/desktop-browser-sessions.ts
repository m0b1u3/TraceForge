import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import type { BrokeredBrowserRuntime } from "@traceforge/browser-runtime";
import type { ToolExecutionContext } from "@traceforge/worker-runtime";
import { permissionProfileFingerprint } from "@traceforge/execution-node";
import { DesktopBrowserCommandSchema, type DesktopBrowserCommand } from "@traceforge/shared/desktop-browser";

interface Session {
  runtime: BrokeredBrowserRuntime; owner: ToolExecutionContext; packageId: string; packageVersion: string;
  check(): void; close(): Promise<void>; read(ref: string): Buffer | undefined;
  commands: Map<string, { digest: string; result: Promise<unknown> }>; busy: boolean;
  frame?: { id: string; takeoverId: string; view: import("@traceforge/browser-runtime").BrowserViewIdentity; expires: number };
  previewAt?: number;
}

/** Live handles never survive a host restart. Scratch/process journals recover
 * uncertain termination; this registry never silently relaunches or replays. */
export class DesktopBrowserSessions {
  private readonly entries = new Map<string, Session>();
  private readonly closing = new Map<string, Promise<void>>();
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS desktop_browser_sessions (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL, run_id TEXT NOT NULL, work_id TEXT NOT NULL,
      state TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS desktop_browser_commands (
      session_id TEXT NOT NULL, command_id TEXT NOT NULL, operation TEXT NOT NULL, state TEXT NOT NULL,
      updated_at TEXT NOT NULL, PRIMARY KEY(session_id,command_id));
      UPDATE desktop_browser_sessions SET state='interrupted' WHERE state IN ('active','manual_control');
      UPDATE desktop_browser_commands SET state='unknown' WHERE state='started';`);
    this.timer = setInterval(() => { for (const [id, entry] of this.entries) {
      try { entry.check(); } catch { void this.close(id).catch(() => undefined); }
    } }, 1000);
    this.timer.unref();
  }
  currentLease(owner: ToolExecutionContext): string {
    const row = this.db.prepare(`SELECT l.lease_expires_at AS expires FROM scenario_work_leases l
      JOIN scenario_event_streams r ON r.run_id=l.run_id WHERE l.run_id=? AND l.work_id=? AND l.worker_id=?
      AND l.lease_id=? AND r.case_id=? AND r.status='running' AND l.lease_expires_at>?`)
      .get(owner.runId, owner.workId, owner.workerId, owner.leaseId, owner.caseId, new Date().toISOString()) as { expires: string } | undefined;
    if (!row) throw new Error("Browser ownership expired or revoked");
    return row.expires;
  }
  add(id: string, session: Omit<Session, "commands" | "busy">): void {
    if (this.entries.size >= 16 || this.entries.has(id)) throw new Error("Browser session capacity exhausted");
    this.db.prepare("INSERT INTO desktop_browser_sessions VALUES (?,?,?,?,'active',?)")
      .run(id, session.owner.caseId, session.owner.runId, session.owner.workId, new Date().toISOString());
    this.entries.set(id, { ...session, commands: new Map(), busy: false });
  }
  async close(id: string): Promise<void> {
    const pending = this.closing.get(id); if (pending) return pending;
    const entry = this.entries.get(id); if (!entry) return;
    this.entries.delete(id);
    const cleanup = Promise.resolve().then(() => entry.close()).then(() => { this.state(id, "closed"); }, error => {
      this.state(id, "cleanup_unknown"); throw error;
    }).finally(() => { this.closing.delete(id); });
    this.closing.set(id, cleanup); return cleanup;
  }
  private state(id: string, state: string) { this.db.prepare("UPDATE desktop_browser_sessions SET state=?,updated_at=? WHERE id=?").run(state, new Date().toISOString(), id); }
  closePackage(id: string, version: string): void {
    for (const [sessionId, entry] of this.entries) if (entry.packageId === id && entry.packageVersion === version) void this.close(sessionId).catch(() => undefined);
  }
  async shutdown(): Promise<void> { clearInterval(this.timer); await Promise.allSettled([...this.entries.keys()].map(id => this.close(id)).concat([...this.closing.values()])); }
  list(caseId: string, runId: string) {
    return [...this.entries].filter(([, e]) => e.owner.caseId === caseId && e.owner.runId === runId).map(([id, e]) => {
      e.check(); const s = e.runtime.snapshot(id)!;
      return { id, status: s.status, takeoverId: s.takeoverId, expiresAt: s.expiresAt, workId: e.owner.workId,
        ...(s.isolation ? { isolation: s.isolation } : {}) };
    });
  }
  agent(id: string, owner: ToolExecutionContext, packageId: string, packageVersion: string) {
    const e = this.required(id, owner.caseId, owner.runId);
    if (e.packageId !== packageId || e.packageVersion !== packageVersion || e.owner.workId !== owner.workId
      || e.owner.workerId !== owner.workerId || e.owner.leaseId !== owner.leaseId || e.owner.scopeRef !== owner.scopeRef
      || permissionProfileFingerprint(e.owner.effectivePermissions) !== permissionProfileFingerprint(owner.effectivePermissions))
      throw new Error("Browser session ownership mismatch");
    e.check(); return e.runtime;
  }
  private required(id: string, caseId: string, runId: string) {
    const e = this.entries.get(id);
    if (!e || e.owner.caseId !== caseId || e.owner.runId !== runId) throw new Error("Browser session unavailable");
    return e;
  }
  async command(caseId: string, runId: string, input: DesktopBrowserCommand): Promise<unknown> {
    const e = this.required(input.sessionId, caseId, runId);
    if (input.operation === "preview") {
      e.check();
      if (e.busy || Date.now() - (e.previewAt ?? 0) < 400) throw new Error("Browser preview busy");
      e.busy = true; e.previewAt = Date.now();
      try {
        const value = await e.runtime.previewManual(input.sessionId, input.takeoverId, input.pageId);
        const bytes = Buffer.from(value.bodyBase64, "base64");
        if (bytes.length < 24 || bytes.toString("ascii", 12, 16) !== "IHDR") throw new Error("Invalid browser frame");
        const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
        if (width < 1 || height < 1 || width > 2048 || height > 2048) throw new Error("Browser frame exceeds viewport");
        // Only the latest frame may issue a bounded manual input. Replaced,
        // expired or consumed frames cannot become a reusable input capability.
        const frameId = randomUUID();
        e.frame = { id: frameId, takeoverId: input.takeoverId, view: value.view, expires: Date.now() + 10000 };
        return { frameId, view: value.view, width, height, bodyBase64: value.bodyBase64 };
      } finally { e.busy = false; }
    }
    const digest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const prior = e.commands.get(input.commandId);
    if (prior) { if (prior.digest !== digest) throw new Error("Browser command changed"); return this.present(e, input, await prior.result); }
    if (input.operation !== "close" && (e.busy || e.commands.size >= 1000)) throw new Error("Browser busy or command capacity exhausted");
    if (input.operation !== "close") e.check();
    const frame = e.frame;
    if (input.operation === "input" && (!frame || frame.id !== input.frameId || frame.takeoverId !== input.takeoverId || frame.expires <= Date.now()))
      throw new Error("Browser displayed frame is stale");
    e.frame = undefined;
    if (input.operation === "input") e.previewAt = 0;
    this.db.prepare("INSERT INTO desktop_browser_commands VALUES (?,?,?,'started',?)")
      .run(input.sessionId, input.commandId, input.operation, new Date().toISOString());
    e.busy = true;
    const result = Promise.resolve().then(async () => {
      if (input.operation === "close") { await this.close(input.sessionId); return { status: "closed" }; }
      if (input.operation === "takeover") return e.runtime.beginManualControl(input.sessionId);
      if (input.operation === "resume") return e.runtime.resumeManualControl(input.sessionId, input.takeoverId);
      if (input.operation === "act") return e.runtime.actManual(input.sessionId, input.takeoverId, { ...input.action, id: input.commandId });
      if (input.operation === "input") return e.runtime.actManual(input.sessionId, input.takeoverId, { id: input.commandId, kind: "input", view: frame!.view, input: input.input });
      return e.runtime.observeManual(input.sessionId, input.takeoverId, { kind: "dom", pageId: input.pageId });
    }).then(value => {
      const snapshot = e.runtime.snapshot(input.sessionId);
      if (input.operation !== "close" && snapshot && this.entries.has(input.sessionId)) this.state(input.sessionId, snapshot.status);
      this.db.prepare("UPDATE desktop_browser_commands SET state='completed',updated_at=? WHERE session_id=? AND command_id=?")
        .run(new Date().toISOString(), input.sessionId, input.commandId);
      return value;
    }, error => {
      this.db.prepare("UPDATE desktop_browser_commands SET state='unknown',updated_at=? WHERE session_id=? AND command_id=?")
        .run(new Date().toISOString(), input.sessionId, input.commandId);
      throw error;
    }).finally(() => { e.busy = false; });
    e.commands.set(input.commandId, { digest, result });
    return this.present(e, input, await result);
  }
  private present(e: Session, input: DesktopBrowserCommand, value: unknown): unknown {
    if (input.operation !== "observe") return value;
    // Cache the small immutable receipt, not thousands of full DOM payloads.
    const observation = value as { artifactRef: string; byteSize: number; sha256: string };
    const body = e.read(observation.artifactRef);
    if (!body || body.length !== observation.byteSize || body.length > 4194304 || createHash("sha256").update(body).digest("hex") !== observation.sha256)
      throw new Error("Browser observation unavailable");
    return { ...observation, document: JSON.parse(body.toString("utf8")) };
  }
}

export function registerDesktopBrowserRoutes(app: FastifyInstance, db: Database.Database, sessions: DesktopBrowserSessions) {
  const path = "/api/desktop/conversations/:conversationId/execution/:runId/browser";
  const owner = (params: unknown) => {
    const { conversationId, runId } = params as { conversationId: string; runId: string };
    if (![conversationId, runId].every(id => /^[a-zA-Z0-9_-]{1,100}$/.test(id))) return undefined;
    const row = db.prepare(`SELECT c.case_id FROM desktop_conversations c JOIN scenario_event_streams r ON r.case_id=c.case_id
      WHERE c.id=? AND r.run_id=?`).get(conversationId, runId) as { case_id: string } | undefined;
    return row && { caseId: row.case_id, runId };
  };
  app.get(path, async (request, reply) => {
    const o = owner(request.params); if (!o) return reply.code(404).send({ error: "browser_unavailable" });
    reply.header("Cache-Control", "no-store");
    try { return { sessions: sessions.list(o.caseId, o.runId) }; } catch { return reply.code(409).send({ error: "browser_unavailable" }); }
  });
  app.post(path, async (request, reply) => {
    const o = owner(request.params); if (!o) return reply.code(404).send({ error: "browser_unavailable" });
    const parsed = DesktopBrowserCommandSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_browser_command" });
    reply.header("Cache-Control", "no-store");
    try { return await sessions.command(o.caseId, o.runId, parsed.data); }
    catch { return reply.code(409).send({ error: "browser_command_unconfirmed", message: "请重新读取状态，不要自动重复操作。" }); }
  });
}
