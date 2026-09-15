// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { HostWorkbench } from "./host-workbench";
import { Simulate } from "react-dom/test-utils";

let dispose: (() => void) | undefined;
afterEach(() => { act(() => dispose?.()); document.body.replaceChildren(); localStorage.clear(); sessionStorage.clear(); });

it("renders host-empty state without demo evidence or approval and restores a selected conversation", async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const c = { id: "conversation-1", caseId: "case-1", title: "已保存会话", createdAt: "2026-09-06" };
  const calls: string[] = [];
  const bridge = { protocolVersion: 1 as const, request: async (input: { path: string }) => {
    calls.push(input.path);
    return { status: 200, body: input.path.endsWith("conversations") ? { conversations: [c] } : input.path.includes("messages?") ? { conversationId: c.id, messages: [], hasMore: false, nextAfter: 0 } : c };
  } };
  const node = document.createElement("div"); document.body.append(node); const root = createRoot(node); dispose = () => root.unmount();
  await act(async () => { root.render(React.createElement(HostWorkbench, { bridge })); });
  expect(node.textContent).toContain("这次想调查什么？");
  await act(async () => (node.querySelector('button[aria-label="会话记录"]') as HTMLButtonElement).click());
  expect(node.textContent).toContain("已保存会话");
  expect(node.textContent).not.toContain("观察 01");
  expect(node.textContent).not.toContain("查看并确认");
  const select = [...node.querySelectorAll("button")].find(button => button.textContent?.startsWith("已保存会话"))!;
  await act(async () => { select.click(); });
  expect(node.textContent).toContain("记录你的调查意图");
  expect(node.querySelector("textarea")?.disabled).toBe(false);
  expect(calls).toContain("/api/desktop/conversations/conversation-1/messages?after=0&limit=100");
});

it("protects configuration drafts when leaving settings and hides the conversation composer", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const node = document.createElement("div"); document.body.append(node); const root = createRoot(node); dispose = () => root.unmount();
  await act(async () => root.render(React.createElement(HostWorkbench, { bridge: { protocolVersion: 1, request: async ({ path }) => ({ status: 200,
    body: path === "/api/desktop/configuration" ? { packages: [{ package: { id: "neutral", version: "1", schemaRevision: 1 }, title: "Neutral", revision: 0,
      resources: [{ id: "guide", summary: "Guide", type: "skill", phases: [], roles: [], defaultContent: "Default", content: null, defaultDigest: "a", editable: true, enabled: true }], mcp: [] }] } : { conversations: [] },
  }) } })));
  await act(async () => (node.querySelector('button[aria-label="设置"]') as HTMLButtonElement).click());
  await act(async () => [...node.querySelectorAll("button")].find(b => b.textContent === "场景与扩展")!.click());
  expect(node.querySelector('textarea[aria-label="保存调查说明"]')).toBeNull();
  const field = node.querySelector('textarea[aria-label="指导内容"]') as HTMLTextAreaElement;
  await act(async () => { field.value = "Keep this draft"; Simulate.change(field); });
  await act(async () => (node.querySelector('button[aria-label="对话"]') as HTMLButtonElement).click());
  expect((node.querySelector('textarea[aria-label="指导内容"]') as HTMLTextAreaElement).value).toBe("Keep this draft");
  expect(node.textContent).toContain("尚未保存");
});

it("starts from the composer and clears confirmed text even when history refresh fails",async()=>{
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  const c={id:"first",caseId:"case",title:"First goal",createdAt:"2026-09-08"};
  const posts:string[]=[];let failRead=true;let saved:any;
  const node=document.createElement("div");document.body.append(node);const root=createRoot(node);dispose=()=>root.unmount();
  await act(async()=>root.render(React.createElement(HostWorkbench,{bridge:{protocolVersion:1,request:async({path,method,body})=>{
    if(method==="POST"){
      posts.push(path);const data=JSON.parse(body!);
      if(path.includes("/replies/"))return {status:503,body:{error:"streaming_model_unavailable"}};
      if(path.endsWith("messages")){saved={conversationId:c.id,commandId:data.commandId,sequence:1,text:data.text,createdAt:c.createdAt,role:"user",persistence:"saved",delivery:"not_dispatched",reason:"conversation_dispatch_not_connected"};return {status:200,body:saved};}
      return {status:200,body:c};
    }
    if(path.endsWith("/first")&&failRead){failRead=false;throw new Error("Disconnected");}
    return {status:200,body:path.endsWith("conversations")?{conversations:[c]}:path.includes("messages?")?{conversationId:c.id,messages:[saved],hasMore:false,nextAfter:1}:path.endsWith("execution")?{runs:[],truncated:false}:c};
  }}})));
  const field=node.querySelector("textarea")!;expect(field.disabled).toBe(false);
  expect(node.querySelector('select[aria-label="消息用途"]')).toBeNull();
  await act(async()=>{field.value="First goal";Simulate.change(field);});
  await act(async()=>node.querySelector<HTMLButtonElement>('[aria-label="发送给助手"]')!.click());
  expect(posts).toEqual(["/api/desktop/conversations","/api/desktop/conversations/first/messages",`/api/desktop/conversations/first/replies/${saved.commandId}`]);
  expect(field.value).toBe("");expect(node.textContent).toContain("视图刷新失败");
  await act(async()=>[...node.querySelectorAll("button")].find(b=>b.textContent==="重新连接并读取")!.click());
  expect(node.textContent).toContain("First goal");expect(posts).toHaveLength(3);
});

it("preserves separate drafts while switching conversations and supports keyboard history search",async()=>{
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  const c={id:"first",caseId:"case",title:"Saved first",createdAt:"2026-09-08"};
  const node=document.createElement("div");document.body.append(node);const root=createRoot(node);dispose=()=>root.unmount();
  await act(async()=>root.render(React.createElement(HostWorkbench,{bridge:{protocolVersion:1,request:async({path})=>({status:200,body:path.endsWith("conversations")?{conversations:[c]}:path.includes("messages?")?{conversationId:c.id,messages:[],hasMore:false,nextAfter:0}:path.endsWith("execution")?{runs:[],truncated:false}:c})}})));
  const edit=async(text:string)=>act(async()=>{const field=node.querySelector("textarea")!;field.value=text;Simulate.change(field);});
  await edit("Unsent new");
  await act(async()=>window.dispatchEvent(new KeyboardEvent("keydown",{key:"k",metaKey:true})));
  expect(node.querySelector('[type="search"]')).not.toBeNull();
  await act(async()=>[...node.querySelectorAll("button")].find(b=>b.textContent?.startsWith("Saved first"))!.click());
  expect(node.querySelector("textarea")!.value).toBe("");await edit("Unsent first");
  await act(async()=>node.querySelector<HTMLButtonElement>('[aria-label="新建对话"]')!.click());
  expect(node.querySelector("textarea")!.value).toBe("Unsent new");
  expect(localStorage.getItem("traceforge.desktop.session-drafts.v1")).toContain("Unsent first");
});
