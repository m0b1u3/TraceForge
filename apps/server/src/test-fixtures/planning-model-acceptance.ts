import {mkdir,mkdtemp,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {randomBytes} from "node:crypto";
import type {LlmProvider} from "@traceforge/llm";
import {ScenarioPackageRegistry} from "@traceforge/scenario-sdk";
import {contextPackage} from "./context-package.js";
import {foundationHost,eventually,type FoundationHost} from "./foundation-host.js";
import {SqliteRunPlannerStore} from "../run-planner.js";
import {SqliteRunObserverStore} from "../run-observer.js";

/** The host, not this harness, creates/claims/completes both model-planned Works.
 * Only idle wait/continue responses are scripted to bound external-model cost. */
export async function runPlanningModelAcceptance(provider:Pick<LlmProvider,"extractJson">,options:{
  outputParent:string;mode:"external_model"|"simulated_harness_test";modelIdentity:{provider:string;name:string};
}) {
  await mkdir(options.outputParent,{recursive:true});const root=await mkdtemp(join(options.outputParent,"traceforge-planning-"));
  const report={root,mode:options.mode,model:options.modelIdentity,status:"failed",failure:null as string|null,
    scriptedIdleDecisions:0,plannedWorks:0,originalEffects:0,receipts:0,followupHasLineage:false,integrity:null as string|null,
    calls:[] as Array<{role:string;stage:string;status:string;elapsedMs:number;totalTokens:number|null}>,
    limitations:["Idle wait/continue responses are scripted; initial planning, tool decisions, result-driven replanning and final acknowledgements use the supplied model",
      "Neutral local RPC fixture, not native sandbox certification or security investigation effectiveness",
      "Eight logical model calls and a local 180-second deadline; provider internal retries and remote billing are not capped"]};
  const token=`observed-${randomBytes(12).toString("hex")}`;
  const pkg=contextPackage(["fixture.read","tool.recall"]);
  pkg.definition.authorizationActions.push("tool.recall");
  pkg.authorizationPolicy={parseScope:payload=>({payload,allowedActions:["fixture.read","tool.recall"],deniedActions:[]}),authorizeResource:(_scope,_kind,value)=>value};
  pkg.definition.agentTopology={...pkg.definition.agentTopology,planner:{...pkg.definition.agentTopology.planner,enabled:true},observer:{...pkg.definition.agentTopology.observer,enabled:true}};
  const objective="Complete exactly two sequential neutral Work packages of kind observe. Planner must create the first Work titled Collect: "
    + "use fixture.read with input {}, then tool.recall with that observation's receiptKey to inspect the saved raw output without another fixture.read, "
    + "then complete with exactly observationToken as summary and outputs: []. After Collect completes, Planner creates one Work titled Review whose objective "
    + "includes the exact observed token copied from the completed result. Review must complete with exactly that token and outputs: [], without using tools. "
    + "While any work is active, do not duplicate it. After both complete, Planner waits and Observer continues, each acknowledging the exact token in rationale. "
    + "No security finding is verified; no further work is needed.";
  let h:FoundationHost|undefined;
  const stop=new AbortController(),timer=setTimeout(()=>stop.abort(),180000);
  try {
    h=await foundationHost({root,initialWork:false,objective,observationToken:token,modelTimeoutMs:30000,
      foundation:{scenarioPackageRegistry:new ScenarioPackageRegistry([pkg])},model:async args=>{
        stop.signal.throwIfAborted();const c=JSON.parse(args.user);
        const role=args.system.includes("strategic Planner")?"planner":args.system.includes("Run Observer")?"observer":"worker";
        const works=c.run?.workItems??[];
        if(role!=="worker" && (works.some((work:any)=>["queued","running"].includes(work.status)) || (role==="observer"&&works.length<2))) {
          report.scriptedIdleDecisions++;return {action:role==="planner"?"wait":"continue",rationale:"Await pending work"};
        }
        const stage=role==="worker"?c.work.title:works.length===0?"initial":works.length===1?"replan":"acknowledge";
        if(report.calls.length>=8) {report.failure="model_call_limit";throw new Error(report.failure);}
        const call={role,stage,status:"running",elapsedMs:0,totalTokens:null as number|null};report.calls.push(call);
        const started=Date.now(),signal=AbortSignal.any([stop.signal,args.signal??stop.signal,AbortSignal.timeout(30000)]);
        let onAbort!:()=>void;const aborted=new Promise<never>((_,reject)=>{onAbort=()=>reject(new Error("model_deadline"));signal.addEventListener("abort",onAbort,{once:true});});
        try {
          signal.throwIfAborted();const value:any=await Promise.race([provider.extractJson({...args,signal,onUsage(usage){
            if(!signal.aborted){call.totalTokens=(call.totalTokens??0)+usage.totalTokens;args.onUsage?.(usage);}
          }}),aborted]);signal.throwIfAborted();
          if(role==="planner"&&stage!=="acknowledge") {
            if(value.action!=="plan"||value.proposals?.length!==1||value.proposals[0].title!==(stage==="initial"?"Collect":"Review"))throw new Error("unexpected_plan");
            if(stage==="replan"&&(!args.user.includes(token)||!value.proposals[0].objective.includes(token)))throw new Error("result_not_transferred");
          }else if(role==="worker") {
            if(value.type==="complete") {
              if(value.summary!==token||value.outputs?.length!==0)throw new Error("incorrect_worker_result");
              if(stage==="Collect"&&!args.user.includes('untrusted_observation'))throw new Error("missing_original_recall");
              if(stage==="Review"&&!c.work.objective.includes(token))throw new Error("missing_followup_dependency");
            }else if(value.type!=="invoke_tool"||stage!=="Collect"||!["fixture.read","tool.recall"].includes(value.invocation?.tool))throw new Error("unexpected_worker_action");
          }else if(value.action!==(role==="planner"?"wait":"continue")||!value.rationale?.includes(token))throw new Error("missing_acknowledgement");
          call.status="completed";return value;
        }catch{call.status="failed";throw new Error("planning_acceptance_model_failed");}
        finally{call.elapsedMs=Date.now()-started;signal.removeEventListener("abort",onAbort);}
      }});
    await h.start();
    await eventually(async()=>{
      if(stop.signal.aborted||report.failure||report.calls.some(call=>call.status==="failed"))throw new Error(report.failure??"model_failed");
      const state=await h!.state();
      if(state.workItems.length>2||state.workItems.some((work:any)=>["failed","blocked","cancelled"].includes(work.status)))throw new Error("unexpected_work_state");
      return state.workItems.length===2&&state.workItems.every((work:any)=>work.status==="completed")
        && report.calls.some(call=>call.role==="planner"&&call.stage==="acknowledge"&&call.status==="completed")
        && report.calls.some(call=>call.role==="observer"&&call.stage==="acknowledge"&&call.status==="completed")
        && new SqliteRunPlannerStore(h!.sqlite).list("run").some(row=>row.applied&&row.decision.action==="wait"&&JSON.stringify(row.decision).includes(token))
        && new SqliteRunObserverStore(h!.sqlite).list("run").some(row=>row.applied&&JSON.stringify(row.decision).includes(token));
    },175000);
    const state=await h.state();
    const plans=new SqliteRunPlannerStore(h.sqlite).list("run").filter(row=>row.applied&&row.decision.action==="plan");
    report.plannedWorks=plans.length;report.originalEffects=h.calls();
    report.receipts=(h.sqlite.prepare("SELECT count(*) AS n FROM worker_tool_receipts").get() as {n:number}).n;
    report.followupHasLineage=!!h.sqlite.prepare("SELECT 1 FROM context_derivations WHERE run_id='run' AND target_kind='work' AND target_id=? LIMIT 1").get(state.workItems[1].id);
    report.integrity=h.sqlite.pragma("integrity_check",{simple:true}) as string;
    if(report.plannedWorks!==2||report.originalEffects!==1||report.receipts!==2||!report.followupHasLineage||report.integrity!=="ok"
      ||!new SqliteRunObserverStore(h.sqlite).list("run").some(row=>row.applied&&JSON.stringify(row.decision).includes(token)))throw new Error("durable_acceptance_failed");
    report.status="passed";
  }catch(error){report.failure=error instanceof Error&&/^[a-z_]+$/.test(error.message)?error.message:"planning_acceptance_failed";}
  finally{clearTimeout(timer);stop.abort();await h?.close(false);await writeFile(join(root,"report.json"),JSON.stringify(report,null,2),{mode:0o600});}
  return report;
}
