import {createHash} from "node:crypto";
import {TaskDefinitionSchema,resolveTaskConfiguration,taskConfigurationScope} from "@traceforge/shared/authorization-form";
import {DesktopExecutionReceiptSchema} from "@traceforge/shared/desktop-execution";

export type DesktopTaskStart = (input:{conversationId:string;messageId:string;definition:unknown;signal:AbortSignal})=>Promise<Record<string,unknown>>;
/** Desktop-owned defaults, never a model-supplied grant. The task port journals
 * uncertainty before calling this adapter; reopening a conversation is read-only. */
export function createDesktopTaskStart(request:(path:string,body?:Record<string,unknown>)=>Promise<{status:number;body:any}>,preferences:()=>string|null):DesktopTaskStart {
  return async ({conversationId,messageId,definition,signal})=>{
    const d=TaskDefinitionSchema.parse(definition),preset=resolveTaskConfiguration(d,preferences());
    const scope=taskConfigurationScope(d,preset);
    const identity=createHash("sha256").update(JSON.stringify([conversationId,messageId,d.kind,d.version])).digest("hex").slice(0,40);
    const scopeId=`scope_${identity}`,commandId=`task_${identity}`,path=`/api/desktop/conversations/${conversationId}/execution`;
    signal.throwIfAborted();
    const authorized=await request(`${path}/authorize`,{commandId:scopeId,scenarioKind:d.kind,definitionVersion:d.version,scope,
      expiresAt:"9999-12-31T23:59:59.000Z",confirmed:true});
    const grant=DesktopExecutionReceiptSchema.safeParse(authorized.body?.desktopReceipt);
    if(authorized.status<200||authorized.status>=300||!grant.success||grant.data.conversationId!==conversationId||grant.data.commandId!==scopeId||grant.data.operation!=="authorize"||grant.data.resourceId!==scopeId)
      return {state:"start_failed",error:"authorization_not_confirmed",executed:false};
    signal.throwIfAborted();
    const result=await request(path,{commandId,messageCommandId:messageId,scopeRef:scopeId,scenarioKind:d.kind,definitionVersion:d.version});
    const receipt=DesktopExecutionReceiptSchema.safeParse(result.body?.desktopReceipt);
    if(result.status<200||result.status>=300||!receipt.success||receipt.data.conversationId!==conversationId||receipt.data.commandId!==commandId||receipt.data.operation!=="dispatch"||receipt.data.resourceId!==result.body.runId)
      return {state:"start_unconfirmed",error:"dispatch_not_confirmed",executed:false,commandId};
    if(signal.aborted){
      const state=result.body.result?.state;
      if(!Number.isInteger(state?.revision))return {state:"stop_unconfirmed",executed:true,runId:result.body.runId};
      const stopped=await request(`${path}/cancel`,{commandId:`stop_${identity}`,runId:result.body.runId,expectedRevision:state.revision});
      const cancellation=DesktopExecutionReceiptSchema.safeParse(stopped.body?.desktopReceipt);
      return {state:stopped.status===200&&cancellation.success&&cancellation.data.operation==="cancel"&&cancellation.data.resourceId===result.body.runId?"stopped":"stop_unconfirmed",executed:true,runId:result.body.runId};
    }
    return {state:"started",executed:true,runId:result.body.runId,configurationRevision:preset.revision};
  };
}
