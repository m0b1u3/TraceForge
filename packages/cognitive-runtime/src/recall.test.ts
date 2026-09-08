import { expect, it } from "vitest";
import { ContextRecallRuntime } from "./recall.js";
it("pages immutable originals and requires exact identity for continuation", async () => {
  const text = "a".repeat(2401), runtime = new ContextRecallRuntime({async readCurrent(){return {text,refs:["original"]};}});
  const first = await runtime.read({id:"receipt"},{});
  expect(first.text.length).toBe(1200); expect(first.nextOffset).toBe(1200);
  const next = await runtime.read({id:"receipt",offset:1200,digest:first.digest},{});
  expect(next.nextOffset).toBe(2400);
  await expect(runtime.read({id:"receipt",offset:1200},{})).rejects.toThrow();
  await expect(runtime.read({id:"receipt",digest:"0".repeat(64)},{})).rejects.toThrow();
});
it("rejects revocation or mutation during asynchronous reading", async () => {
  let count=0;
  const runtime = new ContextRecallRuntime({async readCurrent(){ if (++count>1) throw new Error("revoked"); return {text:"original",refs:[]}; }});
  await expect(runtime.read({id:"receipt"},{})).rejects.toThrow("revoked");
  count=0;
  const changed = new ContextRecallRuntime({async readCurrent(){return {text:++count===1?"original":"replacement",refs:[]};}});
  await expect(changed.read({id:"receipt"},{})).rejects.toThrow("changed");
});
it("honors cancellation without reading any source", async () => {
  let calls=0; const runtime = new ContextRecallRuntime({async readCurrent(){calls++;return {text:"original",refs:[]};}});
  const stop=new AbortController();stop.abort();
  await expect(runtime.read({id:"receipt"},{},stop.signal)).rejects.toThrow();expect(calls).toBe(0);
});
