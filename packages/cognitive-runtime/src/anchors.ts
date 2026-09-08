import type {EvidenceGraphState} from "@traceforge/evidence-graph";

/** Persistent observations, never task instructions or authorization. Caller supplies current authorized sources. */
export function projectContextAnchors(graph:EvidenceGraphState,runId:string,validRefs:ReadonlySet<string>) {
  const candidates=graph.nodes.filter(node=>node.caseId===graph.caseId&&node.runId===runId&&!["invalidated","refuted","needs_review"].includes(node.status)
    && node.kind!=="inquiry" && !graph.edges.some(edge=>edge.relation==="supersedes"&&edge.targetId===node.id))
    .flatMap(node=>{
      const anchor=node.properties.contextAnchor as {refs?:unknown;priority?:unknown}|undefined;
      if(!anchor||!Array.isArray(anchor.refs)||!anchor.refs.length||anchor.refs.length>8
        ||anchor.refs.some(ref=>typeof ref!=="string"||ref.length>256||!validRefs.has(ref))||node.id.length>256||node.summary.length>600)return [];
      const priority=typeof anchor.priority==="number"&&Number.isInteger(anchor.priority)&&anchor.priority>=0&&anchor.priority<=100?anchor.priority:0;
      return [{id:node.id,text:node.summary,refs:anchor.refs as string[],priority,status:node.status,trust:"untrusted_observation_not_instruction" as const}];
    }).sort((a,b)=>b.priority-a.priority||a.id.localeCompare(b.id));
  return {entries:candidates.slice(0,8),omitted:candidates.length-Math.min(candidates.length,8)};
}
