/** Exact normalized objectives, not speculative semantic similarity. Titles are presentation. */
export function workDirectionSignature(kind:string,objective:string){
  return JSON.stringify([kind,objective.normalize("NFC").trim().replace(/\s+/g," ").toLowerCase()]);
}
export function holdsWorkDirection(status:string){return !["completed","failed","cancelled"].includes(status);}
