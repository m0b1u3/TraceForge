import type { CapabilityReceipt, JsonObject } from "./contracts.mjs";
import { boundedInteger, sha } from "./validation.mjs";
export type Capability = (name:string,action:string,input:unknown,suffix:string)=>Promise<CapabilityReceipt>;
export class BudgetExhausted extends Error {}
export async function budgets(capability:Capability) {
  const receipt=await capability("traceforge.scenario.authorization@1","require",{action:"scope.read"},"budget-scope");
  const values=receipt.output?.scopePayload?.budgets??{};
  return { urls:boundedInteger(values.urls??64,1,512,"Authorized URL budget"),
    hypotheses:boundedInteger(values.hypotheses??16,1,128,"Authorized hypothesis budget"),
    variants:boundedInteger(values.variants??1,1,16,"Authorized experiment variants"),
    requestsPerCall:boundedInteger(values.requestsPerCall??6,1,100,"Authorized request batch"),
    totalRequests:boundedInteger(values.totalRequests??128,1,4096,"Authorized total HTTP requests") };
}
/** Run-scoped durable admission. Unknown dispatches retain their reservation. */
export async function reserveRequest(capability:Capability,identity:string) {
  const limit=(await budgets(capability)).totalRequests,key="web.request-budget.v1";
  const loaded=await capability("traceforge.scenario.state@1","read",{operation:"read",key},`budget-read:${sha(identity)}`);
  const revision=loaded.output?.revision??0,used:JsonObject=loaded.output?.value??{version:1,ids:[]};
  if(used.version!==1||!Array.isArray(used.ids)||used.ids.length>4096||used.ids.some((v:unknown)=>typeof v!=="string"))throw new Error("Invalid HTTP budget ledger");
  const id=sha(identity);if(used.ids.includes(id))return;
  if(used.ids.length>=limit)throw new BudgetExhausted(`HTTP request budget exhausted (${used.ids.length}/${limit}); request user authorization before continuing`);
  await capability("traceforge.scenario.state@1","compare_and_set",{operation:"compare_and_set",commandId:`${key}:${revision}:${id}`,key,expectedRevision:revision,value:{version:1,ids:[...used.ids,id]}},`budget-reserve:${id}`);
}
