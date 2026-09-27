// Isolated native Electron journey: a local protocol fixture proposes one task.
// No external model, target or user profile is used. It checks a bare target
// through default grant, bounded observation and a visible final report.
import {app,BrowserWindow,dialog} from "electron";
import {createServer} from "node:http";
import {mkdtempSync,mkdirSync,realpathSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {createRequire} from "node:module";
import {register} from "../apps/server/dist/development-loader.js";
register();
const Database=createRequire(new URL("../apps/server/package.json",import.meta.url))("better-sqlite3");
const root=realpathSync(mkdtempSync(join(realpathSync(tmpdir()),"traceforge-direct-default-")));
app.setPath("userData",root);
let proposals=0,plannerCalls=0,workerCalls=0,scopeCalls=0,httpCalls=0,reportCalls=0,targetRequests=0;
const finalAnswer="已完成目标观察和证据复核。当前仅观察到测试页面，未形成可验证的安全发现；这些证据不足以断言目标安全。";
const upstream=createServer(async(request,response)=>{
  if(request.method==="GET"&&request.url==="/target"){targetRequests++;response.writeHead(200,{"content-type":"text/html"}).end("<title>Local target</title><p>Controlled test page</p>");return;}
  if(request.method!=="POST"||request.url!=="/v1/chat/completions"){response.writeHead(404).end();return;}
  let raw="";for await(const part of request){raw+=part;if(raw.length>1048576){response.writeHead(413).end();return;}}
  const body=JSON.parse(raw);
  const planner=JSON.stringify(body.messages??[]).includes("strategic Planner");
  const modelInput=(()=>{try{return JSON.parse(body.messages?.find(message=>message.role==="user")?.content??"{}");}catch{return {};}})();
  const phase=modelInput.run?.activePhaseId;
  const proposal=phase==="scope_setup"?{kind:"research",title:"Inspect target scope",objective:"Record the authorized target and available capabilities",
    priority:80,requiredCapabilities:["scope.read"],hypothesisIds:[],evidenceRefs:[],maxAttempts:1}
    :phase==="surface_mapping"?{kind:"research",title:"Observe target",objective:"Request the authorized target and record the response",
      priority:80,requiredCapabilities:["web.request.replay"],hypothesisIds:[],evidenceRefs:[],maxAttempts:1}
    :phase==="hypothesis_planning"?{kind:"research",title:"Assess candidates",objective:"Assess the observed surface and record coverage without unsupported hypotheses",
      priority:80,requiredCapabilities:["evidence.write"],hypothesisIds:[],evidenceRefs:[],maxAttempts:1}
    :phase==="synthesis"?{kind:"review",title:"Review evidence",objective:"Review observed coverage and limits without inventing a finding",
      priority:80,requiredCapabilities:["evidence.write"],hypothesisIds:[],evidenceRefs:[],maxAttempts:1}
    :phase==="reporting"?{kind:"report",title:"Prepare report",objective:"Answer the target request with the supported result and limitations",
      priority:80,requiredCapabilities:["report.write","web.report.build"],hypothesisIds:[],evidenceRefs:[],maxAttempts:1}:null;
  const plan=JSON.stringify(proposal?{action:"plan",rationale:"Continue the current investigation phase",proposals:[proposal],cancellations:[],reprioritizations:[]}
    :{action:"wait",rationale:"No new Work is required"});
  if(!body.stream){
    if(planner)plannerCalls++;
    const content=planner?plan:"{}";
    response.writeHead(200,{"content-type":"application/json"}).end(JSON.stringify({choices:[{message:{role:"assistant",content},finish_reason:"stop"}]}));return;
  }
  response.writeHead(200,{"content-type":"text/event-stream"});
  const frame=(delta,finish_reason=null)=>response.write(`data: ${JSON.stringify({choices:[{index:0,delta,finish_reason}]})}\n\n`);
  if(body.tools?.some(tool=>tool.function?.name==="task_request")){
    if(body.messages.at(-1)?.role==="tool"){
      if(!body.messages.at(-1).content.includes('"state":"started"'))throw new Error("Default task did not start");
      frame({content:"任务已按保存的默认偏好启动。"});frame({},"stop");
    }else{
      if(!body.messages.some(message=>message.role==="system"&&message.content?.includes("A message containing only a target identifier")))
        throw new Error("Bare-target instruction was not sent to the desktop model");
      proposals++;
      frame({tool_calls:[{index:0,id:"fixture-task-request",type:"function",function:{name:"task_request",arguments:"{}"}}]});
      frame({},"tool_calls");
    }
  }else if(body.tools?.some(tool=>tool.function?.name==="tf_complete")){
    workerCalls++;
    const context=modelInput,workPhase=context.work?.phaseId;
    const scope=body.tools.find(tool=>tool.function?.description?.startsWith("scope.authorization.snapshot:"));
    const surface=body.tools.find(tool=>tool.function?.description?.startsWith("web.surface.explore:"));
    const report=body.tools.find(tool=>tool.function?.description?.startsWith("web.report.build:"));
    const complete=body.tools.find(tool=>tool.function?.name==="tf_complete");
    if(workPhase==="scope_setup"&&scopeCalls===0&&scope){
      scopeCalls++;
      frame({tool_calls:[{index:0,id:"fixture-scope-read",type:"function",function:{name:scope.function.name,arguments:"{}"}}]});
    }else if(workPhase==="surface_mapping"&&httpCalls===0&&surface){
      httpCalls++;
      frame({tool_calls:[{index:0,id:"fixture-target-request",type:"function",function:{name:surface.function.name,
        arguments:JSON.stringify({seeds:[context.run.goal],maxRequests:1})}}]});
    }else if(workPhase==="reporting"&&reportCalls===0&&report){
      reportCalls++;
      frame({tool_calls:[{index:0,id:"fixture-report-assembly",type:"function",function:{name:report.function.name,arguments:"{}"}}]});
    }else{
      const kinds=workPhase==="scope_setup"?["scope_snapshot","capability_inventory"]
        :workPhase==="surface_mapping"?["surface_observation","coverage_assessment"]
        :workPhase==="hypothesis_planning"?["coverage_assessment"]
        :workPhase==="synthesis"?["evidence_review"]
        :workPhase==="reporting"?["report"]:[];
      if(!kinds.length)throw new Error(`Unexpected Work phase: ${workPhase}`);
      const allowed=complete?.function?.parameters?.properties?.outputs?.items?.properties?.kind?.enum??[];
      if(kinds.some(kind=>!allowed.includes(kind)))throw new Error("Fixture output kind was unavailable");
      const refs=context.referenceCatalog?.evidenceRefs?.slice(0,8)??[];
      frame({tool_calls:[{index:0,id:`fixture-${workPhase}-complete`,type:"function",function:{name:"tf_complete",arguments:JSON.stringify({summary:"Recorded the bounded observation",
        outputs:kinds.map((kind,index)=>({id:`${workPhase}-output-${index}`,kind,summary:kind==="report"?finalAnswer
          :kind==="evidence_review"?"Observed only the authorized test page; no reproducible causal security impact or verified finding is supported."
          :`Recorded ${kind}`,refs}))})}}]});
    }
    frame({},"tool_calls");
  }else{if(planner)plannerCalls++;frame({content:planner?plan:"{}"});frame({},"stop");}
  response.end("data: [DONE]\n\n");
});
await new Promise((resolve,reject)=>{upstream.once("error",reject);upstream.listen(0,"127.0.0.1",resolve);});
app.on("will-quit",()=>{upstream.closeAllConnections();upstream.close();});
dialog.showErrorBox=(title,message)=>{console.error(title,message);app.exit(1);};
const deadline=setTimeout(()=>{console.error("NATIVE_DIRECT_DEFAULT_TIMEOUT");app.exit(1);},120000);
await import("../apps/desktop/dist/main.js");
const until=async(read,valid,label)=>{for(let attempt=0;attempt<600;attempt++){
  try{const value=await read();if(valid(value))return value;}catch{/* A reload can temporarily invalidate the renderer context. */}
  await new Promise(resolve=>setTimeout(resolve,100));
}throw new Error(label);};
void app.whenReady().then(async()=>{try{
  const window=await until(async()=>BrowserWindow.getAllWindows()[0],value=>value&&!value.webContents.isLoading()&&value.webContents.getURL(),"Desktop window unavailable");
  let stage="bridge";
  const js=async source=>{try{return await window.webContents.executeJavaScript(source);}catch(error){console.error(`NATIVE_DIRECT_DEFAULT_SCRIPT_FAILED:${stage}`);throw error;}};
  await until(()=>js("!!window.traceforgeDesktop?.conversations"),Boolean,"Desktop bridge unavailable");
  const request=(path,body)=>js(`window.traceforgeDesktop.conversations.request(${JSON.stringify({path,method:body===undefined?"GET":"POST",...(body===undefined?{}:{body:JSON.stringify(body)})})})`);
  stage="model-settings";
  const model=await js(`(async()=>{const bridge=window.traceforgeDesktop.modelSettings;const current=await bridge.request({operation:'load'});return bridge.request({operation:'save',payload:{expectedRevision:current.body.revision,config:{provider:'openai',model:'direct-default-fixture',apiKey:'synthetic-only',baseUrl:${JSON.stringify(`http://127.0.0.1:${upstream.address().port}/v1`)},jsonMode:'json_object'}}});})()`);
  if(model.status!==200)throw new Error("Fixture model setup failed");
  stage="new-conversation";
  window.webContents.reload();
  await until(()=>js("document.body.innerText"),value=>value.includes("这次想调查什么？"),"New desktop conversation was not shown");
  stage="message";
  const target=`http://127.0.0.1:${upstream.address().port}/target`;
  const task=target;
  await until(()=>js("!!document.querySelector('.host-composer textarea[aria-label=\"发送消息\"]:not(:disabled)')"),Boolean,"Desktop composer unavailable");
  await js(`(()=>{const field=document.querySelector('.host-composer textarea[aria-label="发送消息"]');
    if(!field||field.disabled)throw new Error('Desktop composer unavailable');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,${JSON.stringify(target)});
    field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await until(()=>js("!!document.querySelector('.host-composer button.send:not(:disabled)')"),Boolean,
    "Target input did not enable the desktop send button");
  await js("document.querySelector('.host-composer button.send').click()");
  const conversation=await until(async()=>{
    const catalog=await request("/api/desktop/conversations");
    return catalog.body?.conversations?.length===1?catalog.body.conversations[0]:null;
  },Boolean,"Desktop send did not create exactly one conversation");
  const message=await until(async()=>{
    const page=await request(`/api/desktop/conversations/${conversation.id}/messages?after=0&limit=100`);
    return page.body?.messages?.find(item=>item.text===task);
  },Boolean,"Desktop send did not persist the target message");
  await until(()=>js("document.body.innerText"),value=>value.includes(target),"Saved target message was not shown");
  stage="reply";
  const reply=await until(async()=>{
    const page=await request(`/api/desktop/conversations/${conversation.id}/replies?after=0`);
    return page.body?.replies?.find(item=>item.messageCommandId===message.commandId);
  },value=>value?.state==="completed"&&value.taskRequest?.startState==="started","Default task did not start");
  if(proposals!==1||reply.taskRequest?.automatic!==true)throw new Error("Automatic task proposal was not captured");
  stage="dispatch";
  const path=`/api/desktop/conversations/${conversation.id}/execution`;
  const execution=await until(async()=>(await request(path)).body,value=>value?.runs?.length===1&&value?.scopes?.length===1,"Default task was not dispatched exactly once");
  if(execution.runs[0].goal!==task)throw new Error("Target message was not forwarded as the Run goal");
  if(execution.scopes[0].scope?.payload?.directWorkspaceNetwork!==true&&execution.scopes[0].scope?.directWorkspaceNetwork!==true)throw new Error("Default direct grant was not persisted");
  const planned=await until(async()=>(await request(path)).body,value=>value?.runs?.[0]?.workItems?.length>0,"Target task did not enter planning");
  if(plannerCalls<1||planned.runs[0].workItems[0].title!=="Inspect target scope")throw new Error("Planner result was not persisted");
  const db=new Database(join(root,"traceforge.sqlite"),{readonly:true,fileMustExist:true});
  const receipt=await until(()=>db.prepare(`SELECT r.result_json FROM worker_tool_receipts r JOIN tool_invocation_bindings b USING(idempotency_key)
    WHERE b.run_id=? AND b.tool_name='scope.authorization.snapshot'`).get(execution.runs[0].runId),Boolean,"Worker did not execute the first authorized tool");
  if(scopeCalls!==1||workerCalls<1||JSON.parse(receipt.result_json).status!=="succeeded")throw new Error("Worker tool execution was not successful");
  const completed=await until(async()=>(await request(path)).body,value=>value?.runs?.[0]?.workItems?.[0]?.status==="completed",
    "First planned Work did not complete after its tool receipt");
  if(!["scope_snapshot","capability_inventory"].every(kind=>completed.runs[0].outputs.some(output=>output.kind===kind)))
    throw new Error("First Work outputs were not retained");
  const httpReceipt=await until(()=>db.prepare(`SELECT r.result_json FROM worker_tool_receipts r JOIN tool_invocation_bindings b USING(idempotency_key)
    WHERE b.run_id=? AND b.tool_name='web.surface.explore'`).get(execution.runs[0].runId),Boolean,"Worker did not request the target");
  db.close();
  if(httpCalls!==1||targetRequests<1||JSON.parse(httpReceipt.result_json).status!=="succeeded")
    throw new Error("Target request did not reach the controlled local service");
  const observed=await until(async()=>(await request(path)).body,value=>value?.runs?.[0]?.workItems?.some(work=>work.title==="Observe target"&&work.status==="completed"),
    "Target observation Work did not complete");
  if(!["surface_observation","coverage_assessment"].every(kind=>observed.runs[0].outputs.some(output=>output.kind===kind)))
    throw new Error("Target observation outputs were not retained");
  const finished=await until(async()=>(await request(path)).body,value=>value?.runs?.[0]?.status==="completed",
    "Target task did not finish its evidence review and report");
  const finalRun=finished.runs[0];
  if(finalRun.workItems.length!==5||finalRun.workItems.some(work=>work.status!=="completed"))
    throw new Error("The planned investigation did not finish exactly five Work items");
  const reportOutput=finalRun.outputs.find(output=>output.kind==="report");
  if(finalRun.outputs.filter(output=>output.kind==="report").length!==1
    ||reportOutput?.summary!==finalAnswer)
    throw new Error("The final report was not retained with the expected supported result");
  if(!reportOutput.refs.some(ref=>ref.startsWith("network-receipt:")))
    throw new Error("The final report did not retain the target request receipt");
  if(finalRun.outputs.some(output=>["hypothesis","validation_conclusion"].includes(output.kind)))
    throw new Error("The fixture invented a security hypothesis or validation conclusion");
  const reportDb=new Database(join(root,"traceforge.sqlite"),{readonly:true,fileMustExist:true});
  const reportReceipt=reportDb.prepare(`SELECT r.result_json FROM worker_tool_receipts r JOIN tool_invocation_bindings b USING(idempotency_key)
    WHERE b.run_id=? AND b.tool_name='web.report.build'`).get(execution.runs[0].runId);
  reportDb.close();
  if(reportCalls!==1||!reportReceipt||JSON.parse(reportReceipt.result_json).status!=="succeeded")
    throw new Error("Scenario report assembly did not complete with a successful tool receipt");
  window.webContents.reload();
  await until(()=>js("document.body.innerText"),value=>value.includes(finalAnswer)&&value.includes("本次任务已完成"),
    "The completed report was not rendered in the desktop conversation");
  const body=await js("document.body.innerText");
  if(body.includes("确认授权并开始任务")||body.includes("请核对本条任务的具体授权"))throw new Error("Per-task review was unexpectedly rendered");
  const screenshot=resolve("docs/screenshots/native-target-report-2026-09-27.png");mkdirSync(resolve("docs/screenshots"),{recursive:true});
  writeFileSync(screenshot,(await window.webContents.capturePage()).toPNG());
  await new Promise(resolve=>setTimeout(resolve,500));
  window.destroy();
  console.log(JSON.stringify({status:"passed",root,conversationId:conversation.id,runId:execution.runs[0].runId,target,proposals,plannerCalls,workerCalls,scopeCalls,httpCalls,reportCalls,targetRequests,workItems:finalRun.workItems.length,screenshot}));
  clearTimeout(deadline);app.quit();
}catch(error){console.error(error);app.exit(1);}});
