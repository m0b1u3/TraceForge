import {expect,it} from "vitest";
import {rankMemoryCandidates,selectMemorySources} from "./memory-retrieval.js";
it("fuses literal, variant, relationship and semantic ranks without inventing sources",()=>{
  const candidates=[{id:"first",text:"credential expired",sequence:1},{id:"second",text:"登录条件发生变化",sequence:2},{id:"third",text:"other",sequence:3,references:["first"]}];
  expect(rankMemoryCandidates(candidates,"登录条件")[0].id).toBe("second");
  const ranked=rankMemoryCandidates(candidates,"authentication",{variants:["credential"],related:["first"],semanticIds:["first","second","invented"]});
  expect(ranked[0].id).toBe("first");expect(ranked.map(r=>r.id)).not.toContain("invented");expect(ranked.some(r=>r.id==="third")).toBe(true);
});
it("does not let a large source consume smaller sources' budget",()=>{
  expect(selectMemorySources([200,3,4,100],8,x=>x)).toEqual({selected:[3,4],skipped:[200,100],usedTokens:7,truncated:true});
});
