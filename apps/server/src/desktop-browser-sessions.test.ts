import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { createDb, getSqliteClient } from "./db/client.js";
import { FoundationHostControl } from "./foundation-host-control.js";
import { registerConversationRoutes } from "./conversation-routes.js";
import { DesktopBrowserSessions, registerDesktopBrowserRoutes } from "./desktop-browser-sessions.js";
import type { BrokeredBrowserRuntime } from "@traceforge/browser-runtime";
import type { ToolExecutionContext } from "@traceforge/worker-runtime";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const clean of cleanup.splice(0)) await clean(); });
async function fixture() {
  const db = createDb(":memory:"), sql = getSqliteClient(db), app = Fastify();
  const channel = new FoundationHostControl(app, sql).management(); registerConversationRoutes(app, db);
  const sessions = new DesktopBrowserSessions(sql); registerDesktopBrowserRoutes(app, sql, sessions);
  cleanup.push(async () => { await sessions.shutdown(); await app.close(); sql.close(); });
  const conversation = (await app.inject({ method: "POST", url: "/api/desktop/conversations", headers: channel.headers(), payload: { commandId: "create", title: "Browser" } })).json();
  sql.prepare(`INSERT INTO scenario_event_streams VALUES ('run',?,'fixture',1,NULL,NULL,NULL,'running','phase',1,'now','now')`).run(conversation.caseId);
  const owner = { caseId: conversation.caseId, runId: "run", workId: "work", workerId: "worker", scopeRef: "scope", leaseId: "lease",
    leaseExpiresAt: new Date(Date.now() + 60000).toISOString() } as ToolExecutionContext;
  sql.prepare("INSERT INTO scenario_work_leases VALUES ('run','work','worker','lease',?,'now')").run(owner.leaseExpiresAt);
  const runtime = { snapshot: () => ({ status: "active", takeoverId: null, expiresAt: owner.leaseExpiresAt }),
    previewManual: vi.fn(async () => { const bytes = Buffer.alloc(24); bytes.write("IHDR", 12); bytes.writeUInt32BE(800, 16); bytes.writeUInt32BE(600, 20);
      return { view: { generation: 2, pageId: "page", documentId: "document" }, bodyBase64: bytes.toString("base64") }; }),
    actManual: vi.fn(async () => ({ id: "manual" })),
    beginManualControl: vi.fn(async () => ({ state: "manual_control" })) };
  const close = vi.fn(async () => {});
  sessions.add("session", { owner, packageId: "fixture", packageVersion: "1", runtime: runtime as unknown as BrokeredBrowserRuntime,
    close, check: () => { sessions.currentLease(owner); }, read: () => undefined });
  const path = `/api/desktop/conversations/${conversation.id}/execution/run/browser`;
  return { sql, app, sessions, owner, close, runtime, path, headers: channel.headers() };
}
it("fences the desktop route, validates commands and deduplicates without allowing identity overrides", async () => {
  const f = await fixture(), payload = { operation: "takeover", sessionId: "session", commandId: "first" };
  expect((await f.app.inject({ method: "GET", url: f.path })).statusCode).toBe(401);
  expect((await f.app.inject({ method: "GET", url: f.path.replace('/execution/run/', '/execution/other/'), headers: f.headers })).statusCode).toBe(404);
  for (let n = 0; n < 2; n++) expect((await f.app.inject({ method: "POST", url: f.path, headers: f.headers, payload })).statusCode).toBe(200);
  expect(f.runtime.beginManualControl).toHaveBeenCalledTimes(1);
  expect((await f.app.inject({ method: "POST", url: f.path, headers: f.headers, payload: { ...payload, scopeRef: "override" } })).statusCode).toBe(400);
  expect((await f.app.inject({ method: "POST", url: f.path, headers: f.headers, payload: { ...payload, operation: "close" } })).statusCode).toBe(409);
});
it("displays ephemeral frames without an artifact journal and binds manual input to the displayed frame", async () => {
  const f = await fixture();
  const preview = { operation: "preview" as const, sessionId: "session", takeoverId: "manual", commandId: "frame" };
  const frame = await f.sessions.command(f.owner.caseId, "run", preview) as { frameId: string };
  expect(f.sql.prepare("SELECT COUNT(*) AS count FROM desktop_browser_commands").get()).toEqual({ count: 0 });
  const input = { operation: "input" as const, sessionId: "session", takeoverId: "manual", commandId: "input", frameId: frame.frameId, input: { type: "text" as const, text: "private fixture" } };
  await expect(f.sessions.command(f.owner.caseId, "run", { ...input, frameId: "forged" })).rejects.toThrow("stale");
  await f.sessions.command(f.owner.caseId, "run", input); await f.sessions.command(f.owner.caseId, "run", input);
  expect(f.runtime.actManual).toHaveBeenCalledTimes(1);
  await expect(f.sessions.command(f.owner.caseId, "run", { ...input, commandId: "reused-frame" })).rejects.toThrow("stale");
  expect(JSON.stringify(f.sql.prepare("SELECT * FROM desktop_browser_commands").all())).not.toContain("private fixture");
});
it("persists uncertain cleanup and never resurrects handles after restart", async () => {
  const f = await fixture(); f.close.mockRejectedValueOnce(new Error("unknown"));
  await expect(f.sessions.close("session")).rejects.toThrow("unknown");
  expect(f.sql.prepare("SELECT state FROM desktop_browser_sessions").get()).toEqual({ state: "cleanup_unknown" });
  const restarted = new DesktopBrowserSessions(f.sql);
  try { expect(restarted.list(f.owner.caseId, "run")).toEqual([]); }
  finally { await restarted.shutdown(); }
  expect(f.close).toHaveBeenCalledTimes(1);
});
it("revokes current ownership on pause and still allows explicit cleanup", async () => {
  const f = await fixture(); f.sql.prepare("UPDATE scenario_event_streams SET status='paused'").run();
  expect(() => f.sessions.currentLease(f.owner)).toThrow("revoked");
  await f.sessions.command(f.owner.caseId, "run", { operation: "close", sessionId: "session", commandId: "close" });
  expect(f.close).toHaveBeenCalledTimes(1);
});
it("shutdown waits for cleanup already started by revocation", async () => {
  const f = await fixture(); let finish!: () => void;
  f.close.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  const closing = f.sessions.close("session"); await Promise.resolve();
  let stopped = false; const shutdown = f.sessions.shutdown().then(() => { stopped = true; });
  await Promise.resolve(); expect(stopped).toBe(false);
  finish(); await closing; await shutdown; expect(stopped).toBe(true);
  expect(f.close).toHaveBeenCalledTimes(1);
});
