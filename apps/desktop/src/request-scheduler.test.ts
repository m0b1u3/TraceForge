import { expect, it, vi } from "vitest";
import { RequestScheduler } from "./request-scheduler.js";
const tick = async () => { for(let i=0;i<8;i++)await Promise.resolve(); };
it("reserves a slot for control operations and prioritizes writes over queued reads",async()=>{
  const scheduler=new RequestScheduler(),order:string[]=[],release:Array<()=>void>=[];
  const operation=(name:string)=>()=>new Promise<string>(resolve=>{order.push(name);release.push(()=>resolve(name));});
  const reads=Array.from({length:8},(_,i)=>scheduler.schedule(false,operation(`read${i}`)));
  await tick();expect(order).toEqual(["read0","read1"]);
  const normal=scheduler.schedule(true,operation("write"));
  const stop=scheduler.schedule(true,operation("stop"),undefined,true);
  await tick();expect(order.at(-1)).toBe("stop");
  expect(order).toEqual(["read0","read1","write","stop"]);
  release[0]!();release[3]!();await tick();expect(order[4]).toBe("read2");
  for(let i=0;i<12;i++){for(const done of release)done();await tick();}
  await Promise.all([...reads,normal,stop]);expect(order.filter(n=>n==="stop")).toHaveLength(1);
});
it("stalled observations cannot block a new message or stop; close settles callers without retry",async()=>{
  const scheduler=new RequestScheduler(),never=vi.fn(()=>new Promise<void>(()=>{}));
  const reads=Array.from({length:3},()=>scheduler.schedule(false,never).catch(e=>e.message));
  await tick();expect(never).toHaveBeenCalledTimes(2);
  const write=vi.fn(async()=>"saved");expect(await scheduler.schedule(true,write)).toBe("saved");
  const active=scheduler.schedule(true,never).catch(e=>e.message);await tick();
  expect(await scheduler.schedule(true,async()=>"stopped",undefined,true)).toBe("stopped");
  scheduler.close();expect(await active).toContain("unknown");
  expect((await Promise.all(reads)).every(message=>message.includes("closed"))).toBe(true);
  expect(write).toHaveBeenCalledOnce();expect(never).toHaveBeenCalledTimes(3);
});
it("coalesces identical reads, never retries failed commands, and rejects undispatched work on close",async()=>{
  const scheduler=new RequestScheduler();let finish!:(value:number)=>void;
  const run=vi.fn(()=>new Promise<number>(resolve=>{finish=resolve;}));
  const first=scheduler.schedule(false,run,"same"),second=scheduler.schedule(false,run,"same");
  await tick();expect(run).toHaveBeenCalledOnce();finish(1);expect(await first).toBe(1);expect(await second).toBe(1);
  const failure=vi.fn(async()=>{throw new Error("unknown result");});
  await expect(scheduler.schedule(true,failure)).rejects.toThrow("unknown");expect(failure).toHaveBeenCalledOnce();
  const held=Array.from({length:3},()=>scheduler.schedule(false,run).catch(()=>-1));await tick();
  const queued=vi.fn(async()=>1),pending=scheduler.schedule(true,queued);
  const rejected=expect(pending).rejects.toThrow("closed");scheduler.close();await rejected;expect(queued).not.toHaveBeenCalled();
  finish(1);void held;
});
it("bounds background queue while retaining capacity for a critical command",async()=>{
  const scheduler=new RequestScheduler(),run=()=>new Promise<void>(()=>{});
  const pending=Array.from({length:67},()=>scheduler.schedule(false,run).catch(()=>{}));
  await expect(scheduler.schedule(false,run)).rejects.toThrow("full");
  const critical=vi.fn(async()=>1);expect(await scheduler.schedule(true,critical,undefined,true)).toBe(1);
  scheduler.close();void pending;
});
