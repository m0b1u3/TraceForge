// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { RunInteraction } from "./run-interaction";
import type { ConversationRun } from "./conversation-execution";
const run: ConversationRun = { runId: "run", messageCommandId: "message", revision: 3, status: "running", goal: "Review", outputs: [],
  workItems: [{ id: "work", title: "Review observations", status: "waiting_approval", pendingApproval: {
    id: "approval", workId: "work", actionKey: "action", toolName: "neutral.tool", risk: "privileged", rationale: "<b>Review required</b>", inputRef: "ref", status: "pending" } }] };
let dispose: (() => void) | undefined;
afterEach(() => { act(() => dispose?.()); document.body.replaceChildren(); localStorage.clear(); });
async function mount(request = vi.fn(async (input: { path: string; method: "GET" | "POST"; body?: string }) => {
  if (input.path.endsWith("/approval-input")) return { status: 200, body: { runId: "run", workId: "work", approvalId: "approval", inputRef: "ref", input: '{"resource":"neutral"}' } };
  throw new Error("offline");
})) {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const node = document.createElement("div"); document.body.append(node); const root = createRoot(node); dispose = () => root.unmount();
  const render = async (value: ConversationRun) => { await act(async () => root.render(React.createElement(RunInteraction, { bridge: { protocolVersion: 1, request }, conversationId: "first", run: value }))); };
  await render(run); request.mockClear(); return { node:document.body, request, render };
}
async function fill(node: HTMLTextAreaElement, value: string) { await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(node, value); node.dispatchEvent(new Event("input", { bubbles: true })); }); }
const button = (node: Element, text: string) => Array.from(node.querySelectorAll("button")).find(item => item.textContent === text)!;
it("requires current-checkpoint confirmation to continue and preserves the same request after disconnection", async () => {
  const {node,request,render}=await mount();
  const stopped:ConversationRun={...run,workItems:[{id:"work",title:"Saved work",status:"failed",error:"<b>model unavailable</b>",continuation:{state:"review",checkpointRef:`checkpoint://sha256-${"a".repeat(64)}.json`}}]};
  await render(stopped);expect(request).not.toHaveBeenCalled();expect(node.querySelector("b")).toBeNull();
  await act(async()=>button(node,"检查并继续这项工作").click());expect(button(node,"确认继续")).toBeTruthy();
  await render({...stopped,revision:4});expect(button(node,"确认继续")).toBeUndefined();
  await act(async()=>button(node,"检查并继续这项工作").click());
  await act(async()=>button(node,"确认继续").click());
  expect(JSON.parse(request.mock.calls[0][0].body!)).toMatchObject({confirmed:true,workId:"work",expectedRevision:4,checkpointRef:stopped.workItems[0].continuation!.checkpointRef});
  await act(async()=>button(node,"核对待处理请求").click());expect(request.mock.calls[1]).toEqual(request.mock.calls[0]);
});
it("loads exact input automatically and asks only for a single explicit decision", async () => {
  const { node, request, render } = await mount();
  expect(request).not.toHaveBeenCalled(); expect(node.querySelector("b")).toBeNull();
  const dialog=node.querySelector('[role="dialog"]')!;
  expect(dialog.querySelectorAll("textarea,input")).toHaveLength(0);
  expect(dialog.textContent).toContain('"resource":"neutral"');
  expect(button(node,"允许").disabled).toBe(false);
  await render({...run,revision:4});
  await act(async()=>button(node,"允许").click());
  expect(JSON.parse(request.mock.calls[0][0].body!)).toMatchObject({approved:true,reviewedInputRef:"ref",expectedRevision:4});
});
it("permits explicit rejection without approval consent and keeps unknown result for reconciliation", async () => {
  const { node, request } = await mount();
  await act(async () => button(node, "拒绝").click());
  expect(JSON.parse(request.mock.calls[0]![0].body!)).toMatchObject({ approved: false, runId: "run", workId: "work", approvalId: "approval" });
  expect(node.textContent).toContain("核对待处理请求"); expect(document.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => button(node, "核对待处理请求").click()); expect(request.mock.calls[1]).toEqual(request.mock.calls[0]);
});
it("sends selected-work context without approval fields and preserves text on failure", async () => {
  const { node, request } = await mount();
  await act(async () => { const select = node.querySelector("select")!; select.value = "work"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  const input = node.querySelector("textarea")!; await fill(input, "Additional unverified observation");
  await act(async () => button(node, "提交补充信息").click());
  expect(JSON.parse(request.mock.calls[0]![0].body!)).toMatchObject({ workId: "work", instruction: input.value });
  expect(request.mock.calls[0]![0].path).toMatch(/\/input$/); expect(input.value).toContain("unverified");
});
it("keeps approval disabled when exact input cannot be verified", async () => {
  const { node } = await mount(vi.fn(async()=>{throw new Error("missing");}));
  expect(node.textContent).toContain("暂不能批准"); expect(button(node, "允许").disabled).toBe(true);
  expect(button(node, "拒绝").disabled).toBe(false);
});
it.each([false, true])("clears the matching whitespace-padded draft after success (recovery=%s)", async (lose) => {
  const { node, request } = await mount(); let first = true;
  request.mockImplementation(async input => {
    if (lose && first) { first = false; throw new Error("lost"); }
    const body = JSON.parse(input.body!);
    return { status: 200, body: { desktopReceipt: { version: 1, conversationId: "first", commandId: body.commandId, operation: "input", resourceId: body.commandId } } } as any;
  });
  await act(async () => { const select = node.querySelector("select")!; select.value = "work"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  const input = node.querySelector("textarea")!; await fill(input, "  Additional observation  ");
  await act(async () => button(node, "提交补充信息").click());
  if (lose) { expect(input.value).toContain("observation"); await act(async () => button(node, "核对待处理请求").click()); }
  expect(input.value).toBe(""); expect(node.textContent).toContain("补充信息已保存");
});
