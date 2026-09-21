// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ConversationExecution, parseConversationRuns } from "./conversation-execution";
import type { SavedMessage } from "./conversation-client";

let dispose: (() => void) | undefined;
afterEach(() => { act(() => dispose?.()); vi.useRealTimers(); document.body.replaceChildren(); localStorage.clear(); });
const messages: SavedMessage[] = [{ conversationId: "first", commandId: "message", sequence: 1, text: "检查已授权范围",
  createdAt: "2026-09-08", role: "user", persistence: "saved", delivery: "not_dispatched", reason: "conversation_dispatch_not_connected" }];
const run = { runId: "run", messageCommandId: "message", goal: "检查已授权范围", status: "running", revision: 1,
  workItems: [{ id: "work", title: "收集观察", status: "running" }], outputs: [{ id: "output", summary: "已保存观察，结论仍待核查。", refs: ["evidence:first"] }] };
it("shows a newly streamed task proposal without switching pages or dispatching",async()=>{
  vi.useFakeTimers();(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  let proposed=false;
  const calls:Array<{path:string;method:string}>=[];
  const reply={conversationId:"first",messageCommandId:"message",revision:1,state:"streaming",text:"Preparing",createdAt:"2026-09-08T00:00:00.000Z",updatedAt:"2026-09-08T00:00:00.000Z",error:null,contextMessages:1,contextTruncated:false};
  const catalog={runs:[],scopes:[],truncated:false,modelReady:true,definitions:[{kind:"review",version:1,authorizationForm:{version:1,description:"Resources",fields:[{path:["resources"],label:"Resources",description:"Literal resources",type:"string-list",required:true,maximumItems:8,maximumLength:100}]},authorizationReview:{allowedActions:["resource.read"],deniedActions:[],resources:[]}}]};
  const bridge={protocolVersion:1 as const,async request(input:any){
    calls.push(input);
    if(input.path.includes("/replies?")){
      const revision=proposed?2:1,after=Number(input.path.split("after=")[1]);
      return {status:200,body:{conversationId:"first",replies:after<revision?[{...reply,revision,...(proposed?{state:"completed",taskRequest:{scenarioKind:"review",definitionVersion:1}}:{})}]:[],nextAfter:Math.max(after,revision),hasMore:false}};
    }
    return {status:200,body:input.path.endsWith("/browser")?{sessions:[]}:input.path.endsWith("/reply-queue")?{conversationId:"first",revision:0,paused:false,items:[]}:catalog};
  }};
  const node=document.createElement("div");document.body.append(node);const root=createRoot(node);dispose=()=>root.unmount();
  await act(async()=>root.render(React.createElement(ConversationExecution,{bridge,conversationId:"first",messages})));
  expect(node.querySelector('[aria-label="任务授权"]')).toBeNull();
  proposed=true;await act(async()=>{await vi.advanceTimersByTimeAsync(5000);});
  expect(node.querySelector('[aria-label="任务授权"] textarea')).not.toBeNull();
  expect(calls.every(call=>call.method==="GET")).toBe(true);
});
async function mount(request: (input: { path: string; method: "GET" | "POST" }) => Promise<{ status: number; body: unknown }>) {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const node = document.createElement("div"); document.body.append(node); const root = createRoot(node); dispose = () => root.unmount();
  await act(async () => { root.render(React.createElement(ConversationExecution, { bridge: { protocolVersion: 1, request: input => input.path.endsWith("/browser")?Promise.resolve({status:200,body:{sessions:[]}}):input.path.endsWith("/reply-queue")?Promise.resolve({status:200,body:{conversationId:"first",revision:0,paused:false,items:[]}}):input.path.includes("/replies?")
    ? Promise.resolve({status:200,body:{conversationId:"first",replies:[],nextAfter:0,hasMore:false}}) : request(input) }, conversationId: "first", messages })); });
  return node;
}
it("projects host-bound output after the user message and never dispatches on read", async () => {
  const request = vi.fn(async () => ({ status: 200, body: { runs: [run], truncated: false } }));
  const node = await mount(request);
  expect(node.querySelector(".message-user")?.textContent).toContain(messages[0].text);
  expect(node.querySelector(".message-assistant")?.textContent).toContain(run.outputs[0].summary);
  expect(node.textContent).toContain("执行中");
  expect(node.textContent).toContain("evidence:first");
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[0]).toEqual([{ path: "/api/desktop/conversations/first/execution", method: "GET" }]);
  expect(node.querySelector(".execution-panel")).toBeNull();
});
it("does not show authorization merely because a message was saved", async () => {
  const request = vi.fn(async (_input: { method: string }) => ({ status: 200, body: { runs: [], scopes: [], truncated: false,
    modelReady: true, definitions: [{ kind: "review", version: 1,
      authorizationForm: { version: 1, description: "Enter literal resources", fields: [{ path: ["resources"], label: "Resources", description: "One per line", type: "string-list", required: true, maximumItems: 8, maximumLength: 100 }] },
      authorizationReview: { allowedActions: ["resource.read"], deniedActions: [], resources: [] } }] } }));
  const node = await mount(request);
  expect(node.querySelector('[aria-label="任务授权"]')).toBeNull();
  expect(node.querySelector("textarea")).toBeNull();
  expect(request.mock.calls.every(([input]) => input.method === "GET")).toBe(true);
  expect(node.querySelectorAll(".authorization-form")).toHaveLength(0);
});
it("retains stale observations on failure, recovers and replaces rather than duplicates output", async () => {
  vi.useFakeTimers(); let fail = false;
  const request = vi.fn(async (input: { method: string; path: string }) => ({ status: fail ? 503 : 200, body: input.path.includes("/events?")
    ? { caseId: "case", runId: "run", events: [], nextCursor: 0, hasMore: false }
    : { runs: [{ ...run, status: "completed" }], truncated: true } }));
  const node = await mount(request);
  fail = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(node.textContent).toContain("上次读取结果");
  expect(node.textContent).toContain(run.outputs[0].summary);
  fail = false;
  await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
  expect(node.querySelector('[role="alert"]')).toBeNull();
  expect(node.querySelectorAll(".run-output")).toHaveLength(1);
  expect(node.textContent).toContain("最近 20 次运行");
  expect(request.mock.calls.every(call => (call[0] as { method: string }).method === "GET")).toBe(true);
});
it("does not guess message ownership for unbound runs or render upstream HTML", async () => {
  const node = await mount(async () => ({ status: 200, body: { runs: [{ ...run, messageCommandId: null,
    outputs: [{ id: "output", summary: '<img src=x onerror="alert(1)">', refs: [] }] }], truncated: false } }));
  expect(node.querySelector('[aria-label="会话关联运行"]')).not.toBeNull();
  expect(node.querySelector("img")).toBeNull();
  expect(node.textContent).toContain("<img");
});
it("rejects malformed or duplicate host observations", () => {
  for (const runs of [[{ ...run, outputs: [{ id: "bad", summary: "text", refs: [null] }] }], [run, run], [{ ...run, messageCommandId: undefined }]])
    expect(() => parseConversationRuns({ runs, truncated: false })).toThrow();
});

it("does not display late responses after switching the conversation", async () => {
  let finish!: (value: { status: number; body: unknown }) => void;
  const pending = new Promise<{ status: number; body: unknown }>(resolve => { finish = resolve; });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const node = document.createElement("div"); document.body.append(node); const root = createRoot(node); dispose = () => root.unmount();
  const bridge = { protocolVersion: 1 as const, request: async (input: { path: string }) => input.path.includes("/first/") ? pending
    : { status: 200, body: { runs: [], truncated: false } } };
  await act(async () => { root.render(React.createElement(ConversationExecution, { key: "first", bridge, conversationId: "first", messages })); });
  await act(async () => { root.render(React.createElement(ConversationExecution, { key: "second", bridge, conversationId: "second", messages: [] })); });
  await act(async () => { finish({ status: 200, body: { runs: [run], truncated: false } }); });
  expect(node.textContent).not.toContain(run.outputs[0].summary);
  expect(node.querySelector(".message-assistant")).toBeNull();
});
