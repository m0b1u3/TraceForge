import type {ExecutionToolSpec,ToolExecutionResult,ToolInvocation} from "./model.js";

export const parallelToolName="tools.parallel_read";
export function parallelInvocations(input:unknown,parentId:string):ToolInvocation[] {
  if(!input||typeof input!=="object"||Array.isArray(input)||Object.keys(input).some(k=>k!=="calls"))throw new Error("Invalid parallel plan");
  const raw=(input as {calls?:unknown}).calls;
  if(!Array.isArray(raw)||raw.length<2)throw new Error("Parallel plan requires at least two reads");
  const parsed=raw.map((value):ToolInvocation=>{
    if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).some(k=>!["id","tool","input","rationale"].includes(k))||!["id","tool","rationale"].every(k=>typeof value[k]==="string"&&value[k].length>0)||!Object.hasOwn(value,"input"))throw new Error("Invalid parallel call");
    return value as ToolInvocation;
  });
  if(new Set(parsed.map(c=>c.id)).size!==parsed.length||parsed.some(c=>c.tool===parallelToolName))throw new Error("Parallel calls require unique IDs and cannot nest");
  return parsed.map(c=>({...c,id:`${parentId}/read/${encodeURIComponent(c.id)}`}));
}
export const parallelTool:ExecutionToolSpec={name:parallelToolName,source:"traceforge.builtin",version:"1",priority:0,
  description:"Run independent read-only tools concurrently in one decision. Use only tools in this Work's catalog, with complete independent inputs. Never batch browser interaction, writes, commands, or dependent operations. Each call is authorized and recorded separately; saved results are not re-executed.",
  inputSchema:{type:"object",additionalProperties:false,required:["calls"],properties:{calls:{type:"array",minItems:2,items:{type:"object",additionalProperties:false,required:["id","tool","input","rationale"],properties:{id:{type:"string"},tool:{type:"string"},input:{},rationale:{type:"string"}}}}},
  },providedCapabilities:[],dependencyCapabilities:[],permissionRequirements:{},risk:"read_only",timeoutMs:0};
export function parallelResult(calls:ToolInvocation[],results:ToolExecutionResult[]):ToolExecutionResult {
  return {status:results.every(r=>r.status==="succeeded")?"succeeded":"failed",summary:`${results.filter(r=>r.status==="succeeded").length}/${results.length} independent reads completed`,
    raw:JSON.stringify(calls.map((call,i)=>({id:call.id,tool:call.tool,...results[i]}))),refs:[...new Set(results.flatMap(r=>r.refs))],retryable:false};
}
