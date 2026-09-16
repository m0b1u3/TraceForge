import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import Fastify from "fastify";
import type { LlmProvider, UsageSnapshot } from "@traceforge/llm";
import { waitForCancellation } from "@traceforge/worker-runtime";
import { createDb, getSqliteClient } from "../db/client.js";
import { registerConversationRoutes } from "../conversation-routes.js";
import { DesktopReplyService, registerDesktopReplyRoutes } from "../desktop-replies.js";

export const desktopMemoryLimits = { maximumModelCalls: 16, modelCallTimeoutMs: 120000, maximumDurationMs: 600000 } as const;
export async function runDesktopMemoryAcceptance(provider: LlmProvider, options: {
  outputParent: string; mode: "external_model" | "simulated_harness_test"; modelIdentity: { provider: string; name: string };
  continuationRounds?: number;
}) {
  if (!provider.streamTools) throw new Error("Streaming is required");
  const rounds = options.continuationRounds ?? 0;
  if (!Number.isSafeInteger(rounds) || rounds < 0 || rounds > 24) throw new Error("Invalid endurance rounds");
  const limits = { ...desktopMemoryLimits, maximumModelCalls: desktopMemoryLimits.maximumModelCalls + rounds * 3,
    maximumDurationMs: rounds ? 3000000 : desktopMemoryLimits.maximumDurationMs };
  await mkdir(options.outputParent, { recursive: true });
  const root = await mkdtemp(join(options.outputParent, "traceforge-desktop-memory-"));
  const report = { root, mode: options.mode, model: options.modelIdentity, status: "failed", failure: null as string | null, limits,
    continuationRoundsRequested: rounds, continuationRoundsCompleted: 0,
    endurance: [] as Array<{ round: number; answerCorrect: boolean; requestedOriginalsRead: boolean; successfulSourceIds: string[] }>,
    checks: { firstSummary: false, originalRecall: false, restartNoReplay: false, secondSummary: false, userCorrection: false },
    calls: [] as Array<{ stage: string; kind: string; elapsedMs: number; totalTokens: number | null; status: string }>,
    limitations: ["Real model through production conversation HTTP routes and SQLite; native window journey is a separate synthetic-protocol check",
      "History is synthetic; not hours-long endurance or blackbox outcome validation", "Consumer uses a 16k budget, not a claim about remote model maximum", "Logical call count does not include provider internal retries"] };
  const stop = new AbortController(), timer = setTimeout(() => stop.abort(), limits.maximumDurationMs);
  let stage = "first";
  async function tracked<T>(kind: string, signal: AbortSignal | undefined, operation: (signal: AbortSignal, usage: (value: UsageSnapshot) => void) => Promise<T>): Promise<T> {
    if (report.calls.length >= limits.maximumModelCalls) throw new Error("Call budget exhausted");
    const call = { stage, kind, elapsedMs: 0, totalTokens: null as number | null, status: "running" }; report.calls.push(call);
    const started = Date.now(), bounded = AbortSignal.any([stop.signal, AbortSignal.timeout(desktopMemoryLimits.modelCallTimeoutMs), ...(signal ? [signal] : [])]);
    try { const result = await waitForCancellation(() => operation(bounded, usage => { if (!bounded.aborted) call.totalTokens = (call.totalTokens ?? 0) + usage.totalTokens; }), bounded); call.status = "completed"; return result; }
    catch { call.status = "failed"; throw new Error("Model call unavailable"); }
    finally { call.elapsedMs = Date.now() - started; }
  }
  const model: LlmProvider = { contextLimits: { contextWindowTokens: 16000, maxOutputTokens: 2048 },
    runTools: async () => { throw new Error("No direct execution path"); },
    extractJson: args => tracked("summary", args.signal, (signal, onUsage) => provider.extractJson({ ...args, signal, onUsage })),
    streamTools: (args, handlers) => tracked("reply", handlers.signal, (signal, onUsage) => provider.streamTools!(args, { ...handlers, signal, onUsage })),
  };
  const path = join(root, "state.db");
  let db = createDb(path), sql = getSqliteClient(db), app = Fastify(), replies = new DesktopReplyService(sql, () => model);
  registerConversationRoutes(app, db); registerDesktopReplyRoutes(app, replies); await app.ready();
  const call = async (url: string, body?: object) => {
    const response = await app.inject({ url, method: body ? "POST" : "GET", ...(body ? { payload: body } : {}) });
    if (response.statusCode >= 300) throw new Error("Conversation route rejected request"); return response.json();
  };
  try {
    const conversation = await call("/api/desktop/conversations", { commandId: "create", title: "Neutral long conversation" });
    const base = `/api/desktop/conversations/${conversation.id}`;
    const detail = `reference-${randomBytes(6).toString("hex")}`, latest = `latest-${randomBytes(6).toString("hex")}`;
    await call(`${base}/messages`, { commandId: "early", text: `Saved original reference identifier: ${detail}. Earlier plan was tentative and may be superseded.` });
    const addHistory = async (start: number, count: number) => { for (let i = start; i < start + count; i++) await call(`${base}/messages`, { commandId: `history${i}`, text: `Neutral history ${i}. ` + "Background notes only; no changed goals and no executed actions. ".repeat(60) }); };
    await addHistory(0, 12);
    const answer = async (id: string, text: string) => {
      await call(`${base}/messages`, { commandId: id, text }); await call(`${base}/replies/${id}`, {});
      for (let i = 0; i < 5000; i++) {
        stop.signal.throwIfAborted();
        const row = (await call(`${base}/replies?after=0`)).replies.find((item: any) => item.messageCommandId === id);
        if (row.state === "completed") {
          return row;
        }
        if (row.state !== "streaming") throw new Error(`reply_${row.error ?? row.state}`);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error("Reply deadline");
    };
    const first = await answer("ask", "Use conversation_read to read the original saved message id early, even if you think you remember it. Reply with its exact reference identifier. Do not invent or execute external actions.");
    if (!first.contextTruncated || !report.calls.some(item => item.kind === "summary")) throw new Error("summary_not_exercised"); report.checks.firstSummary = true;
    if (!first.recallCount || !first.text.includes(detail)) throw new Error("original_recall_failed"); report.checks.originalRecall = true;
    const before = report.calls.length;
    await app.close(); sql.close(); db = createDb(path); sql = getSqliteClient(db); app = Fastify(); replies = new DesktopReplyService(sql, () => model);
    registerConversationRoutes(app, db); registerDesktopReplyRoutes(app, replies); await app.ready();
    await call(`${base}/replies/ask`, {});
    if (report.calls.length !== before) throw new Error("restart_replayed_model"); report.checks.restartNoReplay = true;
    stage = "continued";
    await addHistory(12, 8);
    await call(`${base}/messages`, { commandId: "correction", text: `User correction: discard the tentative earlier plan. The current plan identifier is ${latest}. This supersedes the earlier plan, not the saved reference.` });
    const second = await answer("next", "Read the original saved message early again using conversation_read. Reply with its reference identifier and the current plan identifier from my latest correction, not the tentative earlier plan.");
    if (!second.contextTruncated || !report.calls.some(item => item.stage === "continued" && item.kind === "summary")) throw new Error("second_summary_not_exercised"); report.checks.secondSummary = true;
    if (!second.text.includes(detail) || !second.text.includes(latest) || !second.recallCount) throw new Error("correction_not_preserved"); report.checks.userCorrection = true;
    for (let round = 0; round < rounds; round++) {
      stage = `endurance_${round + 1}`;
      if (round % 4 === 0) await addHistory(20 + round, 1);
      const response = await answer(`endurance${round}`, "Use conversation_read to read original message early and correction now. Reply briefly with the exact saved reference and current plan identifier. No external actions.");
      const reads = sql.prepare("SELECT tool,result_json FROM desktop_reply_reads WHERE conversation_id=? AND message_id=?").all(conversation.id, `endurance${round}`) as Array<{tool:string;result_json:string}>;
      const successfulSourceIds = reads.flatMap(row => {
        const result = JSON.parse(row.result_json);
        if (row.tool === "conversation_read" && !result.error && result.digest) return [result.id as string];
        if (row.tool === "conversation_read_sources") return (result.sources ?? []).map((source: {id:string}) => source.id);
        return [];
      });
      report.endurance.push({ round: round + 1, answerCorrect: response.text.includes(detail) && response.text.includes(latest),
        requestedOriginalsRead: ["early", "correction"].every(id => successfulSourceIds.includes(id)), successfulSourceIds });
      report.continuationRoundsCompleted++;
    }
    if (report.endurance.some(round => !round.answerCorrect)) throw new Error("original_recall_failed");
    if (report.endurance.some(round => !round.requestedOriginalsRead)) throw new Error("fresh_read_not_exercised");
    report.status = "passed";
  } catch (error) {
    const known = ["summary_not_exercised", "original_recall_failed", "fresh_read_not_exercised", "restart_replayed_model", "second_summary_not_exercised", "correction_not_preserved", "reply_timeout", "reply_context_limit", "reply_recall_limit", "reply_provider_failed"];
    report.failure = error instanceof Error && known.includes(error.message) ? error.message : "desktop_memory_acceptance_failed";
  } finally { stop.abort(); clearTimeout(timer); await app.close(); sql.close(); await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 }); }
  return report;
}
