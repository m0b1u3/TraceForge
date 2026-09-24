import {expect,it} from "vitest";
import {compareHttp} from "../runtime-src/comparison.mjs";
import {reserveRequest,BudgetExhausted} from "../runtime-src/budgets.mjs";
import {observationHighlights} from "../runtime-src/observations.mjs";
import {stableJson} from "../runtime-src/validation.mjs";
import {BoundedOutputDistiller} from "@traceforge/worker-runtime";
import {experimentFields,changedDimensions} from "../runtime-src/request-fields.mjs";
import {createHash} from "node:crypto";
function fixture(){const states=new Map<string,any>();let calls=0;
  const capability=async(name:string,action:string,input:any)=>{
    if(name.includes("authorization"))return {output:{scopePayload:{budgets:{variants:16,requestsPerCall:100,totalRequests:2}}},refs:[]};
    if(action==="read")return {output:states.get(input.key)??null,refs:[]};
    if(action==="compare_and_set"){const previous=states.get(input.key);if((previous?.revision??0)!==input.expectedRevision)throw new Error("CAS conflict");const output={revision:input.expectedRevision+1,value:structuredClone(input.value)};states.set(input.key,output);return {output,refs:[]};}
    return {output:{},refs:[`node:${input.node?.id}`]};
  };
  const request=async(spec:any)=>{calls++;return {status:"succeeded" as const,summary:"Observation",raw:JSON.stringify({status:200,responseBytes:spec.url.length,bodyBase64:Buffer.from(spec.url).toString("base64"),bodyTruncated:false,receipt:{id:`receipt-${calls}`}}),refs:[],retryable:false as const};};
  return {states,capability,request,count:()=>calls};}
const input={experimentId:"matrix",hypothesisId:"hypothesis",baseline:{url:"https://first.example/"},candidates:[{url:"https://first.example/one"},{url:"https://first.example/two"}],expectedSignals:["bodyChanged"],stopOn:"never"};
it("bounds shared experiment fields and distinguishes body/header changes",()=>{
  for(const method of ["GET","HEAD","POST","PUT","PATCH","DELETE","OPTIONS"])expect(experimentFields({method}).method).toBe(method);
  const first=experimentFields({method:"POST",headers:{"X-Variant":"first"},bodyBase64:Buffer.from("first").toString("base64")});
  expect(first.headers).toEqual({"x-variant":"first"});
  expect(changedDimensions(first,{...first,headers:{"x-variant":"second"}})).toEqual(["headers"]);
  expect(changedDimensions(first,{...first,bodyBase64:Buffer.from("second").toString("base64")})).toEqual(["bodyBase64"]);
  expect(()=>experimentFields({method:"GET",bodyBase64:first.bodyBase64})).toThrow();
  expect(()=>experimentFields({method:"POST",bodyBase64:Buffer.alloc(65537).toString("base64")})).toThrow();
  expect(()=>experimentFields({headers:{"X-Value":"one\r\ntwo"}})).toThrow();
});
it("binds comparison identity to canonical plan content, not input key order",async()=>{
  const f=fixture();await compareHttp({experimentId:"canonical",hypothesisId:"hypothesis",baseline:input.baseline,candidate:input.candidates[0],maxRequests:1},f.capability,f.request);
  const state=[...f.states.entries()].find(([key])=>key.startsWith("web.comparison.v1:"))![1].value;
  const expected={hypothesisId:"hypothesis",baseline:{url:input.baseline.url,method:"GET",sessionId:null},
    candidates:[{url:input.candidates[0]!.url,method:"GET",sessionId:null}],rounds:2,expectedSignals:["statusChanged","bodyChanged","bytesChanged"],stopOn:"never"};
  expect(state.fingerprint).toBe(createHash("sha256").update(stableJson(expected)).digest("hex"));
  // The same plan with reordered keys continues the experiment instead of conflicting.
  const reordered=JSON.parse(`{"stopOn":"never","maxRequests":1,"expectedSignals":["statusChanged","bodyChanged","bytesChanged"],"candidate":{"url":"${input.candidates[0]!.url}"},"baseline":{"url":"${input.baseline.url}"},"hypothesisId":"hypothesis","experimentId":"canonical"}`);
  const continued=JSON.parse((await compareHttp(reordered,f.capability,f.request)).raw);
  expect(continued.completedRequests).toBe(2);expect(f.count()).toBe(2);
  // A genuinely different plan still conflicts.
  await expect(compareHttp({...reordered,rounds:3},f.capability,f.request)).rejects.toThrow("different comparison");
});
it("normalizes HTTP and surface fields and uses configurable terms without inventing a singleton outlier",()=>{
  const one=observationHighlights([{status:201,responseBytes:10,bodyBase64:Buffer.from("neutral marker").toString("base64"),bodyTruncated:false,receipt:{id:"one"}}],["marker"]);
  expect(one.groups[0]!.representative).toMatchObject({bytes:10,truncated:false,refs:["network-receipt:one"],signals:{statusMinority:false,lengthMinority:false,termMatch:true}});
  const batch=observationHighlights([{status:200,responseBytes:20,bodyDigest:"same"},{status:200,responseBytes:20,bodyDigest:"same"},{status:201,responseBytes:10,bodyDigest:"other"}]);
  expect(batch.groups[0]!.representative).toMatchObject({digest:"other",signals:{statusMinority:true,lengthMinority:true}});
});
it("executes one immutable matrix with independent receipts and does not replay after reload",async()=>{
  const f=fixture(),first=JSON.parse((await compareHttp({...input,maxRequests:3},f.capability,f.request)).raw);
  expect(first.status).toBe("in_progress");expect(f.count()).toBe(3);
  const completed=JSON.parse((await compareHttp(input,f.capability,f.request)).raw);
  expect(completed).toMatchObject({status:"complete",completedRequests:8,plannedRequests:8,findingVerified:false});expect(new Set(completed.observations.map((row:any)=>row.receiptRef)).size).toBe(8);
  await compareHttp(input,f.capability,f.request);expect(f.count()).toBe(8);
  await expect(compareHttp({...input,stopOn:"repeatable_difference"},f.capability,f.request)).rejects.toThrow("different comparison");
});
it("stops a matrix on an unknown outcome and never redispatches it",async()=>{
  const f=fixture();await expect(compareHttp(input,f.capability,async()=>{throw new Error("lost receipt");})).rejects.toThrow("lost");
  expect(JSON.parse((await compareHttp(input,f.capability,f.request)).raw).status).toBe("interrupted");expect(f.count()).toBe(0);
});
it("honors predeclared stop conditions after a repeatable pair",async()=>{
  const f=fixture();const output=JSON.parse((await compareHttp({...input,stopOn:"repeatable_difference"},f.capability,f.request)).raw);
  expect(output).toMatchObject({stoppedEarly:true,completedRequests:4});
});
it("accounts cumulative admission durably and never refunds unknown requests",async()=>{
  const f=fixture();await reserveRequest(f.capability,"first");await reserveRequest(f.capability,"first");await reserveRequest(f.capability,"second");
  await expect(reserveRequest(f.capability,"third")).rejects.toBeInstanceOf(BudgetExhausted);
});
it("keeps the durable request ledger within the Host state byte limit at the authorized maximum",async()=>{
  const states=new Map<string,any>();
  const capability=async(name:string,action:string,input:any)=>{
    if(name.includes("authorization"))return {output:{scopePayload:{budgets:{totalRequests:4096}}},refs:[]};
    if(action==="read")return {output:states.get(input.key)??null,refs:[]};
    if(action==="compare_and_set"){const previous=states.get(input.key);if((previous?.revision??0)!==input.expectedRevision)throw new Error("CAS conflict");const output={revision:input.expectedRevision+1,value:structuredClone(input.value)};states.set(input.key,output);return {output,refs:[]};}
    throw new Error(`Unexpected ${name} ${action}`);
  };
  for(let index=0;index<4096;index++)await reserveRequest(capability,`request-${index}`);
  const ledger=states.get("web.request-budget.v1").value;
  expect(ledger.ids).toHaveLength(4096);
  expect(ledger.ids.every((id:string)=>/^[a-f0-9]{16}$/.test(id))).toBe(true);
  // The Host persists one state value with a 256 KiB bound; the full ledger must fit inside it.
  expect(Buffer.byteLength(JSON.stringify(ledger))).toBeLessThan(256*1024);
  await expect(reserveRequest(capability,"one-more")).rejects.toBeInstanceOf(BudgetExhausted);
},20000);
it("keeps a rare observation's fields before 100 homogeneous responses within a bounded context",async()=>{
  const rows=Array.from({length:100},(_,step)=>({step,status:200,bytes:120,digest:"same",refs:[`receipt:${step}`]}));
  rows.push({step:100,status:202,bytes:345,digest:"rare",refs:["receipt:rare"]});
  const highlights=observationHighlights(rows);expect(highlights.groups[0].representative.digest).toBe("rare");expect(highlights.groups[1].count).toBe(100);
  const result=await new BoundedOutputDistiller().distill({status:"succeeded",summary:"Matrix",raw:JSON.stringify({observations:rows,contextHighlights:highlights}),refs:rows.flatMap(row=>row.refs),retryable:false},2048);
  expect(result.summary).toContain('"status":202');expect(result.summary).toContain('"bytes":345');expect(result.summary).toContain("receipt:rare");expect(result.summary.length).toBeLessThanOrEqual(2048);expect(result.refs).toHaveLength(101);
});
