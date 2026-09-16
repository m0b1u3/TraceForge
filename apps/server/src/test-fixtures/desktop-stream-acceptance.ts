import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import Fastify from "fastify";
import type { LlmProvider } from "@traceforge/llm";
import { createDb, getSqliteClient } from "../db/client.js";
import { registerConversationRoutes } from "../conversation-routes.js";
import { DesktopReplyService, registerDesktopReplyRoutes } from "../desktop-replies.js";

export const desktopStreamLimits = { maximumModelCalls: 4, modelCallTimeoutMs: 90000, maximumDurationMs: 240000 } as const;
/** Exercises real streaming through production reply routes, with isolated,
 * neutral history only. No credentials, model text or user data in the report. */
export async function runDesktopStreamAcceptance(provider: LlmProvider, options: {
  outputParent: string; mode: "external_model" | "simulated_harness_test"; modelIdentity: { provider: string; name: string };
}) {
  if (!provider.streamTools) throw new Error("Streaming required");
  await mkdir(options.outputParent, { recursive: true });
  const root = await mkdtemp(join(options.outputParent, "traceforge-desktop-stream-"));
  const report = { root, mode: options.mode, model: options.modelIdentity, status: "failed", failure: null as string | null, limits: desktopStreamLimits,
    checks: { replyBeforeCompletion: false, toolRecorded: false, referenceCorrect: false, cancelPreservesPartial: false, lateWritesIgnored: false, restartNoReplay: false },
    observations: { firstVisibleTextMs: null as number | null, firstVisibleReasoningMs: null as number | null, reasoningCharacters: 0, visibleTextRevisions: 0, visibleReasoningRevisions: 0 },
    calls: [] as Array<{ elapsedMs: number; totalTokens: number | null; status: string; textDeltas: number; reasoningDeltas: number }>,
    limitations: ["Production model gateway and conversation HTTP routes; not a native-window acceptance", "Only isolated conversation history tools; no shell commands or external targets", "Public reasoning is optional; absence is reported rather than fabricated", "Cancelled requests may not report final usage; logical calls exclude upstream retries"] };
  const start = Date.now(), stop = new AbortController(), timer = setTimeout(() => stop.abort(), desktopStreamLimits.maximumDurationMs);
  const model: LlmProvider = { contextLimits: provider.contextLimits, extractJson: async () => { throw new Error("Compaction not expected in this small fixture"); }, runTools: async () => { throw new Error("Streaming only"); },
    streamTools: async (args, handlers) => {
      if (report.calls.length >= desktopStreamLimits.maximumModelCalls) throw new Error("Call budget exhausted");
      const call = { elapsedMs: 0, totalTokens: null as number | null, status: "running", textDeltas: 0, reasoningDeltas: 0 }; report.calls.push(call);
      const at = Date.now(), signal = AbortSignal.any([stop.signal, AbortSignal.timeout(desktopStreamLimits.modelCallTimeoutMs), ...(handlers.signal ? [handlers.signal] : [])]);
      try {
        const result = await provider.streamTools!(args, { ...handlers, signal,
          onTextDelta: value => { call.textDeltas++; handlers.onTextDelta?.(value); },
          onReasoningDelta: value => { call.reasoningDeltas++; handlers.onReasoningDelta?.(value); },
          onUsage: value => { call.totalTokens = (call.totalTokens ?? 0) + value.totalTokens; handlers.onUsage?.(value); },
        }); call.status = "completed"; return result;
      } catch { call.status = signal.aborted ? "cancelled" : "failed"; throw new Error("Model stream unavailable"); }
      finally { call.elapsedMs = Date.now() - at; }
    },
  };
  const path = join(root, "state.db");
  let db = createDb(path), sql = getSqliteClient(db), app = Fastify(), replies = new DesktopReplyService(sql, () => model);
  const attach = async () => { registerConversationRoutes(app, db); registerDesktopReplyRoutes(app, replies); await app.ready(); };
  const call = async (url: string, body?: object) => {
    const response = await app.inject({ url, method: body ? "POST" : "GET", ...(body ? { payload: body } : {}) });
    if (response.statusCode >= 300) throw new Error("route_rejected"); return response.json();
  };
  const check = (condition: unknown, name: string) => { if (!condition) throw new Error(name); };
  try {
    await attach();
    const c = await call("/api/desktop/conversations", { commandId: "create", title: "Model streaming acceptance — isolated" }), base = `/api/desktop/conversations/${c.id}`;
    const reference = `reference-${randomBytes(6).toString("hex")}`;
    await call(`${base}/messages`, { commandId: "early", text: `Synthetic saved reference: ${reference}. No task execution is authorized or requested.` });
    await call(`${base}/messages`, { commandId: "ask", text: "Use conversation_read to read message id early now. Then include its exact reference and explain in twelve numbered sentences how to organize ordinary notes. No external actions. Respond in Chinese." });
    await call(`${base}/replies/ask`, {});
    let final: any, previousText = "", previousReasoning = "";
    while (true) {
      stop.signal.throwIfAborted();
      const row = (await call(`${base}/replies?after=0`)).replies.find((r: any) => r.messageCommandId === "ask");
      if (row.state === "streaming") {
        if (row.text && row.text !== previousText) { report.observations.visibleTextRevisions++; report.observations.firstVisibleTextMs ??= Date.now() - start; report.checks.replyBeforeCompletion = true; }
        if (row.reasoning && row.reasoning !== previousReasoning) { report.observations.visibleReasoningRevisions++; report.observations.firstVisibleReasoningMs ??= Date.now() - start; }
      }
      previousText = row.text; previousReasoning = row.reasoning ?? "";
      if (row.state !== "streaming") { final = row; break; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    check(final.state === "completed", `reply_${final.error ?? final.state}`);
    report.observations.reasoningCharacters = final.reasoning?.length ?? 0;
    check(report.checks.replyBeforeCompletion, "no_visible_partial_reply");
    report.checks.toolRecorded = final.toolActivity?.some((item: any) => item.tool === "conversation_read") === true;
    report.checks.referenceCorrect = final.text.includes(reference);
    check(report.checks.toolRecorded && report.checks.referenceCorrect, "history_tool_not_verified");
    const count = report.calls.length;
    await app.close(); sql.close(); db = createDb(path); sql = getSqliteClient(db); app = Fastify(); replies = new DesktopReplyService(sql, () => model); await attach();
    const restored = await call(`${base}/replies/ask`, {});
    report.checks.restartNoReplay = report.calls.length === count && restored.text === final.text && restored.reasoning === final.reasoning;
    check(report.checks.restartNoReplay, "restart_changed_result");
    await call(`${base}/messages`, { commandId: "cancel", text: "Do not use tools. Write forty numbered paragraphs in Chinese about organizing personal notes. This is a streaming cancellation test; no external actions." });
    await call(`${base}/replies/cancel`, {});
    while (true) {
      stop.signal.throwIfAborted();
      const row = (await call(`${base}/replies?after=0`)).replies.find((r: any) => r.messageCommandId === "cancel");
      check(row.state === "streaming", "cancel_window_not_observed");
      if (row.text || row.reasoning) {
        const cancelled = await call(`${base}/replies/cancel/cancel`, {});
        report.checks.cancelPreservesPartial = cancelled.state === "cancelled" && (cancelled.text.length + (cancelled.reasoning?.length ?? 0)) > 0;
        await new Promise(resolve => setTimeout(resolve, 350));
        const after = (await call(`${base}/replies?after=0`)).replies.find((r: any) => r.messageCommandId === "cancel");
        report.checks.lateWritesIgnored = after.revision === cancelled.revision && after.text === cancelled.text && after.reasoning === cancelled.reasoning;
        check(report.checks.cancelPreservesPartial && report.checks.lateWritesIgnored, "cancel_did_not_preserve"); break;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    report.status = "passed";
  } catch (error) {
    const allowed = /^(reply_[a-z_]+|no_visible_partial_reply|history_tool_not_verified|restart_changed_result|cancel_window_not_observed|cancel_did_not_preserve)$/;
    report.failure = error instanceof Error && allowed.test(error.message) ? error.message : "stream_acceptance_failed";
  } finally { stop.abort(); clearTimeout(timer); await app.close(); sql.close(); await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 }); }
  return report;
}
