import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, getSqliteClient } from "./db/client.js";
import { registerRoutes } from "./routes.js";
import { EventBus } from "./event-bus.js";
import { FoundationHostControl } from "./foundation-host-control.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(path = ":memory:") {
  const db = createDb(path);
  const app = Fastify();
  registerRoutes(app, db, new EventBus());
  await app.ready();
  cleanups.push(() => getSqliteClient(db).close(), () => app.close());
  const create = (commandId = "create-1", title = "调查记录") => app.inject({ method: "POST", url: "/api/desktop/conversations", payload: { commandId, title } });
  const send = (id: string, commandId: string, text: string) => app.inject({ method: "POST", url: `/api/desktop/conversations/${id}/messages`, payload: { commandId, text } });
  return { db, app, create, send };
}

describe("desktop conversation host persistence", () => {
  it("uses the existing local management channel, not worker or public access", async () => {
    const db = createDb(":memory:"); const app = Fastify();
    const control = new FoundationHostControl(app, getSqliteClient(db));
    registerRoutes(app, db, new EventBus());
    cleanups.push(() => getSqliteClient(db).close(), () => app.close());
    const channel = control.management();
    const worker = control.worker({ id: "worker-1", roles: ["researcher"], capabilities: [], maxConcurrentWork: 1 } as Parameters<typeof control.worker>[0], "neutral", 1);
    const url = "/api/desktop/conversations";
    expect((await app.inject({ url })).statusCode).toBe(401);
    expect((await app.inject({ url, headers: worker.headers() })).statusCode).toBe(403);
    expect((await app.inject({ url, headers: channel.headers(), remoteAddress: "192.0.2.1" })).statusCode).toBe(403);
    expect((await app.inject({ url, headers: channel.headers() })).statusCode).toBe(200);
    const headers = channel.headers(); channel.revoke();
    expect((await app.inject({ url, headers })).statusCode).toBe(401);
  });
  it("rolls back the Case when conversation creation fails", async () => {
    const f = await fixture(); const sql = getSqliteClient(f.db);
    sql.exec("CREATE TRIGGER reject_conversation BEFORE INSERT ON desktop_conversations BEGIN SELECT RAISE(ABORT,'injected failure'); END");
    expect((await f.create()).statusCode).toBe(500);
    expect(sql.prepare("SELECT count(*) AS n FROM cases").get()).toEqual({ n: 0 });
    sql.exec("DROP TRIGGER reject_conversation");
    expect((await f.create()).statusCode).toBe(201);
  });
  it("atomically creates an unscoped owner and replays stable commands", async () => {
    const f = await fixture();
    const first = await f.create();
    expect(first.statusCode).toBe(201);
    expect((await f.create()).json()).toEqual(first.json());
    expect((await f.create("create-1", "different")).statusCode).toBe(409);
    const sql = getSqliteClient(f.db);
    expect(sql.prepare("SELECT scope_rules_json FROM cases").get()).toEqual({ scope_rules_json: "[]" });
    expect(sql.prepare("SELECT count(*) AS n FROM cases").get()).toEqual({ n: 1 });
    expect(sql.prepare("SELECT count(*) AS n FROM scenario_event_streams").get()).toEqual({ n: 0 });
  });
  it("saves user text without pretending to dispatch, reply or approve", async () => {
    const f = await fixture(); const id = (await f.create()).json().id;
    const first = await f.send(id, "msg-1", "可以");
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ role: "user", persistence: "saved", delivery: "not_dispatched", text: "可以", sequence: 1 });
    expect((await f.send(id, "msg-1", "可以")).json()).toEqual(first.json());
    expect((await f.send(id, "msg-1", "不同内容")).statusCode).toBe(409);
    expect(getSqliteClient(f.db).prepare("SELECT count(*) AS n FROM scenario_authorizations").get()).toEqual({ n: 0 });
  });
  it("paginates ordered messages without crossing conversations", async () => {
    const f = await fixture(); const a = (await f.create()).json().id; const b = (await f.create("create-2")).json().id;
    await f.send(a, "first", "第一条"); await f.send(a, "second", "第二条"); await f.send(b, "first", "其他会话");
    const page = (await f.app.inject(`/api/desktop/conversations/${a}/messages?limit=1`)).json();
    expect(page).toMatchObject({ hasMore: true, nextAfter: 1, messages: [{ text: "第一条" }] });
    const next = (await f.app.inject(`/api/desktop/conversations/${a}/messages?after=1&limit=1`)).json();
    expect(next).toMatchObject({ hasMore: false, nextAfter: 2, messages: [{ text: "第二条" }] });
    expect((await f.app.inject(`/api/desktop/conversations/${a}/messages?limit=101`)).statusCode).toBe(400);
  });
  it("fails closed after the owning Case disappears", async () => {
    const f = await fixture(); const c = (await f.create()).json();
    getSqliteClient(f.db).prepare("DELETE FROM cases WHERE id=?").run(c.caseId);
    expect((await f.send(c.id, "msg", "text")).statusCode).toBe(404);
    expect((await f.create()).statusCode).toBe(410);
    expect((await f.app.inject("/api/desktop/conversations")).json().conversations).toEqual([]);
  });
  it.each(["", " \n ", "x".repeat(16001)])("rejects invalid message bodies", async text => {
    const f = await fixture(); const id = (await f.create()).json().id;
    expect((await f.send(id, "msg", text)).statusCode).toBe(400);
  });
  it("persists across database close and reopen and reconciles a lost response", async () => {
    const dir = mkdtempSync(join(tmpdir(), "traceforge-conversation-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "state.sqlite");
    const first = await fixture(path); const c = (await first.create()).json();
    const receipt = (await first.send(c.id, "stable-message", "保留原始说明")).json();
    // Finish this fixture before opening the same on-disk database again.
    await cleanups.pop()!(); await cleanups.pop()!();
    const second = await fixture(path);
    expect((await second.create()).json()).toEqual(c);
    expect((await second.send(c.id, "stable-message", "保留原始说明")).json()).toEqual(receipt);
    expect((await second.app.inject(`/api/desktop/conversations/${c.id}/messages`)).json().messages).toHaveLength(1);
  });
});
