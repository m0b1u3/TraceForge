import {expect,it,vi} from "vitest";
import {createDesktopTaskStart} from "./desktop-task-start.js";
import {TaskDefinitionSchema,defaultTaskConfiguration} from "@traceforge/shared/authorization-form";
const definition=TaskDefinitionSchema.parse({kind:"neutral",version:1,authorizationForm:{version:1,description:"Isolated work",fields:[{path:["async"],label:"Async",description:"Owned execution",type:"boolean",defaultEnabled:true,required:false}]},authorizationReview:{actionSelection:true,allowedActions:["read","write"],deniedActions:[],resources:[]}});
function fixture(){
  const request=vi.fn(async(path:string,body?:Record<string,unknown>)=>({status:200,body:{...(path.endsWith("/authorize")?{}:{runId:"run",result:{state:{revision:1}}}),desktopReceipt:{version:1,conversationId:"conversation",commandId:body!.commandId,operation:path.endsWith("/authorize")?"authorize":path.endsWith("/cancel")?"cancel":"dispatch",resourceId:path.endsWith("/authorize")?body!.commandId:"run"}}}));
  const abort=new AbortController();return {request,abort,input:{conversationId:"conversation",messageId:"message",definition,signal:abort.signal}};
}
it("uses host defaults and the exact saved message identity with no extra confirmation",async()=>{
  const f=fixture(),start=createDesktopTaskStart(f.request,()=>null);
  expect(await start(f.input)).toMatchObject({state:"started",executed:true,runId:"run"});
  expect(f.request.mock.calls[0][1]).toMatchObject({scope:{async:true,authorizedActions:["read","write"]}});
  expect(f.request.mock.calls[1][1]).toMatchObject({messageCommandId:"message",scenarioKind:"neutral"});
  expect(f.request.mock.calls[1][1]).not.toHaveProperty("goal");
});
it("consumes saved disabled actions and rejects stale settings before any authorization",async()=>{
  const f=fixture(),preset={...defaultTaskConfiguration(definition),actions:["read"],revision:3};
  const start=createDesktopTaskStart(f.request,()=>JSON.stringify([{kind:"neutral",preset}]));
  expect(await start(f.input)).toMatchObject({configurationRevision:3});
  expect(f.request.mock.calls[0][1]).toMatchObject({scope:{authorizedActions:["read"]}});
  f.request.mockClear();await expect(start({...f.input,definition:{...definition,version:2}})).rejects.toThrow("场景配置已变化");expect(f.request).not.toHaveBeenCalled();
});
it("does not dispatch after an invalid receipt or stop during authorization",async()=>{
  const f=fixture();f.request.mockResolvedValueOnce({status:200,body:{}} as any);
  expect(await createDesktopTaskStart(f.request,()=>null)(f.input)).toMatchObject({executed:false});expect(f.request).toHaveBeenCalledTimes(1);
  f.request.mockClear();const original=f.request.getMockImplementation()!;
  f.request.mockImplementation(async(p,b)=>{const r=await original(p,b);f.abort.abort();return r;});
  await expect(createDesktopTaskStart(f.request,()=>null)(f.input)).rejects.toThrow();expect(f.request).toHaveBeenCalledTimes(1);
});
it("stops the newly created Run when cancellation races dispatch",async()=>{
  const f=fixture(),original=f.request.getMockImplementation()!;
  f.request.mockImplementation(async(p,b)=>{const r=await original(p,b);if(!p.endsWith("/authorize"))f.abort.abort();return r;});
  expect(await createDesktopTaskStart(f.request,()=>null)(f.input)).toMatchObject({state:"stopped",runId:"run"});
  expect(f.request.mock.calls[2][0]).toMatch(/\/cancel$/);
});
