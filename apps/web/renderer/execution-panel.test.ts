// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { ExecutionPanel } from "./execution-panel";
import type { SavedMessage } from "./conversation-client";

let dispose: (() => void) | undefined;
it("one explicit review authorizes then dispatches the pinned message without widening scope",async()=>{
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  const writes:Array<{path:string;body:any}>=[];
  const catalog={modelReady:true,definitions:[{kind:"review",version:1,authorizationForm:{version:1,description:"Review resources",fields:[{path:["resources"],label:"Resources",description:"Literal resources",type:"string-list",required:true,maximumItems:8,maximumLength:100}]},authorizationReview:{allowedActions:["resource.read"],deniedActions:[],resources:[]}}],scopes:[],runs:[],truncated:false};
  const bridge={protocolVersion:1 as const,request:async(input:any)=>{
    if(input.method==="GET")return {status:200,body:catalog};
    const body=JSON.parse(input.body);writes.push({path:input.path,body});
    const operation=input.path.endsWith("/authorize")?"authorize":"dispatch";
    return {status:200,body:{runId:"run",desktopReceipt:{version:1,conversationId:"first",commandId:body.commandId,operation,resourceId:operation==="authorize"?body.commandId:"run"}}};
  }};
  const node=document.createElement("div");document.body.append(node);const root=createRoot(node);dispose=()=>root.unmount();
  await act(async()=>root.render(React.createElement(ExecutionPanel,{bridge,conversationId:"first",messages:[{commandId:"original",text:"Original intent"} as SavedMessage],intent:{scenarioKind:"review",definitionVersion:1},inline:true})));
  await act(async()=>{const field=node.querySelector("textarea")!;field.value="allowed-resource";Simulate.change(field);});
  const button=(text:string)=>[...node.querySelectorAll("button")].find(b=>b.textContent===text)!;
  await act(async()=>button("核对授权").click());expect(writes).toHaveLength(0);
  expect(node.textContent).toContain("确认后执行本条任务");expect(node.textContent).not.toContain("不会自动启动");
  await act(async()=>node.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await act(async()=>button("授权并执行本条任务").click());
  expect(writes).toHaveLength(2);expect(writes[0].body.scope).toEqual({resources:["allowed-resource"]});
  expect(writes[1].body).toMatchObject({messageCommandId:"original",scopeRef:writes[0].body.commandId,scenarioKind:"review",definitionVersion:1});
});
afterEach(() => { act(() => dispose?.()); vi.useRealTimers(); document.body.replaceChildren(); localStorage.clear(); });
async function render(evidenceOnly = false) {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const writes: string[] = [];
  let scopePayload: Record<string, unknown> = {};
  const bridge = { protocolVersion: 1 as const, request: async (input: { method: string; body?: string }) => {
    if (input.method === "POST") { writes.push(input.body!); return { status: 500, body: {} }; }
    return { status: 200, body: { modelReady: true, definitions: [{kind: "review", version: 1}],
      scopes: [{id: "scope", scenarioKind: "review", status: "active", expiresAt: "2099-01-01T00:00:00Z", scope: scopePayload}], runs: [], truncated: false } };
  } };
  const node = document.createElement("div"); document.body.append(node); const root = createRoot(node); dispose = () => root.unmount();
  await act(async () => root.render(React.createElement(ExecutionPanel, { bridge, conversationId: "first", evidenceOnly,
    messages: [{commandId: "message", text: "Review authorized resources"} as SavedMessage] })));
  return { node, writes, root, bridge, changeScope: (value: Record<string, unknown>) => { scopePayload = value; } };
}
it("requires scope and explicit confirmation before dispatch", async () => {
  const { node, writes } = await render();
  expect([...node.querySelectorAll("button")].find(button => button.textContent === "启动调查")?.disabled).toBe(true);
  expect(writes).toEqual([]);
});
it("requires new confirmation when the saved investigation intent changes", async () => {
  const { node, root, bridge, writes } = await render();
  const scope = node.querySelector("select")!;
  await act(async () => { scope.value = "scope"; scope.dispatchEvent(new Event("change", { bubbles: true })); });
  const checkbox = node.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  await act(async () => { checkbox.click(); });
  expect(checkbox.checked).toBe(true);
  await act(async () => { root.render(React.createElement(ExecutionPanel, { bridge, conversationId: "first",
    messages: [{ commandId: "second", text: "Different intent" } as SavedMessage] })); });
  expect(checkbox.checked).toBe(false);
  expect([...node.querySelectorAll("button")].find(button => button.textContent === "启动调查")?.disabled).toBe(true);
  expect(writes).toEqual([]);
});
it("does not reuse confirmation when polling changes the selected authorization", async () => {
  vi.useFakeTimers(); const { node, writes, changeScope } = await render();
  const scope = node.querySelector("select")!;
  await act(async () => { scope.value = "scope"; scope.dispatchEvent(new Event("change", { bubbles: true })); });
  const checkbox = node.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  await act(async () => checkbox.click()); expect(checkbox.checked).toBe(true);
  changeScope({ allowedResources: ["second"] });
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(checkbox.checked).toBe(false);
  expect([...node.querySelectorAll("button")].find(button => button.textContent === "启动调查")?.disabled).toBe(true);
  expect(writes).toEqual([]);
});
it("reconciles the original command after response loss", async () => {
  const operation = { path: "/api/desktop/conversations/first/execution", body: { commandId: "original", messageCommandId: "message", scopeRef: "scope", scenarioKind: "review", definitionVersion: 1 } };
  localStorage.setItem("traceforge.execution.first", JSON.stringify(operation));
  const { node, writes } = await render();
  await act(async () => [...node.querySelectorAll("button")].find(button => button.textContent === "核对原请求")!.click());
  expect(writes).toEqual([JSON.stringify(operation.body)]);
  expect(JSON.parse(localStorage.getItem("traceforge.execution.first")!)).toEqual(operation);
  expect(node.textContent).toContain("结果未知");
});
it("keeps evidence view free of launch and authorization controls", async () => {
  localStorage.setItem("traceforge.execution.first", JSON.stringify({ path: "/api/desktop/conversations/first/execution", body: {commandId: "original"} }));
  const { node } = await render(true);
  expect(node.textContent).toContain("任务输出与引用");
  expect(node.querySelector("select")).toBeNull();
  expect([...node.querySelectorAll("button")].some(button => button.textContent === "启动调查")).toBe(false);
  expect(node.querySelector("button")).toBeNull();
});
