import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { LlmProvider } from "@traceforge/llm";
import { ScenarioPackageRegistry } from "@traceforge/scenario-sdk";
import { ExtractiveContextCompactor } from "@traceforge/cognitive-runtime";
import { foundationHost, eventually, type FoundationHost } from "./foundation-host.js";
import { contextBinding, contextPackage } from "./context-package.js";
import { contextContentDigest, SqlitePackageContextStore } from "../package-context-resources.js";
import { SqliteRunPlannerStore } from "../run-planner.js";
import { SqliteRunObserverStore } from "../run-observer.js";

export const recallAcceptanceLimits = { maximumModelCalls: 6, modelCallTimeoutMs: 120000, maximumDurationMs: 750000 } as const;

/** Production HTTP Worker/supervisors with scripted history priming only.
 * No network target or native sandbox claim. The external provider decides recall
 * and completion; independent supervisors consume the persisted result. */
export async function runRecallModelAcceptance(provider: Pick<LlmProvider, "extractJson">, options: {
  outputParent: string; mode: "external_model" | "simulated_harness_test";
  modelIdentity: {provider: string; name: string};
  modelCallTimeoutMs?: number;
}) {
  const modelCallTimeoutMs = options.modelCallTimeoutMs ?? recallAcceptanceLimits.modelCallTimeoutMs;
  if (!Number.isSafeInteger(modelCallTimeoutMs) || modelCallTimeoutMs < 1 || modelCallTimeoutMs > recallAcceptanceLimits.modelCallTimeoutMs) throw new Error("invalid_model_timeout");
  const maximumDurationMs = modelCallTimeoutMs * recallAcceptanceLimits.maximumModelCalls + 30000;
  await mkdir(options.outputParent, {recursive:true});
  const root = await mkdtemp(join(options.outputParent, "traceforge-recall-"));
  const report = {mode:options.mode, model:options.modelIdentity, root, status:"failed", failure:null as string|null,
    primedReads:0, scriptedSupervisorWaits:0, omittedBeforeRecall:false, recovered:false, handoff:false, revoked:false,
    limits: { maximumModelCalls: recallAcceptanceLimits.maximumModelCalls, modelCallTimeoutMs, maximumDurationMs },
    calls:[] as Array<{role:string;stage:string;status:string;elapsedMs:number;totalTokens:number|null;failure:string|null}>,
    limitations:["History is primed by deterministic tool choices; only continuation and supervisor handoff use the supplied model",
      "Neutral reference fixture, not a blackbox investigation or cross-task memory test",
      "Six logical external calls maximum; provider internal retries and remote billing are not bounded by that count"]};
  const token = `observed-${randomBytes(12).toString("hex")}`;
  const content = "Neutral reference. ".repeat(40) + `Observed token: ${token}. ` + "End of reference.";
  const neutral = "No additional observation is available.";
  const filler = "Independent neutral reference; no security finding. ".repeat(23);
  const fillerDigest = contextContentDigest(filler);
  const digest = contextContentDigest(content), secondDigest = contextContentDigest(neutral);
  const pkg = contextPackage(["context.read","context.recall"]);
  pkg.definition.agentTopology = {...pkg.definition.agentTopology,
    planner:{...pkg.definition.agentTopology.planner,enabled:true}, observer:{...pkg.definition.agentTopology.observer,enabled:true}};
  pkg.definition.authorizationActions.push("context.recall");
  const policy = pkg.authorizationPolicy as {parseScope(value:unknown):{payload:unknown;allowedActions:string[];deniedActions:string[]}}; const parse = policy.parseScope;
  policy.parseScope = value => {const scope=parse(value); return {...scope,allowedActions:[...scope.allowedActions,"context.recall"]};};
  const first = pkg.resourceManifest!.resources[0]; first.digest = digest;
  first.context!.readerRoles = ["worker","planner","observer"];
  const fillers = Array.from({length:17},(_,i)=>({...structuredClone(first),id:`reference-${i+2}`,locator:`package:reference-${i+2}`,digest:fillerDigest}));
  pkg.resourceManifest!.resources = [...pkg.resourceManifest!.resources,...fillers,{...structuredClone(first), id:"second",locator:"package:second",digest:secondDigest}];
  let active: FoundationHost | undefined, workerTurns = 0, revoking = false;
  const stop = new AbortController(), timer = setTimeout(()=>stop.abort(),maximumDurationMs);
  const objective = "Recover the Observed token from the first reference already read in the tool history. "
    + "Use preserved receipt references to recover omitted detail; do not guess. Complete with exactly the token as summary and outputs: []. "
    + "Planner and Observer: while work is active, wait/continue without duplicate work. After completion, acknowledge its exact token in rationale, "
    + "without new work or a verified finding. If source text is withheld, do not repeat the token or infer its value.";
  try {
    active = await foundationHost({root,objective,modelTimeoutMs: modelCallTimeoutMs, contextLimits: { contextWindowTokens: 16000, maxOutputTokens: 1024 },
      // This acceptance deliberately forces omission to test recall, independently
      // of semantic summarizer quality or additional model calls.
      foundation:{contextCompactor:{ version: "acceptance-extractive-128", async compact(entries, maximum) {
        return new ExtractiveContextCompactor().compact(entries, Math.min(maximum, 128 * entries.length));
      } },scenarioPackageRegistry:new ScenarioPackageRegistry([pkg]),toolDiscoverySources:[],
        contextResourceContents:[{package:contextBinding,resourceId:"first",content},...fillers.map(resource=>({package:contextBinding,resourceId:resource.id,content:filler})),{package:contextBinding,resourceId:"second",content:neutral}]},
      model:async args => {
        stop.signal.throwIfAborted();
        const role = args.system.includes("strategic Planner") ? "planner" : args.system.includes("Run Observer") ? "observer" : "worker";
        const context = JSON.parse(args.user);
        if (role === "worker" && workerTurns++ < 19) {
          const last = workerTurns === 19; report.primedReads++;
          return {type:"invoke_tool",invocation:{id:`prime-${workerTurns}`,tool:"context.read",
            input:{id:last?"second":workerTurns===1?"first":`reference-${workerTurns}`,digest:last?secondDigest:workerTurns===1?digest:fillerDigest},rationale:"Prime neutral reference history"}};
        }
        if (role !== "worker" && (!report.recovered || !context.run?.workItems?.some((work:any)=>work.status==="completed"))) {
          report.scriptedSupervisorWaits++;
          return {action:role==="planner"?"wait":"continue",rationale:"Await assigned work"};
        }
        const stage = revoking ? "withdrawn" : role === "worker" ? "recall" : "handoff";
        if (report.calls.length >= recallAcceptanceLimits.maximumModelCalls) throw new Error("external_call_limit");
        if (role === "worker" && !report.calls.some(call=>call.role==="worker")) {
          if (context.manifest?.contextCompaction?.status !== "completed" || args.user.includes(token)) throw new Error("omission_not_exercised");
          report.omittedBeforeRecall = true;
        }
        if (role !== "worker" && args.user.includes(token) === revoking) {
          report.failure="handoff_source_projection_invalid";throw new Error(report.failure);
        }
        const call = {role,stage,status:"running",elapsedMs:0,totalTokens:null as number|null,failure:null as string|null}; report.calls.push(call);
        const started = Date.now();
        const signal = AbortSignal.any([stop.signal, args.signal ?? stop.signal, AbortSignal.timeout(modelCallTimeoutMs)]);
        let onAbort!:()=>void;
        const aborted = new Promise<never>((_,reject)=>{onAbort=()=>reject(new Error("model_deadline"));signal.addEventListener("abort",onAbort,{once:true});});
        try {
          signal.throwIfAborted();
          const result:any = await Promise.race([provider.extractJson({...args,signal,onUsage(usage){
            if (!signal.aborted) {call.totalTokens=(call.totalTokens??0)+usage.totalTokens;args.onUsage?.(usage);}
          }}),aborted]);
          signal.throwIfAborted();
          if (role === "worker") {
            if (result.type === "complete") {
              if (result.summary !== token || result.outputs?.length !== 0) throw new Error("incorrect_recovery");
              report.recovered = true;
            } else if (result.type !== "invoke_tool" || result.invocation?.tool !== "context.recall") throw new Error("recall_not_selected");
          } else {
            if (result.action !== (role==="planner"?"wait":"continue")) throw new Error("unsupported_role_action");
            if (typeof result.rationale !== "string" || result.rationale.includes(token) === revoking) throw new Error("incorrect_role_acknowledgement");
          }
          call.status="completed"; return result;
        } catch (error) {
          call.status="failed";
          call.failure = stop.signal.aborted ? "acceptance_deadline" : signal.aborted ? "model_deadline"
            : error instanceof Error && ["incorrect_recovery", "recall_not_selected", "unsupported_role_action", "incorrect_role_acknowledgement"].includes(error.message) ? error.message : "model_request_failed";
          report.failure = call.failure;
          throw new Error(call.failure);
        }
        finally {call.elapsedMs=Date.now()-started;signal.removeEventListener("abort",onAbort);}
      }});
    await active.start();
    const passed = (stage:string,role:string)=>report.calls.some(call=>call.stage===stage&&call.role===role&&call.status==="completed");
    await eventually(async()=>{
      if (stop.signal.aborted || report.failure || report.calls.some(call=>call.status==="failed")) throw new Error(report.failure??"continuation_failed");
      const state = await active!.state();
      if (["failed","blocked","cancelled"].includes(state.workItems[0]?.status)) {
        throw new Error("work_failed");
      }
      return state.workItems[0]?.status==="completed" && passed("handoff","planner") && passed("handoff","observer")
        && new SqliteRunPlannerStore(active!.sqlite).list("run").some(row=>row.applied&&JSON.stringify(row.decision).includes(token))
        && new SqliteRunObserverStore(active!.sqlite).list("run").some(row=>row.applied&&JSON.stringify(row.decision).includes(token));
    },maximumDurationMs);
    report.handoff=true; revoking=true;
    new SqlitePackageContextStore(active.sqlite).revoke(digest,"Acceptance source withdrawn");
    await eventually(async()=>{
      if (stop.signal.aborted || report.failure || report.calls.some(call=>call.status==="failed")) throw new Error(report.failure??"withdrawal_failed");
      return passed("withdrawn","planner")&&passed("withdrawn","observer");
    },maximumDurationMs);
    report.revoked=true; report.status="passed";
  } catch(error) {report.failure=error instanceof Error&&/^[a-z_]+$/.test(error.message)?error.message:"recall_acceptance_failed";}
  finally {
    clearTimeout(timer);stop.abort();await active?.close(false);
    await writeFile(join(root,"report.json"),JSON.stringify(report,null,2),{mode:0o600});
  }
  return report;
}
