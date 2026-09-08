// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { readProgressPage, RunProgress } from "./run-progress";
const event = { protocolVersion: 2, id: "event", sequence: 1, runId: "run", caseId: "case", workId: null, turnId: "turn", role: "worker", createdAt: "2026-09-08T00:00:00.000Z", method: "turn/progress", params: { phase: "executing", summary: "Recorded progress", refs: [] } };
let unmount: (() => void) | undefined;
it("drains terminal history and stops high-frequency polling",async()=>{
  vi.useFakeTimers();(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  const finalEvent={...event,method:"turn/completed",params:{status:"completed",outcome:null,checkpointRef:null,error:null}};
  const request=vi.fn(async(input:{path:string})=>({status:200,body:{caseId:"case",runId:"run",events:input.path.endsWith("after=0")?[finalEvent]:[],nextCursor:1,hasMore:input.path.endsWith("after=0")}}));
  const node=document.createElement("div");document.body.append(node);const root=createRoot(node);unmount=()=>root.unmount();
  await act(async()=>root.render(React.createElement(RunProgress,{bridge:{protocolVersion:1,request},conversationId:"first",runId:"run",terminal:true})));
  await act(async()=>{await vi.advanceTimersByTimeAsync(100);});expect(request).toHaveBeenCalledTimes(2);
  await act(async()=>{await vi.advanceTimersByTimeAsync(15000);});expect(request).toHaveBeenCalledTimes(2);
  await act(async()=>{await vi.advanceTimersByTimeAsync(45000);});expect(request).toHaveBeenCalledTimes(3);
});
afterEach(() => { act(() => unmount?.()); document.body.replaceChildren(); vi.useRealTimers(); });
it("rejects crossed ownership, gaps and dishonest cursors", () => {
  const page = { caseId: "case", runId: "run", events: [], nextCursor: 0, hasMore: false };
  expect(readProgressPage(page, "run", 0).nextCursor).toBe(0);
  for (const change of [{ caseId: "other" }, { runId: "other" }, { nextCursor: 1 }, { hasMore: true }, { events: [{ ...event, sequence: 2 }] }])
    expect(() => readProgressPage({ ...page, ...change }, "run", 0, "case")).toThrow();
});
it("polls incrementally without writes and retains rendered facts on failure", async () => {
  vi.useFakeTimers();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  let failed = false;
  const item = { ...event, method: "item/completed", params: { item: { type: "toolCall", id: "tool", tool: "neutral-tool", status: "completed", summary: "<b>inert output</b>", refs: [] } } };
  const request = vi.fn(async (input: { path: string; method: string }) => ({ status: failed ? 503 : 200,
    body: { runId: "run", caseId: "case", events: input.path.endsWith("after=0") ? [item] : [], nextCursor: 1, hasMore: false } }));
  const node = document.createElement("div"); document.body.append(node); const root = createRoot(node); unmount = () => root.unmount();
  await act(async () => root.render(React.createElement(RunProgress, { bridge: { protocolVersion: 1, request }, conversationId: "first", runId: "run" })));
  expect(node.textContent).toContain("neutral-tool"); expect(node.querySelector("b")).toBeNull();
  failed = true; await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(node.textContent).toContain("读取中断"); expect(node.textContent).toContain("inert output");
  expect(request.mock.calls[1]?.[0].path).toContain("after=1");
  expect(request.mock.calls.every(([input]) => input.method === "GET")).toBe(true);
});
