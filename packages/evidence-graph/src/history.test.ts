import {expect,it} from "vitest";
import {projectCaseHistory} from "./history.js";
import type {EvidenceGraphState,KnowledgeNode} from "./model.js";
const node=(id:string,overrides:Partial<KnowledgeNode>={}):KnowledgeNode=>({id,caseId:"case",runId:"previous",kind:"finding",status:"verified",title:"Prior result",summary:"Applicable only under the recorded preconditions",properties:{},source:null,confidence:1,version:1,createdAt:"2026-09-08",updatedAt:"2026-09-08",invalidatedAt:null,invalidationReason:null,...overrides});
it("retrieves historical conclusions and limitations without promoting current evidence or exposing unrelated records",()=>{
  const graph:EvidenceGraphState={caseId:"case",revision:1,createdAt:"now",updatedAt:"now",edges:[],nodes:[node("valid"),node("limit",{kind:"limitation",status:"active"}),node("candidate",{status:"candidate"}),node("invalid",{invalidatedAt:"now"}),node("foreign",{caseId:"other"}),node("current",{runId:"current"})]};
  const entries=projectCaseHistory(graph,{caseId:"case",runId:"current"});expect(entries.map(row=>row.id)).toEqual(["valid","limit"]);expect(entries.every(row=>!row.currentRunVerified)).toBe(true);
  graph.edges.push({id:"replaced",caseId:"case",sourceId:"limit",targetId:"valid",relation:"supersedes",rationale:"New state",createdAt:"now"});expect(projectCaseHistory(graph,{caseId:"case",runId:"current"})).toHaveLength(1);
  expect(()=>projectCaseHistory(graph,{caseId:"other",runId:"current"})).toThrow("Invalid");
});
