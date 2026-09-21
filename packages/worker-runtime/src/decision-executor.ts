import {waitForCancellation} from "./cancellation.js";
import type {WorkerModel,WorkerModelRequest} from "./model.js";

/** Provider-independent decision boundary. It has no gateway or process authority. */
export class WorkerDecisionExecutor {
  constructor(private readonly backend:WorkerModel){}
  async decide(request:WorkerModelRequest,signal:AbortSignal){
    signal.throwIfAborted();
    const decision=await waitForCancellation(()=>this.backend.decide(request,signal),signal);
    signal.throwIfAborted();
    return decision;
  }
  async conclude(request:WorkerModelRequest,signal:AbortSignal,timeoutMs?:number):Promise<string>{
    signal.throwIfAborted();
    if(timeoutMs!==undefined&&(!Number.isSafeInteger(timeoutMs)||timeoutMs<1))throw new Error("Invalid conclusion time budget");
    const deadline=new AbortController(),timer=timeoutMs===undefined?undefined:setTimeout(()=>deadline.abort(new Error("Conclusion time budget exhausted")),timeoutMs);
    const bounded=AbortSignal.any([signal,deadline.signal]);
    try{
    const result=await this.decide({...request,executionMode:"conclude",tools:[],
      toolResolution:{requestedCapabilities:[],unresolvedCapabilities:[],registryRevision:0},
      steering:[...request.steering,"Execution has ended. Return block with a concise summary of already observed results, uncertainty and the next prerequisite. No tools, permissions, inquiry or completion are allowed. This is progress, not verified evidence."]},bounded);
    if(result.type!=="block"||!result.reason.trim()||result.reason.length>6000)throw new Error("Invalid read-only conclusion");
    return result.reason;
    }finally{clearTimeout(timer);}
  }
}
