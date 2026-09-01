import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmProvider, UsageSnapshot } from "@traceforge/llm";
import { foundationHost, type FoundationHost } from "./foundation-host.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const objective = "Read the current observation token using the exposed fixture.read tool with input {}. "
  + "If a successful tool observation already exists in the transcript, reuse it without calling the tool again. "
  + "Complete with the exact observed token in summary, and outputs: []. Do not guess a token or claim any security finding.";

export interface ModelAcceptanceReport {
  format: "traceforge.foundation-model-acceptance.v1";
  mode: "external_model" | "simulated_harness_test";
  model: { provider: string; name: string } | null;
  status: "passed" | "failed";
  root: string;
  elapsedMs: number;
  failure: string | null;
  limits: { maximumModelCalls: number; maximumDurationMs: number; modelCallTimeoutMs: number };
  calls: Array<{ ordinal: number; promptSha256: string; responseSha256?: string; elapsedMs: number;
    status: "running" | "completed" | "failed"; usage: UsageSnapshot | null }>;
  cases: Array<{ name: string; toolCalls: number; callsAfterRestart: number | null; observationSha256: string;
    resultSha256: string; modelCalls: number; snapshots: number; checkpointCount: number; receiptCount: number; integrity: string }>;
  limitations: string[];
}

class AcceptanceFailure extends Error {}
function requireCheck(condition: unknown, name: string): asserts condition {
  if (!condition) throw new AcceptanceFailure(name);
}

/** Test-only composition. The CLI always supplies createProvider(config); offline tests are explicitly labelled simulated. */
export async function runFoundationModelAcceptance(provider: Pick<LlmProvider, "extractJson">, options: {
  mode: ModelAcceptanceReport["mode"]; outputParent?: string; maximumDurationMs?: number;
  modelIdentity?: { provider: string; name: string };
  signal?: AbortSignal;
  maximumModelCalls?: number; modelCallTimeoutMs?: number;
}): Promise<ModelAcceptanceReport> {
  const maximumDurationMs = options.maximumDurationMs ?? 120000;
  const maximumModelCalls = options.maximumModelCalls ?? 6;
  const modelCallTimeoutMs = options.modelCallTimeoutMs ?? 30000;
  requireCheck(Number.isSafeInteger(maximumDurationMs) && maximumDurationMs >= 100 && maximumDurationMs <= 180000, "invalid_duration");
  requireCheck(Number.isSafeInteger(maximumModelCalls) && maximumModelCalls >= 1 && maximumModelCalls <= 8, "invalid_call_limit");
  requireCheck(Number.isSafeInteger(modelCallTimeoutMs) && modelCallTimeoutMs >= 1 && modelCallTimeoutMs <= 60000, "invalid_call_timeout");
  const parent = options.outputParent ?? tmpdir(); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "traceforge-model-"));
  const start = Date.now(), abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error("Acceptance deadline")), maximumDurationMs);
  const interrupted = () => abort.abort(new Error("Acceptance interrupted"));
  options.signal?.addEventListener("abort", interrupted, { once: true });
  if (options.signal?.aborted) interrupted();
  const abortReason = () => options.signal?.aborted ? "interrupted" : "deadline_exceeded";
  const report: ModelAcceptanceReport = { format: "traceforge.foundation-model-acceptance.v1", mode: options.mode,
    model: options.modelIdentity ?? null,
    status: "failed", root, elapsedMs: 0, failure: "incomplete", limits: { maximumModelCalls, maximumDurationMs, modelCallTimeoutMs }, calls: [], cases: [],
    limitations: ["Neutral fixture tools, not security investigation effectiveness or native sandbox certification",
      "Logical call/time limits do not cap provider-internal HTTP retries, output tokens or remote billing",
      "A restart recreates the host and SQLite connection in this process; it is not SIGKILL or power-loss validation",
      "Local cancellation does not prove remote inference stopped; reported usage can be missing"] };
  let active: FoundationHost | undefined;
  const model: LlmProvider["extractJson"] = async (args) => {
    requireCheck(!abort.signal.aborted, abortReason());
    requireCheck(report.calls.length < maximumModelCalls, "model_call_limit_exceeded");
    const input = JSON.stringify({ system: args.system, user: args.user, schema: args.schema });
    requireCheck(Buffer.byteLength(input) <= 128 * 1024, "model_input_too_large");
    const record: ModelAcceptanceReport["calls"][number] = { ordinal: report.calls.length + 1, promptSha256: digest(input),
      elapsedMs: 0, status: "running", usage: null };
    report.calls.push(record);
    const started = Date.now(), signal = args.signal ? AbortSignal.any([args.signal, abort.signal]) : abort.signal;
    const cancelled = () => { record.status = "failed"; record.elapsedMs = Date.now() - started; };
    signal.addEventListener("abort", cancelled, { once: true });
    try {
      signal.throwIfAborted();
      const value = await provider.extractJson({ ...args, signal, onUsage(usage) {
        if (signal.aborted || record.status !== "running") return;
        record.usage = record.usage ? { promptTokens: record.usage.promptTokens + usage.promptTokens,
          completionTokens: record.usage.completionTokens + usage.completionTokens, totalTokens: record.usage.totalTokens + usage.totalTokens } : { ...usage };
        args.onUsage?.(usage);
      } });
      signal.throwIfAborted();
      const output = JSON.stringify(value);
      requireCheck(typeof output === "string" && Buffer.byteLength(output) <= 64 * 1024, "model_output_too_large");
      record.responseSha256 = digest(output); record.status = "completed";
      return value;
    } catch (error) {
      record.status = "failed";
      // Never persist an upstream error body, URL, credential or headers in the test database/report.
      throw new AcceptanceFailure(error instanceof AcceptanceFailure ? error.message : "model_request_failed");
    } finally { record.elapsedMs = Date.now() - started; signal.removeEventListener("abort", cancelled); }
  };
  async function waitFor(h: FoundationHost, expected: string) {
    while (!abort.signal.aborted) {
      const state = await h.state(), work = state.workItems[0];
      if (work?.status === expected) return state;
      requireCheck(!["failed", "blocked", "completed", "cancelled"].includes(work?.status), "unexpected_work_outcome");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new AcceptanceFailure(abortReason());
  }
  try {
    // An abrupt process death must leave an explicit incomplete artifact, never a stale pass.
    await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
    for (const name of ["normal", "checkpoint_restart"] as const) {
      requireCheck(!abort.signal.aborted, abortReason());
      const observationToken = `observation-${randomBytes(16).toString("hex")}`;
      const caseRoot = join(root, name); await mkdir(caseRoot);
      const hostOptions = { root: caseRoot, model, observationToken, objective, modelTimeoutMs: modelCallTimeoutMs };
      active = await foundationHost({ ...hostOptions, failResultCheckpoint: name === "checkpoint_restart" });
      await active.start();
      let totalToolCalls = 0, callsAfterRestart: number | null = null;
      if (name === "checkpoint_restart") {
        const interrupted = await waitFor(active, "failed");
        requireCheck(active.calls() === 1 && interrupted.workItems[0].latestCheckpoint, "missing_interrupted_tool_result");
        requireCheck(!JSON.stringify(active.requests[0]).includes(observationToken), "observation_leaked_before_tool");
        totalToolCalls += active.calls(); await active.close(false); active = undefined;
        active = await foundationHost(hostOptions);
        await active.request("/api/scenarios/runs/run/work/work/continue", { commandId: "resume-model-acceptance", actor: "test-only",
          reason: "Resume confirmed observation", expectedRevision: interrupted.revision,
          checkpointRef: interrupted.workItems[0].latestCheckpoint.payloadRef });
      }
      const state = await waitFor(active, "completed");
      totalToolCalls += active.calls();
      if (name === "checkpoint_restart") callsAfterRestart = active.calls();
      requireCheck(totalToolCalls === 1 && (callsAfterRestart === null || callsAfterRestart === 0), "tool_repeated_or_not_called");
      requireCheck(state.workItems.length === 1 && state.workItems[0].attempt === 1, "work_identity_changed");
      requireCheck(state.workItems[0].resultSummary?.includes(observationToken), "completion_missing_observed_token");
      requireCheck(active.requests.some((request) => request.transcript.some((entry: { kind: string; summary: string }) =>
        entry.kind === "tool" && entry.summary.includes(observationToken))), "model_did_not_receive_observation");
      if (name === "normal") requireCheck(!JSON.stringify(active.requests[0]).includes(observationToken), "observation_leaked_before_tool");
      const count = (table: string) => (active!.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
      const modelCalls = active.sqlite.prepare("SELECT status FROM scenario_model_calls").all() as Array<{ status: string }>;
      requireCheck(modelCalls.length >= 2 && modelCalls.every((call) => call.status === "completed"), "model_calls_not_completed");
      const receiptCount = count("worker_tool_receipts"), checkpointCount = count("worker_checkpoints");
      const integrity = (active.sqlite.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
      requireCheck(receiptCount === 1 && checkpointCount >= 2 && integrity === "ok", "persistence_check_failed");
      report.cases.push({ name, toolCalls: totalToolCalls, callsAfterRestart, observationSha256: digest(observationToken),
        resultSha256: digest(state.workItems[0].resultSummary), modelCalls: modelCalls.length,
        snapshots: count("scenario_cognitive_snapshots"), receiptCount, checkpointCount, integrity });
      await active.close(false); active = undefined;
    }
    requireCheck(!abort.signal.aborted, abortReason());
    report.status = "passed"; report.failure = null;
  } catch (error) { report.failure = error instanceof AcceptanceFailure ? error.message : "host_acceptance_failed"; }
  finally {
    abort.abort(); clearTimeout(timer);
    options.signal?.removeEventListener("abort", interrupted);
    try { await active?.close(false); }
    catch { report.status = "failed"; report.failure ??= "host_cleanup_failed"; }
    report.elapsedMs = Date.now() - start;
    await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  }
  return report;
}
