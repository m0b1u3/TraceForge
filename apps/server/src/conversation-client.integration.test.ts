import { afterEach, expect, it } from "vitest";
import Fastify from "fastify";
import { createDb, getSqliteClient } from "./db/client.js";
import { registerRoutes } from "./routes.js";
import { EventBus } from "./event-bus.js";
import { FoundationHostControl } from "./foundation-host-control.js";
import { ConversationClient } from "../../web/renderer/conversation-client.js";
import { createConversationBridge } from "../../desktop/src/conversation-bridge.js";
import { desktopConversationTransport } from "../../web/renderer/desktop-conversation-transport.js";
import { HostConversationController } from "../../web/renderer/host-conversation-controller.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

it("reads conversations beyond the old collection limit through the desktop bridge", async () => {
  const db = createDb(":memory:"), sql = getSqliteClient(db), app = Fastify();
  const channel = new FoundationHostControl(app, sql).management();
  registerRoutes(app, db, new EventBus());
  cleanups.push(() => sql.close(), () => app.close());
  const insertCase = sql.prepare("INSERT INTO cases VALUES (?,'history','active','[]','2026-01-01')");
  const insertConversation = sql.prepare("INSERT INTO desktop_conversations VALUES (?,?,?,'history','2026-01-01')");
  sql.transaction(() => {
    for (let i = 0; i < 1001; i++) {
      insertCase.run(`case-${i}`);
      insertConversation.run(`conversation-${i}`, `command-${i}`, `case-${i}`);
    }
  })();
  const bridge = createConversationBridge({ webContentsId: 1, origin: "http://127.0.0.1:43210", host: { request: async input => {
    const response = await app.inject({ url: input.path, method: input.method, headers: channel.headers() });
    return { status: response.statusCode, body: response.json() };
  } } });
  const client = new ConversationClient(desktopConversationTransport({ protocolVersion: 1, request: input =>
    bridge.request({ webContentsId: 1, mainFrame: true, url: "http://127.0.0.1:43210/" }, input) }));
  expect(await client.list()).toHaveLength(1001);
  bridge.close();
});

it("runs real protected host persistence through the renderer contract, reconciles lost replies and restores every page", async () => {
  const db = createDb(":memory:"); const app = Fastify();
  const control = new FoundationHostControl(app, getSqliteClient(db)); const channel = control.management();
  const headers = channel.headers();
  registerRoutes(app, db, new EventBus());
  cleanups.push(() => getSqliteClient(db).close(), () => app.close());
  let loseNextReply = false;
  const client = new ConversationClient(async (url, init) => {
    const response = await app.inject({ url, method: init.method, payload: init.body, headers: { ...headers, ...(init.body ? { "content-type": "application/json" } : {}) } });
    if (loseNextReply) { loseNextReply = false; throw new Error("lost after commit"); }
    return { ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, json: async () => response.json() };
  });
  const c = await client.create("stable-create", "通用调查");
  loseNextReply = true;
  await expect(client.send(c.id, "first", "不能丢失的说明")).rejects.toMatchObject({ outcome: "unknown" });
  expect(await client.send(c.id, "first", "不能丢失的说明")).toMatchObject({ sequence: 1, delivery: "not_dispatched" });
  for (let index = 2; index <= 102; index++) await client.send(c.id, `message-${index}`, `中性记录 ${index}`);
  const restored = await client.restore(c.id);
  expect(restored.conversation).toEqual(c); expect(restored.messages).toHaveLength(102);
  expect(restored.messages.at(-1)?.sequence).toBe(102);
  channel.revoke();
  await expect(client.restore(c.id)).rejects.toMatchObject({ outcome: "rejected", status: 401 });
});

it("rejects mismatched ownership instead of merging foreign messages", async () => {
  const client = new ConversationClient(async () => ({ ok: true, status: 200, json: async () => ({ id: "other", caseId: "case-1", title: "other", createdAt: "now" }) }));
  await expect(client.restore("conversation-1")).rejects.toMatchObject({ outcome: "invalid_response" });
});

it("connects journal, renderer transport, sender-checked bridge and real host, then recovers an interrupted command", async () => {
  const db = createDb(":memory:"); const app = Fastify();
  const control = new FoundationHostControl(app, getSqliteClient(db)); const channel = control.management();
  registerRoutes(app, db, new EventBus()); cleanups.push(() => getSqliteClient(db).close(), () => app.close());
  const bridge = createConversationBridge({ webContentsId: 1, origin: "http://127.0.0.1:43210", host: { request: async input => {
    const response = await app.inject({ url: input.path, method: input.method, payload: input.body, headers: { ...channel.headers(), ...(input.body ? { "content-type": "application/json" } : {}) } });
    return { status: response.statusCode, body: response.json() };
  } } });
  let lose = false; let raw: string | null = null;
  const storage = { getItem: () => raw, setItem: (_key: string, value: string) => { raw = value; } };
  const client = new ConversationClient(desktopConversationTransport({ protocolVersion: 1, request: async input => {
    const result = await bridge.request({ webContentsId: 1, mainFrame: true, url: "http://127.0.0.1:43210/" }, input);
    if (lose) { lose = false; throw new Error("IPC reply lost"); } return result;
  } }));
  let controller = new HostConversationController(client, storage);
  await controller.execute({ kind: "create", commandId: "journal-create", title: "中性会话" });
  const c = (await controller.list())[0]!;
  lose = true;
  await expect(controller.execute({ kind: "send", commandId: "journal-send", conversationId: c.id, text: "保留说明" })).rejects.toThrow();
  expect(controller.pending?.commandId).toBe("journal-send");
  await expect(controller.execute({ kind: "create", commandId: "new", title: "重复" })).rejects.toThrow("原命令");
  controller = new HostConversationController(client, storage);
  expect(await controller.execute()).toMatchObject({ sequence: 1, persistence: "saved", delivery: "not_dispatched" });
  expect((await controller.restore(c.id)).messages).toHaveLength(1);
  expect(controller.pending).toBeNull();
  const denied = new HostConversationController(client, { getItem: () => null, setItem: () => { throw new Error("storage denied"); } });
  await expect(denied.execute({ kind: "create", commandId: "blocked", title: "不能创建" })).rejects.toThrow("storage denied");
  expect(await client.list()).toHaveLength(1);
});
