// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { BrowserSessionControl } from "./browser-session-control";
let dispose: (() => void) | undefined;
it("shows uncertain cleanup and retries only on an explicit click", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  let closed = false;
  const request = vi.fn(async (input: { method: string; body?: string }) => {
    if (input.method === "GET") return { status: 200, body: { sessions: closed ? [] : [{ id: "session", status: "cleanup_unknown", takeoverId: null, expiresAt: "2099-01-01", workId: "work" }] } };
    expect(JSON.parse(input.body!).operation).toBe("close"); closed = true; return { status: 200, body: {} };
  });
  const node = document.createElement("div"); document.body.append(node); const root = createRoot(node); dispose = () => root.unmount();
  await act(async () => root.render(React.createElement(BrowserSessionControl, { bridge: { protocolVersion: 1, request }, conversationId: "conversation", runId: "run" })));
  expect(node.textContent).toContain("关闭尚未确认"); expect(node.textContent).not.toContain("接管浏览器");
  expect(request.mock.calls.every(([v]) => v.method === "GET")).toBe(true);
  await act(async () => { [...node.querySelectorAll("button")].find(b => b.textContent === "重试关闭")!.click(); });
  expect(request.mock.calls.filter(([v]) => v.method === "POST")).toHaveLength(1);
  expect(node.textContent).toBe("");
});
afterEach(() => { act(() => dispose?.()); document.body.replaceChildren(); vi.useRealTimers(); });
it("opens an active browser without taking control and keeps it visible after handback",async()=>{
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  let manual=false;
  const request=vi.fn(async(input:{method:string;body?:string})=>{
    if(input.method==="POST") manual=JSON.parse(input.body!).operation==="takeover";
    return {status:200,body:{sessions:[{id:"session",status:manual?"manual_control":"active",takeoverId:manual?"manual":null,expiresAt:"2099-01-01",workId:"work"}]}};
  });
  const presentBrowser=vi.fn(async(_input: unknown)=>({url:"https://example.invalid/"}));
  const node=document.createElement("div");document.body.append(node);const root=createRoot(node);dispose=()=>root.unmount();
  await act(async()=>root.render(React.createElement(BrowserSessionControl,{bridge:{protocolVersion:1,request,presentBrowser},conversationId:"conversation",runId:"run"})));
  expect(node.querySelector<HTMLDetailsElement>("details.browser-session-control")?.open).toBe(true);
  expect(document.querySelector('[aria-label="任务浏览器"]')?.textContent).toContain("智能体正在操作");
  await act(async()=>{node.querySelector("details.browser-session-control > summary")!.dispatchEvent(new MouseEvent("click",{bubbles:true}));});
  expect(node.querySelector<HTMLDetailsElement>("details.browser-session-control")?.open).toBe(false);
  expect(document.querySelector('[aria-label="任务浏览器"]')).not.toBeNull();
  expect(request.mock.calls.every(([input])=>input.method==="GET")).toBe(true);
  expect(presentBrowser).toHaveBeenCalledWith(expect.objectContaining({takeoverId:null}));
  await act(async()=>{[...document.querySelectorAll("button")].find(b=>b.textContent==="接管网页")!.click();});
  expect(document.querySelector('[aria-label="任务浏览器"]')?.textContent).toContain("由你控制");
  await act(async()=>{[...document.querySelectorAll("button")].find(b=>b.textContent==="交回智能体")!.click();});
  expect(document.querySelector('[aria-label="任务浏览器"]')?.textContent).toContain("智能体正在操作");
  expect(presentBrowser.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({ takeoverId: null }));
  expect(request.mock.calls.filter(([input])=>input.method==="POST").map(([input])=>JSON.parse(input.body!).operation)).toEqual(["takeover","resume"]);
});
it("shows a newly handed-off native page once without replaying a command or reopening a hidden panel",async()=>{
  vi.useFakeTimers();(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  const request=vi.fn(async()=>({status:200,body:{sessions:[{id:"session",status:"manual_control",takeoverId:"manual",expiresAt:"2099-01-01",workId:"work"}]}}));
  const presentBrowser=vi.fn(async()=>({url:"https://example.invalid/"}));
  const node=document.createElement("div");document.body.append(node);const root=createRoot(node);dispose=()=>root.unmount();
  await act(async()=>root.render(React.createElement(BrowserSessionControl,{bridge:{protocolVersion:1,request,presentBrowser},conversationId:"conversation",runId:"run"})));
  expect(document.querySelector('[aria-label="任务浏览器"]')).not.toBeNull();
  await act(async()=>{[...document.querySelectorAll("button")].find(b=>b.textContent==="收起")!.click();});
  await act(async()=>vi.advanceTimersByTimeAsync(3100));
  expect(document.querySelector('[aria-label="任务浏览器"]')).toBeNull();
  expect(request.mock.calls.every(args=>(args as any)[0].method==="GET")).toBe(true);
});
it("keeps actions explicit, shows ownership, clears entered text and never retries failed writes", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  let state = "active", fail = false;
  const request = vi.fn(async (input: { method: string; body?: string }) => {
    if (input.method === "GET") return { status: 200, body: { sessions: [{ id: "session", status: state, takeoverId: state === "manual_control" ? "manual" : null, expiresAt: "2099-01-01", workId: "work" }] } };
    const command = JSON.parse(input.body!);
    if (fail) return { status: 409, body: {} };
    if (command.operation === "takeover") state = "manual_control";
    if (command.operation === "observe") return { status: 200, body: { document: { nodes: [{ role: "textbox", name: "Account", description: "", editable: true, disabled: false,
      element: { backendNodeId: 1, view: { generation: 2, pageId: "page", documentId: "doc" } } }] } } };
    return { status: 200, body: {} };
  });
  const node = document.createElement("div"); document.body.append(node); const root = createRoot(node); dispose = () => root.unmount();
  await act(async () => root.render(React.createElement(BrowserSessionControl, { bridge: { protocolVersion: 1, request }, conversationId: "conversation", runId: "run" })));
  const click = async (label: string) => act(async () => { [...node.querySelectorAll("button")].find(b => b.textContent === label)!.click(); });
  expect(request.mock.calls.every(([v]) => v.method === "GET")).toBe(true);
  await click("接管浏览器"); expect(node.textContent).toContain("由你控制");
  await click("读取页面元素"); expect(node.querySelector('input[type="password"]')).not.toBeNull();
  fail = true; await click("填入页面");
  expect(node.querySelector("input")).toBeNull(); expect(node.querySelector('[role="alert"]')?.textContent).toContain("不会自动重试");
  expect(request.mock.calls.filter(([v]) => v.method === "POST")).toHaveLength(3);
  expect(node.querySelector("iframe")).toBeNull();
});
