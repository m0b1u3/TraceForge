import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import Fastify from "fastify";
import type { LlmProvider } from "@traceforge/llm";
import { waitForCancellation } from "@traceforge/worker-runtime";
import { createDb, getSqliteClient } from "../db/client.js";
import { registerConversationRoutes } from "../conversation-routes.js";
import { DesktopReplyService } from "../desktop-replies.js";

/** Real-provider probe: the model discovers source IDs and writes notes itself.
 * Sources are synthetic; database reopen is not a native window restart. */
export async function runKnowledgeMemoryAcceptance(provider: LlmProvider, options: {
  outputParent: string; mode: "external_model" | "simulated_harness_test";
  modelIdentity: { provider: string; name: string };
}) {
  await mkdir(options.outputParent, { recursive: true });
  const root = await mkdtemp(join(options.outputParent, "traceforge-knowledge-"));
  const stop = new AbortController(), timer = setTimeout(() => stop.abort(), 900000);
  let stage = "recall";
  const report = { root, mode: options.mode, model: options.modelIdentity, status: "failed", failure: null as string | null,
    checks: { compressed: false, recalledOriginal: false, sourcedTopic: false, correction: false, restartNoReplay: false, restoredTopic: false, topicInjected: false },
    calls: [] as Array<{ stage: string; kind: string; elapsedMs: number; totalTokens: number | null; status: string }>,
    tools: [] as string[], limitations: ["Synthetic local conversation; no external target or task execution", "Database reopened, not native desktop process restart", "No attachment or hours-long durability claim"] };
  async function tracked<T>(kind: string, signal: AbortSignal | undefined, run: (signal: AbortSignal, usage: (value: { totalTokens: number }) => void) => Promise<T>) {
    if (report.calls.length >= 32) throw new Error("call_budget");
    const call = { stage, kind, elapsedMs: 0, totalTokens: null as number | null, status: "running" }; report.calls.push(call);
    const started = Date.now(), bounded = AbortSignal.any([stop.signal, AbortSignal.timeout(120000), ...(signal ? [signal] : [])]);
    try { const result = await waitForCancellation(() => run(bounded, usage => { call.totalTokens = (call.totalTokens ?? 0) + usage.totalTokens; }), bounded); call.status = "completed"; return result; }
    finally { if (call.status === "running") call.status = "failed"; call.elapsedMs = Date.now() - started; }
  }
  const model: LlmProvider = { contextLimits: { contextWindowTokens: 16000, maxOutputTokens: 2048 },
    runTools: async () => { throw new Error("unused_path"); },
    extractJson: args => tracked("summary_or_semantic", args.signal, (signal, onUsage) => provider.extractJson({ ...args, signal, onUsage })),
    streamTools: (args, handlers) => {
      if (stage === "restart" && args.messages.some(m => m.content.includes('"trust":"untrusted_topic_memory"') && m.content.includes('"key":"archive_status"'))) report.checks.topicInjected = true;
      return tracked("reply", handlers.signal, (signal, onUsage) => provider.streamTools!(args, { ...handlers, signal, onUsage }));
    },
  };
  const file = join(root, "state.db");
  let db = createDb(file), sql = getSqliteClient(db), app = Fastify(); registerConversationRoutes(app, db);
  let service = new DesktopReplyService(sql, () => model);
  const assert = (ok: unknown, code: string) => { if (!ok) throw new Error(code); };
  try {
    const conversation = (await app.inject({ method: "POST", url: "/api/desktop/conversations", payload: { commandId: "create", title: "Synthetic sourced memory" } })).json();
    const send = async (id: string, text: string) => {
      const response = await app.inject({ method: "POST", url: `/api/desktop/conversations/${conversation.id}/messages`, payload: { commandId: id, text } });
      assert(response.statusCode < 300, "save_failed");
    };
    const answer = async (id: string, text: string) => {
      await send(id, text); service.start(conversation.id, id);
      while (!stop.signal.aborted) {
        const reply = (service.read(conversation.id, 0).body as any).replies.find((r: any) => r.messageCommandId === id);
        if (reply && !["streaming", "queued"].includes(reply.state)) { assert(reply.state === "completed", `reply_${reply.error ?? reply.state}`); return reply; }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error("deadline");
    };
    const first = `sample-${randomBytes(6).toString("hex")}`, corrected = `revised-${randomBytes(6).toString("hex")}`;
    await send("source", `For the synthetic archive investigation, the provisional reference identifier is ${first}. Its result remains unverified. No external action has been performed.`);
    for (let i = 0; i < 14; i++) await send(`background${i}`, `Background ${i}. ` + "Neutral archived discussion; no new findings, no changed permissions, no executed actions. ".repeat(60));
    const recall = await answer("recall", "Find the earlier provisional reference for the archive investigation using memory_recall (semantic=true). Read its original using conversation_read_sources or conversation_read. Save a topic section with key archive_status using memory_update, citing that original. Include its exact identifier and unverified status. Do not execute anything.");
    report.checks.compressed = recall.contextTruncated && report.calls.some(c => c.kind === "summary_or_semantic");
    const tools = () => (sql.prepare("SELECT tool FROM desktop_reply_reads ORDER BY rowid").all() as { tool: string }[]).map(r => r.tool);
    report.checks.recalledOriginal = recall.text.includes(first) && tools().some(t => ["conversation_read_sources", "conversation_read"].includes(t));
    const notes = () => (sql.prepare("SELECT body FROM desktop_knowledge_versions WHERE conversation_id=? AND key='archive_status' ORDER BY revision").all(conversation.id) as { body: string }[]).map(r => JSON.parse(r.body));
    report.checks.sourcedTopic = notes().some(n => n.sources.some((s: any) => s.id === "source") && n.text.includes(first));
    stage = "correction";
    await send("amendment", `Correction: the provisional archive identifier ${first} is superseded. The current identifier is ${corrected}. This remains unverified; no external action has been performed.`);
    await answer("revise", "The preceding correction replaces the old archive identifier. Read the original correction and existing topic, then update archive_status with its current revision and correction source. Keep its unverified status. Do not execute anything.");
    const latest = notes().at(-1);
    report.checks.correction = latest?.revision >= 2 && latest.text.includes(corrected) && latest.sources.some((s: any) => s.id === "amendment");
    stage = "restart";
    const before = report.calls.length, versions = notes().length;
    service.close(); await app.close(); sql.close(); db = createDb(file); sql = getSqliteClient(db); app = Fastify(); registerConversationRoutes(app, db); service = new DesktopReplyService(sql, () => model);
    service.start(conversation.id, "revise");
    report.checks.restartNoReplay = report.calls.length === before && notes().length === versions;
    const restored = await answer("resume", "From the saved topic, state only the CURRENT archive reference identifier and whether it is verified. Do not repeat the superseded identifier or perform actions.");
    report.checks.restoredTopic = restored.text.includes(corrected) && !restored.text.includes(first);
    report.tools = tools();
    report.status = Object.values(report.checks).every(Boolean) ? "passed" : "failed";
    if (report.status !== "passed") report.failure = "check_failed";
  } catch { report.failure = "knowledge_acceptance_failed"; }
  finally { service.close(); await app.close(); sql.close(); stop.abort(); clearTimeout(timer); await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 }); }
  return report;
}
