import {expect,it} from "vitest";
import {ConversationDrafts} from "./conversation-drafts";
it("retains separate drafts across reload, removes sent text and refuses silent eviction",()=>{
  const data=new Map<string,string>();const storage={getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{data.set(key,value);}};
  const drafts=new ConversationDrafts(storage);drafts.write("new","first");drafts.write("conversation","second");
  expect(new ConversationDrafts(storage).read("new")).toBe("first");drafts.write("new","");
  expect(new ConversationDrafts(storage).read("new")).toBe("");expect(drafts.read("conversation")).toBe("second");
  expect(()=>drafts.write("oversize","a".repeat(16001))).toThrow();
  expect(drafts.read("conversation")).toBe("second");
});
