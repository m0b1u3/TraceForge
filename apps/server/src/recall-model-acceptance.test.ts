import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect,it} from "vitest";
import {runRecallModelAcceptance} from "./test-fixtures/recall-model-acceptance.js";

it("drives compressed recall, persisted supervisor handoff and withdrawal through the host",async()=>{
  const root=await mkdtemp(join(tmpdir(),"traceforge-recall-test-"));
  try {
    const report=await runRecallModelAcceptance({async extractJson(args){
      const token=args.user.match(/observed-[a-f0-9]{24}/)?.[0];
      if(args.system.includes("strategic Planner")) return {action:"wait",rationale:token??"Source withheld; await instruction"};
      if(args.system.includes("Run Observer")) return {action:"continue",rationale:token??"Source withheld; no evidence claim"};
      if(token) return {type:"complete",summary:token,outputs:[]};
      const c=JSON.parse(args.user);
      return {type:"invoke_tool",invocation:{id:"recover",tool:"context.recall",input:{receiptKey:c.transcript.find((entry:any)=>entry.kind==="tool").receiptKey},rationale:"Read missing original"}};
    }},{outputParent:root,mode:"simulated_harness_test",modelIdentity:{provider:"fixture",name:"deterministic"}});
    expect(report,JSON.stringify(report)).toMatchObject({status:"passed",omittedBeforeRecall:true,recovered:true,handoff:true,revoked:true});
  } finally {await rm(root,{recursive:true,force:true});}
},120000);

it("fails closed when the model refuses the required recall instead of claiming a pass",async()=>{
  const root=await mkdtemp(join(tmpdir(),"traceforge-recall-failure-"));
  try {
    const report=await runRecallModelAcceptance({async extractJson(){return {type:"block",reason:"No recall"};}},
      {outputParent:root,mode:"simulated_harness_test",modelIdentity:{provider:"fixture",name:"refusal"}});
    expect(report).toMatchObject({status:"failed",omittedBeforeRecall:true,recovered:false,handoff:false,revoked:false});
    expect(report.calls).toHaveLength(1);expect(report.calls[0].status).toBe("failed");
  } finally {await rm(root,{recursive:true,force:true});}
},120000);
