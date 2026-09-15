import {expect,it} from "vitest";
import type {ScenarioRunState} from "@traceforge/orchestration-core";
import {projectSharedProgress} from "./shared-progress.js";
import {workDirectionSignature,holdsWorkDirection} from "./work-direction.js";

it("identifies an exact direction independent of its title and keeps blocked ownership",()=>{
  expect(workDirectionSignature("research","  Check   first\nresource ")).toBe(workDirectionSignature("research","Check first resource"));
  expect(workDirectionSignature("research","second resource")).not.toBe(workDirectionSignature("research","first resource"));
  expect(holdsWorkDirection("blocked")).toBe(true);expect(holdsWorkDirection("completed")).toBe(false);
});
it("shares bounded deduplicated outcomes including failed attempts without claiming evidence",()=>{
  const works=Array.from({length:12},(_,i)=>({id:`work-${i}`,kind:"research",objective:"Check first resource",status:"failed",error:"Prerequisite unavailable",resultSummary:null}));
  const run={workItems:works} as unknown as ScenarioRunState;
  const before=JSON.stringify(run),value=projectSharedProgress(run);
  expect(value.outcomes).toHaveLength(1);expect(value.outcomes[0].workIds).toHaveLength(8);
  expect(value.outcomes[0].summary).toBe("Prerequisite unavailable");expect(value.trust).toBe("untrusted_progress_not_evidence");expect(JSON.stringify(run)).toBe(before);
  works.forEach((w,i)=>{w.objective=`Question ${i}`;w.status="blocked";});
  expect(projectSharedProgress(run)).toMatchObject({directions:expect.any(Array),omitted:8});expect(projectSharedProgress(run).directions).toHaveLength(8);
});
