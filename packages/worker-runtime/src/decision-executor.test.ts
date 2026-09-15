import {expect,it} from "vitest";
import {WorkerDecisionExecutor} from "./decision-executor.js";
import type {WorkerModelRequest} from "./model.js";
const request={tools:[{name:"not available during conclusion"}],steering:[],transcript:[]} as unknown as WorkerModelRequest;
it("uses the same backend contract but removes tools and accepts only a progress block",async()=>{
  const executor=new WorkerDecisionExecutor({async decide(input){expect(input.executionMode).toBe("conclude");expect(input.tools).toEqual([]);return {type:"block",reason:"Observed first result; second prerequisite missing"};}});
  expect(await executor.conclude(request,new AbortController().signal,100)).toContain("prerequisite");
  expect(request.tools).toHaveLength(1);
});
it("rejects tools, completion and permission transitions in conclusion",async()=>{
  for(const decision of [{type:"invoke_tool",invocation:{}},{type:"complete",summary:"done",outputs:[]},{type:"request_permissions",scope:{}},{type:"inquire",refs:[]}]){
    await expect(new WorkerDecisionExecutor({async decide(){return decision as any;}}).conclude(request,new AbortController().signal,100)).rejects.toThrow("read-only");
  }
});
it("bounds an uncooperative backend and rejects cancelled inference",async()=>{
  const executor=new WorkerDecisionExecutor({async decide(){return new Promise(()=>{});}});
  await expect(executor.conclude(request,new AbortController().signal,5)).rejects.toThrow();
  const controller=new AbortController();controller.abort();await expect(executor.decide(request,controller.signal)).rejects.toThrow();
});
