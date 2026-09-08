import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect,it} from "vitest";
import {runPlanningModelAcceptance} from "./test-fixtures/planning-model-acceptance.js";

it("lets the host apply model plans and transfer a recalled result into a second Work",async()=>{
  const root=await mkdtemp(join(tmpdir(),"traceforge-plan-test-"));
  try{
    const report=await runPlanningModelAcceptance({async extractJson(args){
      const c=JSON.parse(args.user),token=args.user.match(/observed-[a-f0-9]{24}/)?.[0];
      if(args.system.includes("strategic Planner")) {
        const count=c.run.workItems.length;
        if(count===2)return {action:"wait",rationale:token};
        return {action:"plan",rationale:"Sequential neutral work",proposals:[{kind:"observe",title:count===0?"Collect":"Review",
          objective:count===0?"Read fixture.read, recall its saved raw output with tool.recall, then complete with exactly observationToken and outputs: [].":`Review ${token}; complete with exactly ${token} and outputs: [] without tools.`,
          priority:50,requiredCapabilities:["fixture.read","tool.recall"],hypothesisIds:[],evidenceRefs:[],maxAttempts:1}],cancellations:[],reprioritizations:[]};
      }
      if(args.system.includes("Run Observer"))return {action:"continue",rationale:token};
      if(c.work.title==="Review"||args.user.includes("untrusted_observation"))return {type:"complete",summary:token,outputs:[]};
      const observed=c.transcript.find((entry:any)=>entry.kind==="tool");
      return {type:"invoke_tool",invocation:{id:observed?"recall":"read",tool:observed?"tool.recall":"fixture.read",
        input:observed?{receiptKey:observed.receiptKey}:{},rationale:"Observe original once"}};
    }},{outputParent:root,mode:"simulated_harness_test",modelIdentity:{provider:"fixture",name:"deterministic"}});
    expect(report,JSON.stringify(report)).toMatchObject({status:"passed",plannedWorks:2,originalEffects:1,receipts:2,followupHasLineage:true,integrity:"ok"});
  }finally{await rm(root,{recursive:true,force:true});}
},180000);
