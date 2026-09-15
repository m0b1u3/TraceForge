import {expect,it,vi} from "vitest";
import {WorkerDecisionExecutor} from "@traceforge/worker-runtime";
import {foundationHost,eventually} from "./test-fixtures/foundation-host.js";

it("consumes explicit long task consent through the host and completes beyond 24 turns", async () => {
  let steps = 0, summaries = 0;
  const host = await foundationHost({ longTaskScope: { continuousExecution: true, maximumWorkTurns: 48, maximumWorkMinutes: 2 }, model: async args => {
    const context = JSON.parse(args.user);
    if (Array.isArray(context.entries)) {
      summaries++;
      return { entries: context.entries.map((entry: { id: string }) => ({ id: entry.id, text: "Item processing progressed; remaining items still pending." })) };
    }
    expect(context.executionMode).not.toBe("conclude");
    steps++;
    return steps <= 26 ? { type: "invoke_tool", invocation: { id: `item-${steps}`, tool: "fixture.read", input: { candidate: `item-${steps}` }, rationale: "Process the next queued item without repeating completed items. ".repeat(32) } }
      : { type: "complete", summary: "Processed all 26 items", outputs: [] };
  } });
  try {
    await host.start(); await eventually(async () => (await host.state()).workItems[0]?.status === "completed");
    expect(steps).toBe(27); expect(host.calls()).toBe(26);
    expect(summaries).toBeGreaterThan(0);
    const calls = host.sqlite.prepare("SELECT role, work_id, status FROM scenario_model_calls WHERE snapshot_id LIKE 'compaction:%'").all() as Array<{ role: string; work_id: string; status: string }>;
    expect(calls).toHaveLength(summaries);
    expect(calls.every(call => call.role === "worker" && !!call.work_id && call.status === "completed")).toBe(true);
  } finally { await host.close(); }
});

it("finishes a bounded autonomous Work with a read-only model conclusion through the real host",async()=>{
  let steps=0,conclusions=0;
  let failure="";const conclude=WorkerDecisionExecutor.prototype.conclude;
  const spy=vi.spyOn(WorkerDecisionExecutor.prototype,"conclude").mockImplementation(async function(...args){try{return await conclude.apply(this,args);}catch(error){failure=String(error);throw error;}});
  const host=await foundationHost({model:async args=>{
    const context=JSON.parse(args.user);
    if(context.executionMode==="conclude"){
      conclusions++;expect(context.tools).toEqual([]);expect(context.sharedProgress.trust).toBe("untrusted_progress_not_evidence");
      return {type:"block",reason:"Existing observations retained; next prerequisite remains unresolved"};
    }
    steps++;return {type:"invoke_tool",invocation:{id:`step-${steps}`,tool:"fixture.read",input:{candidate:`candidate-${steps}`},rationale:"Continue the same direction"}};
  }});
  try{
    await host.start();await eventually(async()=>(await host.state()).workItems[0]?.status==="blocked");
    expect(steps).toBe(24);expect(conclusions,failure).toBe(1);expect(host.calls()).toBe(24);
    expect((await host.state()).workItems[0].error).toContain("next prerequisite");
  }finally{await host.close();spy.mockRestore();}
});
