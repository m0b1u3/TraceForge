import {expect,it} from "vitest";
import type {EvidenceGraphState} from "@traceforge/evidence-graph";
import {projectContextAnchors} from "./anchors.js";
it("bounds durable anchors and excludes invalid, superseded, foreign and unauthorized sources",()=>{
  const nodes=Array.from({length:12},(_,i)=>({id:`clue-${i}`,caseId:"case",runId:"run",kind:"fact",status:"active",summary:`Earlier clue ${i}`,properties:{contextAnchor:{refs:["receipt"],priority:i}}}));
  const graph={caseId:"case",nodes,edges:[]} as unknown as EvidenceGraphState;
  expect(projectContextAnchors(graph,"run",new Set(["receipt"]))).toMatchObject({entries:expect.any(Array),omitted:4});
  expect(projectContextAnchors(graph,"run",new Set(["receipt"])).entries).toHaveLength(8);
  expect(projectContextAnchors(graph,"run",new Set()).entries).toEqual([]);
  graph.nodes[11]!.status="invalidated";graph.nodes[10]!.runId="other";
  graph.edges.push({relation:"supersedes",targetId:"clue-9"} as any);
  expect(projectContextAnchors(graph,"run",new Set(["receipt"])).entries[0]!.id).toBe("clue-8");
});
