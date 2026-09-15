import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect,it} from "vitest";
import {runRecallModelAcceptance} from "./test-fixtures/recall-model-acceptance.js";

it.each([0, -1, 120001, 1.5])("rejects invalid model deadline %s before running the host", async modelCallTimeoutMs => {
  await expect(runRecallModelAcceptance({ async extractJson() { throw new Error("must not call"); } }, {
    outputParent: "/unused", mode: "simulated_harness_test", modelIdentity: { provider: "fixture", name: "invalid" }, modelCallTimeoutMs,
  })).rejects.toThrow("invalid_model_timeout");
});

it("drives compressed recall, persisted supervisor handoff and withdrawal through the host",async()=>{
  const root=await mkdtemp(join(tmpdir(),"traceforge-recall-test-"));
  try {
    const report=await runRecallModelAcceptance({async extractJson(args){
      const token=args.user.match(/observed-[a-f0-9]{24}/)?.[0];
      if(args.system.includes("strategic Planner")) return {action:"wait",rationale:token??"Source withheld; await instruction"};
      if(args.system.includes("Run Observer")) return {action:"continue",rationale:token??"Source withheld; no evidence claim"};
      if(token) return {type:"complete",summary:token,outputs:[]};
      const c=JSON.parse(args.user);
      return {type:"invoke_tool",invocation:{id:"recover",tool:"context.recall",input:{receiptKey:c.historySummary?.receiptKeys[0]??c.transcript.find((entry:any)=>entry.kind==="tool").receiptKey},rationale:"Read missing original"}};
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
    expect(report.calls).toHaveLength(1);expect(report.calls[0]).toMatchObject({status:"failed", failure:"recall_not_selected"});
  } finally {await rm(root,{recursive:true,force:true});}
},120000);

it("records a model deadline distinctly and aborts the outstanding request", async () => {
  const root=await mkdtemp(join(tmpdir(),"traceforge-recall-timeout-"));
  let cancelled=false;
  try {
    const report=await runRecallModelAcceptance({async extractJson(args){
      await new Promise<void>((resolve)=>{args.signal!.addEventListener("abort",()=>{cancelled=true;resolve();},{once:true});});
      throw new Error("private upstream diagnostic must not escape");
    }},{outputParent:root,mode:"simulated_harness_test",modelIdentity:{provider:"fixture",name:"timeout"},modelCallTimeoutMs:100});
    expect(report).toMatchObject({status:"failed",failure:"model_deadline"});
    expect(report.calls).toHaveLength(1);expect(report.calls[0].failure).toBe("model_deadline");
    expect(cancelled).toBe(true);expect(JSON.stringify(report)).not.toContain("private upstream");
  } finally {await rm(root,{recursive:true,force:true});}
},120000);
