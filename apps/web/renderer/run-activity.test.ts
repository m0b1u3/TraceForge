import { expect, it } from "vitest";
import { RunActivity } from "./run-activity";
import { decodeScenarioAgentEvent } from "@traceforge/shared/scenario-agent-events";
import type { ConversationRun } from "./conversation-execution";
const envelope={protocolVersion:2,id:"event",sequence:1,runId:"run",caseId:"case",workId:"work",turnId:"turn",role:"worker",createdAt:"2026-09-14T00:00:00.000Z"};
const item=(value:object)=>decodeScenarioAgentEvent({...envelope,method:"item/updated",params:{item:value}});
it("does not confuse resource release or unrelated logs with completion of an active model",()=>{
  const state=new RunActivity();
  state.apply([item({type:"modelCall",id:"model",routeId:"primary",attempt:1,status:"inProgress",reservedTokens:10})]);
  state.apply([item({type:"modelAdmission",id:"other",status:"released",priority:1})]);
  expect(state.label()).toContain("模型正在思考");
  state.apply([item({type:"modelCall",id:"model",routeId:"primary",attempt:1,status:"timedOut",reservedTokens:10})]);
  expect(state.label()).toContain("超时");
});
it("prioritizes current paused, approval and exhausted Work state over old activity",()=>{
  const state=new RunActivity();
  state.apply([item({type:"toolCall",id:"tool",tool:"neutral",status:"inProgress"})]);
  expect(state.label()).toContain("工具正在运行");
  const run={status:"paused",workItems:[]} as unknown as ConversationRun;
  expect(state.label(run)).toContain("已暂停");
  expect(state.label({...run,status:"running",workItems:[{id:"w",title:"w",status:"blocked",continuation:{state:"budget_exhausted",checkpointRef:null}}]})).toContain("预算");
});
