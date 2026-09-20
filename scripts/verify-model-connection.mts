/** Explicit real-model acceptance. One JSON object on stdin, never credentials in argv/files. */
import { createInterface } from "node:readline";
import { createProvider, discoverModels } from "../packages/llm/src/index.js";
import { LlmConfigSchema } from "../packages/llm/src/config.js";
import { runDesktopStreamAcceptance } from "../apps/server/src/test-fixtures/desktop-stream-acceptance.js";
import { runDesktopMemoryAcceptance } from "../apps/server/src/test-fixtures/desktop-memory-acceptance.js";
import { runRollingMemoryAcceptance } from "../apps/server/src/test-fixtures/rolling-memory-acceptance.js";
import { runKnowledgeMemoryAcceptance } from "../apps/server/src/test-fixtures/knowledge-memory-acceptance.js";
import { runCurrentMemoryAcceptance } from "../apps/server/src/test-fixtures/current-memory-acceptance.js";
import { runPlanningModelAcceptance } from "../apps/server/src/test-fixtures/planning-model-acceptance.js";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

if (process.argv[2] !== "--allow-model-api") throw new Error("Explicit --allow-model-api required");
const onlyKnowledge = process.argv[3] === "--knowledge-only";
const onlyRolling = process.argv[3] === "--rolling-only";
const onlyMemory = process.argv[3] === "--memory-only";
const onlyJourney = process.argv[3] === "--journey-only";
if (process.argv[3] && !onlyKnowledge && !onlyRolling && !onlyMemory && !onlyJourney) throw new Error("Unknown acceptance suite");
const input = createInterface({input:process.stdin,terminal:false});
let started=Date.now(), deadline:ReturnType<typeof setTimeout>|undefined;
const stop=new AbortController(), maximumCalls=onlyJourney?null:onlyKnowledge?40:onlyRolling?32:100;
let physicalCalls=0;
const outputParent=resolve("data/desktop-model-acceptance");
const report:any={status:"failed",maximumPhysicalModelCalls:maximumCalls,maximumDurationMs:3600000,suites:[],physicalCalls:0};
try {
  let line = "";
  for await (const value of input) { line=value;break; }
  input.close();
  if(line.length>16384) throw new Error("input_limit");
  const config=LlmConfigSchema.parse(JSON.parse(line));line="";
  // The project's real-model acceptance policy is independent of production
  // multi-provider support. Never fall back to another configured account.
  const endpoint = new URL(config.baseUrl ?? "");
  if (config.provider !== "openai" || !config.model.startsWith("deepseek-")
    || endpoint.protocol !== "https:" || endpoint.hostname !== "api.deepseek.com"
    || endpoint.username || endpoint.password || endpoint.port || config.alternativeRoutes?.length)
    throw new Error("acceptance_requires_deepseek");
  started=Date.now();deadline=setTimeout(()=>stop.abort(),3600000);
  const transport:typeof fetch=async(input,init)=>{
    const request=new Request(input,init);
    stop.signal.throwIfAborted();
    if(request.method === "POST") {
      if(maximumCalls!==null && physicalCalls>=maximumCalls) throw new Error("Physical call budget exhausted");
      physicalCalls++;
    }
    const response=await fetch(new Request(request,{signal:AbortSignal.any([request.signal,stop.signal])}));
    console.log(JSON.stringify({event:"transport",physicalCalls,status:response.status,elapsedMs:Date.now()-started}));
    return response;
  };
  const catalog=await discoverModels(config,{fetch:transport},stop.signal);
  console.log(JSON.stringify({event:"catalog",requestedModel:config.model,listed:catalog.models.some(model=>model.id===config.model),models:catalog.models.map(model=>model.id),truncated:catalog.truncated}));
  const provider=createProvider(config,{fetch:transport});
  const options={mode:"external_model" as const,outputParent,modelIdentity:{provider:config.provider,name:config.model},...(onlyJourney?{maximumModelCalls:null}:{})};
  for(const [name,run] of (onlyJourney ? [
    ["current-message-memory",()=>runCurrentMemoryAcceptance(provider,options)],
    ["result-driven-planning",()=>runPlanningModelAcceptance(provider,options)],
    ["stream-stop-restart",()=>runDesktopStreamAcceptance(provider,options)],
  ] : onlyKnowledge ? [
    ["sourced-knowledge",()=>runKnowledgeMemoryAcceptance(provider,options)],
  ] : onlyRolling ? [
    ["rolling-summary",()=>runRollingMemoryAcceptance(provider,options)],
  ] : onlyMemory ? [
    ["desktop-memory-endurance",()=>runDesktopMemoryAcceptance(provider,{...options,continuationRounds:24})],
    ["sourced-knowledge",()=>runKnowledgeMemoryAcceptance(provider,options)],
  ] : [
    ["stream-stop-restart",()=>runDesktopStreamAcceptance(provider,options)],
    ["rolling-summary",()=>runRollingMemoryAcceptance(provider,options)],
    ["desktop-memory-endurance",()=>runDesktopMemoryAcceptance(provider,{...options,continuationRounds:24})],
    ["sourced-knowledge",()=>runKnowledgeMemoryAcceptance(provider,options)],
  ]) as Array<[string,()=>Promise<any>]>) {
    stop.signal.throwIfAborted();
    console.log(JSON.stringify({event:"suite_start",name,physicalCalls}));
    const result=await run();report.suites.push(result);
    console.log(JSON.stringify({event:"suite_end",name,status:result.status,failure:result.failure,report:result.root+"/report.json",physicalCalls}));
  }
  report.status=report.suites.every((suite:any)=>suite.status === "passed") ? "passed" : "failed";
  process.exitCode=report.status === "passed" ? 0 : 1;
} catch(error) {
  console.error(JSON.stringify({status:"failed",code:error && typeof error === "object" && "code" in error && ["unauthorized","unsupported","rate_limited","unavailable","invalid_response"].includes(String(error.code)) ? error.code : "acceptance_setup_failed",detailsRedacted:true}));
  process.exitCode=1;
} finally {
  input.close();clearTimeout(deadline);stop.abort();
  report.physicalCalls=physicalCalls;report.elapsedMs=Date.now()-started;
  const calls=report.suites.flatMap((suite:any)=>suite.calls);
  report.reportedTokens=calls.reduce((sum:number,call:any)=>sum+(call.totalTokens ?? 0),0);
  report.callsWithoutReportedUsage=calls.filter((call:any)=>call.totalTokens == null).length;
  await mkdir(outputParent,{recursive:true});const root=await mkdtemp(join(outputParent,"traceforge-model-batch-"));
  await writeFile(join(root,"report.json"),JSON.stringify(report,null,2),{mode:0o600});
  console.log(JSON.stringify({event:"finished",status:report.status,report:join(root,"report.json"),physicalCalls,elapsedMs:report.elapsedMs,reportedTokens:report.reportedTokens,callsWithoutReportedUsage:report.callsWithoutReportedUsage}));
}
