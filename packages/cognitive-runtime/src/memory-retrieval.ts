import {estimateContextTokens} from "@traceforge/shared/model-context";

export interface MemoryCandidate {id:string;text:string;sequence:number;references?:string[]}
export function memoryExcerpt(text:string,query:string,maximum=600){
  const lower=text.toLowerCase();const indices=[query,...terms(query)].map(term=>lower.indexOf(term.toLowerCase())).filter(at=>at>=0);
  const start=indices.length?Math.max(0,Math.min(...indices)-100):0;
  return text.slice(start,start+maximum);
}
const terms=(value:string)=>{
  const normalized=value.normalize("NFKC").toLowerCase();
  const words=normalized.match(/[\p{L}\p{N}_./:-]+/gu)??[];
  return [...new Set(words.flatMap(word=>/\p{Script=Han}/u.test(word)?Array.from(word).flatMap((c,i,a)=>i<a.length-1?[c+a[i+1]]:[c]):[word]))];
};
/** Pure retrieval projection. No database, inference, authorization or Scenario policy. */
export function rankMemoryCandidates(candidates:MemoryCandidate[],query:string,options:{variants?:string[];related?:string[];semanticIds?:string[]}={}){
  const lists:string[][]=[];
  for(const text of [query,...options.variants??[]]){
    const tokens=terms(text);
    const ranked=candidates.map(candidate=>{
      const body=candidate.text.normalize("NFKC").toLowerCase(),present=new Set(terms(candidate.text));
      const score=(body.includes(text.normalize("NFKC").toLowerCase())?2:0)+tokens.reduce((n,token)=>n+(present.has(token)?1:0),0)/Math.max(1,tokens.length);
      return {id:candidate.id,score,sequence:candidate.sequence};
    }).filter(item=>item.score>0).sort((a,b)=>b.score-a.score||b.sequence-a.sequence);
    lists.push(ranked.map(item=>item.id));
  }
  if(options.related?.length)lists.push(candidates.filter(c=>options.related!.includes(c.id)||c.references?.some(r=>options.related!.includes(r))).sort((a,b)=>b.sequence-a.sequence).map(c=>c.id));
  if(options.semanticIds?.length)lists.push([...new Set(options.semanticIds)].filter(id=>candidates.some(c=>c.id===id)));
  const scores=new Map<string,number>();
  for(const list of lists)list.forEach((id,index)=>scores.set(id,(scores.get(id)??0)+1/(60+index)));
  return candidates.filter(c=>scores.has(c.id)).sort((a,b)=>scores.get(b.id)!-scores.get(a.id)!||b.sequence-a.sequence||a.id.localeCompare(b.id));
}

/** A large source skips only itself. Never silently return a partial source as complete. */
export function selectMemorySources<T>(items:T[],maxTokens:number,count:(item:T)=>number=estimateContextTokens){
  const selected:T[]=[],skipped:T[]=[];let usedTokens=0;
  for(const item of items){const cost=count(item);if(!Number.isFinite(cost)||cost<0||usedTokens+cost>maxTokens){skipped.push(item);continue;}selected.push(item);usedTokens+=cost;}
  return {selected,skipped,usedTokens,truncated:skipped.length>0};
}
