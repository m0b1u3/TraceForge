import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { LlmProvider } from "@traceforge/llm";
import { ContextCompactionRuntime, StructuredRunPlannerModel, StructuredRunObserverModel, StructuredWorkerModel } from "@traceforge/cognitive-runtime";
import { SqliteContextCompactionStore } from "../context-compaction-store.js";
import { database, initialize, definition } from "./execution-recovery.js";

/** Adapter/compaction acceptance, NOT an autonomous multi-Agent investigation.
 * Real callers inject a real provider; deterministic tests declare simulation. */
export async function runCognitiveModelAcceptance(provider: Pick<LlmProvider, "extractJson">, options: {
  outputParent: string; mode: "external_model" | "simulated_harness_test"; modelIdentity: {provider: string; name: string};
}) {
  await mkdir(options.outputParent, {recursive: true});
  const root = await mkdtemp(join(options.outputParent, "traceforge-cognitive-"));
  const sqlite = database(join(root, "state.db"));
  const report = { mode: options.mode, model: options.modelIdentity, root, status: "failed", failure: null as string | null,
    calls: [] as Array<{role: string; status: string; compacted: boolean}>,
    cacheReused: false, limitations: ["Role adapters are called sequentially by the harness, not by autonomous supervisors",
      "Controlled excerpts only; no general semantic-summary or cross-Run long-term-memory certification",
      "Tool observation is synthetic here; actual RPC/tool recovery is covered by the separate foundation suite"] };
  const stop = new AbortController(), timer = setTimeout(() => stop.abort(), 120000);
  let role = "planner";
  try {
    await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2), {mode: 0o600});
    const control = initialize(sqlite), run = structuredClone(control.runtime.load("run")!);
    run.goal = "The assigned work is already running. Do not create duplicate work or claim a finding. Wait for its completion.";
    const token = `observed-${randomBytes(12).toString("hex")}`;
    const narrative = `Observed token: ${token}. ` + "Neutral observation with no verified security impact. ".repeat(900);
    run.workItems[0].resultSummary = narrative;
    const graph = {caseId: run.caseId, revision: 0, nodes: [], edges: [], createdAt: run.createdAt, updatedAt: run.updatedAt};
    const store = new SqliteContextCompactionStore(sqlite);
    const compaction = new ContextCompactionRuntime(store);
    const model: Pick<LlmProvider, "extractJson"> = { async extractJson(args) {
      if (report.calls.length >= 3 || stop.signal.aborted) throw new Error("call_limit");
      const context = JSON.parse(args.user), manifest = context.contextManifest ?? context.manifest;
      const call = {role, status: "running", compacted: manifest?.contextCompaction?.status === "completed"}; report.calls.push(call);
      if (!call.compacted || context.compactedText?.trust !== "untrusted_summary") throw new Error("compaction_not_exercised");
      const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(30000)]);
      let rejectAbort!: () => void;
      const aborted = new Promise<never>((_, reject) => { rejectAbort = () => reject(new Error("model_deadline")); signal.addEventListener("abort", rejectAbort, {once:true}); });
      try { const result = await Promise.race([provider.extractJson({...args, signal}), aborted]); call.status = "completed"; return result; }
      catch { call.status = "failed"; throw new Error("model_call_failed"); }
      finally { signal.removeEventListener("abort", rejectAbort); }
    } };
    const snapshot = {contextId: "planner", run, graph, recentEvents: [], maximumGraphNodes: 1, maximumRunItems: 1};
    const planner = await new StructuredRunPlannerModel(model, undefined, undefined, undefined, undefined, undefined, compaction)
      .evaluate({...snapshot, definition});
    if (planner.action !== "wait") throw new Error("planner_did_not_preserve_existing_work");
    role = "observer";
    const observer = await new StructuredRunObserverModel(model, undefined, undefined, undefined, undefined, undefined, compaction)
      .evaluate({...snapshot, contextId: "observer"});
    if (observer.action !== "continue") throw new Error("observer_changed_unsupported_state");
    role = "worker";
    const work = {...run.workItems[0], objective: "Reuse the existing tool observation. Complete with exactly its Observed token value as summary and outputs: []. Do not execute another tool."};
    const worker = await new StructuredWorkerModel(model, undefined, undefined, undefined, undefined, undefined, compaction).decide({
      turnId: "worker", worker: {id:"worker", roles:["observer"], capabilities:["observe"], maxConcurrentWork:1, status:"online", heartbeatAt:run.updatedAt},
      assignment: {runId:run.id, leaseId:"lease", leaseExpiresAt:"2099-01-01T00:00:00.000Z", runRevision:run.revision, work,
        runContext:{caseId:run.caseId, goal:run.goal, scopeRef:run.scopeRef, activePhaseId:run.activePhaseId, directives:[]}},
      tools:[], toolResolution:{requestedCapabilities:[], unresolvedCapabilities:[], registryRevision:1},
      transcript:[{turn:1, kind:"tool", summary:narrative, refs:["test-observation"]}], steering:[],
    }, stop.signal);
    if (worker.type !== "complete" || worker.summary !== token || worker.outputs.length) throw new Error("worker_lost_observation_or_invented_output");
    const input = {caseId:run.caseId, runId:run.id, consumer:"cache-check", context:{transcript:[{summary:narrative}]}, sourceFingerprint:"fixture"};
    await compaction.prepare(input);
    const replay = await new ContextCompactionRuntime(new SqliteContextCompactionStore(sqlite)).prepare(input);
    report.cacheReused = (replay.manifest.contextCompaction as {replayed:boolean}).replayed;
    if (!report.cacheReused) throw new Error("cache_reconstruction_failed");
    report.status = "passed";
  } catch (error) { report.failure = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "cognitive_acceptance_failed"; }
  finally { clearTimeout(timer); stop.abort(); sqlite.close(); await writeFile(join(root,"report.json"), JSON.stringify(report,null,2),{mode:0o600}); }
  return report;
}
