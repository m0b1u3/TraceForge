import type {ScenarioRunState} from "@traceforge/orchestration-core";

/** Source-filtered progress only: never a new ledger or verified evidence. */
export function projectSharedProgress(run:ScenarioRunState){
  const open=run.workItems.filter(work=>["queued","running","waiting_approval","blocked"].includes(work.status));
  const directions=open.slice(-8).map(work=>({id:work.id,objective:work.objective.slice(0,600),status:work.status}));
  const grouped=new Map<string,{workIds:string[];objective:string;status:string;summary:string}>();
  let omittedIds=0;
  for(const work of run.workItems){
    if(!["completed","failed","blocked"].includes(work.status))continue;
    const summary=work.resultSummary??work.error;if(!summary)continue;
    const key=JSON.stringify([work.kind,work.objective.trim().replace(/\s+/g," "),work.status,summary]);
    const previous=grouped.get(key);
    if(previous){if(previous.workIds.length<8)previous.workIds.push(work.id);else omittedIds++;continue;}
    grouped.set(key,{workIds:[work.id],objective:work.objective.slice(0,600),status:work.status,summary:summary.slice(0,600)});
  }
  return {directions,outcomes:[...grouped.values()].slice(-8),omitted:omittedIds+Math.max(0,open.length-8)+Math.max(0,grouped.size-8),trust:"untrusted_progress_not_evidence" as const};
}
