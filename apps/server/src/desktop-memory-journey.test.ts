import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import type { LlmProvider } from "@traceforge/llm";
import { ModelContextOverflowError } from "@traceforge/shared/model-context";
import { createDb, getSqliteClient } from "./db/client.js";
import { registerConversationRoutes } from "./conversation-routes.js";
import { DesktopReplyService } from "./desktop-replies.js";
import { ConversationHistoryReader } from "./conversation-history-reader.js";
import { DesktopReplySchema } from "@traceforge/shared/desktop-replies";

const clean: Array<() => Promise<void>> = [];
afterEach(async () => { for (const run of clean.splice(0)) await run(); });
async function host(model: LlmProvider, timeout = 120000) {
  const root = await mkdtemp(join(tmpdir(), "desktop-memory-")), path = join(root, "state.db");
  let db = createDb(path), sql = getSqliteClient(db), app = Fastify(), service = new DesktopReplyService(sql, () => model, timeout);
  registerConversationRoutes(app, db); await app.ready();
  const conversation = (await app.inject({ method: "POST", url: "/api/desktop/conversations", payload: { commandId: "create", title: "Memory" } })).json();
  const add = async (id: string, text: string) => {
    const response = await app.inject({ method: "POST", url: `/api/desktop/conversations/${conversation.id}/messages`, payload: { commandId: id, text } });
    expect(response.statusCode).toBeLessThan(300);
  };
  clean.push(async () => { service.close(); await app.close(); sql.close(); await rm(root, { recursive: true, force: true }); });
  return { conversation, add, sql: () => sql, service: () => service,
    async restart() { service.close(); await app.close(); sql.close(); db = createDb(path); sql = getSqliteClient(db); app = Fastify(); registerConversationRoutes(app, db); service = new DesktopReplyService(sql, () => model, timeout); await app.ready(); },
    start: (id: string) => service.start(conversation.id, id),
    row: (id: string) => (service.read(conversation.id, 0).body as any).replies.find((reply: any) => reply.messageCommandId === id),
  };
}
const summaries: LlmProvider["extractJson"] = async args => ({ entries: JSON.parse(args.user).entries.map((entry: any) => ({ id: entry.id, text: "Earlier details omitted; use the original saved conversation when necessary." })) });

it("exposes compacting and cancellation without letting a non-cooperating summary block the next message", async () => {
  let finish!: (value: unknown) => void, signal: AbortSignal | undefined;
  const model: LlmProvider = { contextLimits: { contextWindowTokens: 16000, maxOutputTokens: 1024 }, runTools: vi.fn(),
    extractJson: vi.fn(args => { signal = args.signal; return new Promise(resolve => { finish = resolve; }); }), streamTools: vi.fn() };
  const f = await host(model);
  for (let i = 0; i < 12; i++) await f.add(`m${i}`, "Record ".repeat(500));
  f.start("m11"); await vi.waitFor(() => expect(f.row("m11").phase).toBe("compacting"));
  f.service().cancel(f.conversation.id, "m11"); expect(signal?.aborted).toBe(true);
  expect(f.row("m11").state).toBe("cancelled");
  const cachedBefore = f.sql().prepare("SELECT count(*) n FROM desktop_conversation_memory").get();
  finish({ entries: [{ id: "history", text: "late" }] }); await Promise.resolve(); await Promise.resolve();
  expect(f.sql().prepare("SELECT count(*) n FROM desktop_conversation_memory").get()).toEqual(cachedBefore);
  expect(model.streamTools).not.toHaveBeenCalled();
  model.extractJson = summaries; model.streamTools = vi.fn(async (_args, callbacks) => { callbacks.onTextDelta?.("Continued"); return { text: "Continued", done: true, toolCalls: [] }; });
  await f.add("next", "Continue"); expect(f.start("next").status).toBe(202);
  await vi.waitFor(() => expect(f.row("next").state).toBe("completed"));
});

it("recovers missing original detail through only scoped reads and preserves it after a database restart", async () => {
  let turn = 0;
  const model: LlmProvider = { runTools: vi.fn(), extractJson: summaries, streamTools: vi.fn(async (args, callbacks) => {
    turn++;
    if (turn === 1) return { text: "", done: false, toolCalls: [{ id: "find", name: "conversation_search", input: { query: "reference" } }] };
    if (turn === 2) { expect(args.messages.at(-1)?.content).toContain("early"); return { text: "", done: false, toolCalls: [{ id: "read", name: "conversation_read", input: { id: "early" } }] }; }
    expect(args.messages.at(-1)?.content).toContain("opaque-detail"); callbacks.onTextDelta?.("Recovered opaque-detail");
    return { text: "Recovered opaque-detail", done: true, toolCalls: [] };
  }) };
  const f = await host(model); await f.add("early", "Original reference: opaque-detail"); await f.add("ask", "Look up my reference");
  f.start("ask"); await vi.waitFor(() => expect(f.row("ask").state).toBe("completed"));
  expect(DesktopReplySchema.parse(f.row("ask"))).toMatchObject({ recallCount: 2, text: "Recovered opaque-detail" });
  expect((f.sql().prepare("SELECT count(*) n FROM desktop_reply_reads").get() as any).n).toBe(2);
  expect(f.service().readMemory(f.conversation.id, "ask").body).toMatchObject({ entries: [{ id: "early", user: "Original reference: opaque-detail" }] });
  await f.restart(); expect(f.start("ask").status).toBe(200); expect(turn).toBe(3); expect(f.row("ask").text).toContain("opaque-detail");
  expect(model.runTools).not.toHaveBeenCalled();
});

it("rebuilds a rejected chat context once before output, preserving the original current message", async () => {
  const inputs: any[] = [];
  const model: LlmProvider = { extractJson: summaries, runTools: vi.fn(), streamTools: vi.fn(async (args, handlers) => {
    inputs.push(structuredClone(args.messages));
    if (inputs.length === 1) throw new ModelContextOverflowError("remote_rejection");
    expect(args.messages.at(-1)?.content).toBe("Keep my current instruction exact");
    handlers.onTextDelta?.("Recovered"); return { text: "Recovered", done: true, toolCalls: [] };
  }) };
  const f = await host(model);
  for (let i = 0; i < 18; i++) await f.add(`m${i}`, "Earlier information ".repeat(180));
  await f.add("current", "Keep my current instruction exact"); f.start("current");
  await vi.waitFor(() => expect(f.row("current").state).toBe("completed"));
  expect(f.row("current").recoveryAttempts).toBe(1); expect(inputs).toHaveLength(2);
  expect(JSON.stringify(inputs[1]).length).toBeLessThan(JSON.stringify(inputs[0]).length);
  await f.restart(); f.start("current"); expect(inputs).toHaveLength(2);
});

it.each(["partial", "network", "twice"])("does not replay unsafe or repeated failures: %s", async mode => {
  let calls = 0;
  const model: LlmProvider = { extractJson: summaries, runTools: vi.fn(), streamTools: async (_args, handlers) => {
    calls++; if (mode === "partial") handlers.onTextDelta?.("Saved partial");
    throw mode === "network" ? new Error("private diagnostic") : new ModelContextOverflowError("remote_rejection");
  } };
  const f = await host(model); for (let i = 0; i < 18; i++) await f.add(`m${i}`, "Context ".repeat(400)); f.start("m17");
  await vi.waitFor(() => expect(f.row("m17").state).toBe("failed"));
  expect(calls).toBe(mode === "twice" ? 2 : 1); expect(JSON.stringify(f.row("m17"))).not.toContain("private diagnostic");
  if (mode === "partial") expect(f.row("m17").text).toBe("Saved partial");
});

it("history reads reject cross-conversation/future IDs and pin paginated originals by digest", async () => {
  const f = await host({ extractJson: summaries, runTools: vi.fn(), streamTools: vi.fn() });
  await f.add("early", "A".repeat(4000)); await f.add("future", "Never available to an earlier request");
  const reader = new ConversationHistoryReader(f.sql(), f.conversation.id, 1);
  const page = reader.execute({ id: "r", name: "conversation_read", input: { id: "early" } }) as any;
  expect(page.nextOffset).toBe(3000);
  expect(reader.execute({ id: "r", name: "conversation_read", input: { id: "early", offset: page.nextOffset, digest: page.digest } })).toMatchObject({ nextOffset: null });
  expect(reader.execute({ id: "r", name: "conversation_read", input: { id: "future" } })).toMatchObject({ error: "original_not_available" });
  expect(new ConversationHistoryReader(f.sql(), "other", 100).execute({ id: "r", name: "conversation_read", input: { id: "early" } })).toMatchObject({ error: "original_not_available" });
  expect(reader.execute({ id: "r", name: "conversation_read", input: { id: "early", digest: "0".repeat(64) } })).toMatchObject({ error: "original_changed" });
  expect(() => reader.execute({ id: "r", name: "workspace.execute", input: {} })).toThrow();
  expect(() => reader.execute({ id: "r", name: "conversation_search", input: { query: "A", conversationId: "other" } })).toThrow();
});
