import type { EvidenceGraphState } from "./model.js";
/** Historical context is not current-Run evidence and carries no execution grant. */
export function projectCaseHistory(graph:EvidenceGraphState,reader:{caseId:string;runId:string},query="",limit=20){
  if(graph.caseId!==reader.caseId||!Number.isSafeInteger(limit)||limit<1||limit>100||query.length>512)throw new Error("Invalid Case history query");
  const terms=query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const superseded=new Set(graph.edges.filter(edge=>edge.relation==="supersedes").map(edge=>edge.targetId));
  return graph.nodes.filter(node=>node.caseId===reader.caseId&&node.runId!==null&&node.runId!==reader.runId&&!node.invalidatedAt&&!superseded.has(node.id)
    &&((node.kind==="finding"&&node.status==="verified")||(node.kind==="validation_conclusion"&&node.status==="resolved")||(node.kind==="limitation"&&node.status==="active"))
    &&terms.every(term=>`${node.title} ${node.summary}`.toLocaleLowerCase().includes(term)))
    .slice(-limit).map(node=>({id:node.id,sourceRunId:node.runId,kind:node.kind,status:node.status,title:node.title,summary:node.summary,
      updatedAt:node.updatedAt,reference:`knowledge-node:${node.id}`,trust:"historical_context" as const,currentRunVerified:false,
      limitation:"Historical conclusion only; revalidate applicability and current authorization before acting. Original artifacts require their own authorized read."}));
}
