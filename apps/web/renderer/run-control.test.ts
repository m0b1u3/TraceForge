// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { RunControl } from "./run-control";
let dispose: (() => void) | undefined;
afterEach(() => { act(() => dispose?.()); document.body.replaceChildren(); localStorage.clear(); });
it("retains an uncertain stop and reconciles the same command before allowing replacement", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  let failed = true;
  const request = vi.fn(async (input: { body?: string }) => {
    if (failed) throw new Error("offline");
    const body = JSON.parse(input.body!);
    return { status: 200, body: { desktopReceipt: { version: 1, conversationId: "first", commandId: body.commandId, operation: "cancel", resourceId: "run" } } };
  });
  const node = document.createElement("div"); document.body.append(node); const root = createRoot(node); dispose = () => root.unmount();
  await act(async () => root.render(React.createElement(RunControl, { bridge: { protocolVersion: 1, request }, conversationId: "first", runId: "run", revision: 3, status: "running" })));
  expect(request).not.toHaveBeenCalled();
  await act(async () => [...node.querySelectorAll("button")].find(button=>button.textContent==="停止调查")!.click());
  expect(node.textContent).toContain("核对原请求"); expect(node.querySelector("button")!.disabled).toBe(true);
  failed = false;
  await act(async () => [...node.querySelectorAll("button")].find(button=>button.textContent==="核对原请求")!.click());
  expect(request.mock.calls[0]).toEqual(request.mock.calls[1]);
  expect(node.textContent).toContain("宿主已确认停止"); expect(localStorage.length).toBe(0);
});
it("requires explicit confirmation before resuming and never resumes while mounting",async()=>{
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  const request=vi.fn(async(input:{body?:string})=>{if(!input.body)return {status:200,body:{requests:[]}};const body=JSON.parse(input.body);return {status:200,body:{desktopReceipt:{version:1,conversationId:"first",commandId:body.commandId,operation:"resume",resourceId:"run"}}};});
  const node=document.createElement("div");document.body.append(node);const root=createRoot(node);dispose=()=>root.unmount();
  await act(async()=>root.render(React.createElement(RunControl,{bridge:{protocolVersion:1,request},conversationId:"first",runId:"run",revision:4,status:"paused"})));
  expect(request.mock.calls.every(([input])=>!input.body)).toBe(true);
  await act(async()=>[...node.querySelectorAll("button")].find(b=>b.textContent==="恢复调查")!.click());expect(request.mock.calls.every(([input])=>!input.body)).toBe(true);
  await act(async()=>[...node.querySelectorAll("button")].find(b=>b.textContent==="确认恢复")!.click());
  expect(JSON.parse(request.mock.calls.at(-1)![0].body!)).toMatchObject({runId:"run",expectedRevision:4,confirmed:true});
});
