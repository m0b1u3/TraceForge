import {expect,it} from "vitest";
import {ConversationDrafts} from "./conversation-drafts";
it("migrates existing window drafts once without replacing newer persistent drafts", () => {
  const memory = () => { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } }; };
  const old = memory(), durable = memory(); new ConversationDrafts(old).write("new", "unsent");
  const restored = ConversationDrafts.persistent(durable, old); expect(restored.read("new")).toBe("unsent"); restored.write("new", "newer");
  expect(ConversationDrafts.persistent(durable, old).read("new")).toBe("newer");
});
it("retains separate drafts across reload, removes sent text and refuses silent eviction",()=>{
  const data=new Map<string,string>();const storage={getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{data.set(key,value);}};
  const drafts=new ConversationDrafts(storage);drafts.write("new","first");drafts.write("conversation","second");
  expect(new ConversationDrafts(storage).read("new")).toBe("first");drafts.write("new","");
  expect(new ConversationDrafts(storage).read("new")).toBe("");expect(drafts.read("conversation")).toBe("second");
  expect(()=>drafts.write("oversize","a".repeat(16001))).toThrow();
  expect(drafts.read("conversation")).toBe("second");
});
