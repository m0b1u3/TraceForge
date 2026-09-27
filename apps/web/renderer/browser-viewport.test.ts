// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { BrowserViewport } from "./browser-viewport";
let dispose: (() => void) | undefined;
afterEach(() => { act(() => dispose?.()); document.body.replaceChildren(); });
it("presents an owned native page without screenshot polling, and hands back once", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const request = vi.fn(), presentBrowser = vi.fn(async () => ({ url: "https://fixture.invalid/page" }));
  const send = vi.fn(async () => true), onHide = vi.fn();
  const opener = document.createElement("button"); document.body.append(opener); opener.focus();
  const element = document.createElement("div"); document.body.append(element);
  const root = createRoot(element); dispose = () => root.unmount();
  await act(async () => root.render(React.createElement(BrowserViewport, { bridge: { protocolVersion: 1, request, presentBrowser }, path: "/fixture", sessionId: "session", takeoverId: "manual", send, onHide })));
  expect(document.querySelector("img,iframe,webview")).toBeNull();
  expect(document.querySelector<HTMLInputElement>('[aria-label="网页地址"]')?.value).toBe("https://fixture.invalid/page"); expect(request).not.toHaveBeenCalled();
  expect(document.querySelector('[role="status"]')).toBeNull();
  await act(async () => [...document.querySelectorAll("button")].find(b => b.textContent === "进入网页")!.click());
  expect(presentBrowser).toHaveBeenCalledWith(expect.objectContaining({ focus: true }));
  expect(presentBrowser).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session", takeoverId: "manual" }));
  await act(async () => [...document.querySelectorAll("button")].find(b => b.textContent === "交回智能体")!.click());
  expect(send).toHaveBeenCalledOnce(); expect(send.mock.calls[0]).toEqual([expect.objectContaining({ operation: "resume" })]);
  expect(onHide).not.toHaveBeenCalled();
  act(() => root.unmount()); dispose = undefined;
  expect(document.activeElement).toBe(opener);
});
it("reports missing native support rather than silently falling back to screenshot clicks", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const send = vi.fn(async () => true), request = vi.fn();
  const element = document.createElement("div"); document.body.append(element);
  const root = createRoot(element); dispose = () => root.unmount();
  await act(async () => root.render(React.createElement(BrowserViewport, { bridge: { protocolVersion: 1, request }, path: "/fixture", sessionId: "session", takeoverId: "manual", send })));
  expect(document.body.textContent).toContain("仅在桌面客户端可用"); expect(send).not.toHaveBeenCalled();
});
it("navigates the owned native session from the address bar and native history controls", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const presentBrowser = vi.fn(async (_input: unknown) => ({ url: "https://example.com/", title: "Example Domain", canGoBack: true, canGoForward: true }));
  const node = document.createElement("div"); document.body.append(node);
  const root = createRoot(node); dispose = () => root.unmount();
  await act(async () => root.render(React.createElement(BrowserViewport, { bridge: { protocolVersion: 1, request: vi.fn(), presentBrowser }, path: "/fixture", sessionId: "session", takeoverId: "manual", send: vi.fn() })));
  expect(document.querySelector("strong")?.textContent).toBe("Example Domain");
  const input = document.querySelector<HTMLInputElement>('[aria-label="网页地址"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "example.com/next");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(presentBrowser).toHaveBeenCalledWith(expect.objectContaining({ takeoverId: "manual", navigation: { action: "navigate", url: "https://example.com/next" } }));
  for (const [label, action] of [["后退", "back"], ["前进", "forward"], ["刷新", "reload"]]) {
    await act(async () => document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click());
    expect(presentBrowser).toHaveBeenCalledWith(expect.objectContaining({ navigation: { action } }));
  }
});
it("switches, creates and closes tabs in the same owned browser session", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const presentBrowser = vi.fn(async (_input: unknown) => ({activePageId:"first",tabs:[
    {id:"first",title:"First page",url:"https://example.com/"},
    {id:"second",title:"Second page",url:"https://example.com/next"},
  ]}));
  const node = document.createElement("div"); document.body.append(node);
  const root = createRoot(node); dispose = () => root.unmount();
  await act(async () => root.render(React.createElement(BrowserViewport, {bridge:{protocolVersion:1,request:vi.fn(),presentBrowser},
    path:"/fixture",sessionId:"session",takeoverId:"manual",send:vi.fn()})));
  expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("First page");
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')][1]!.click());
  expect(presentBrowser).toHaveBeenLastCalledWith(expect.objectContaining({sessionId:"session",navigation:{action:"select-tab",pageId:"second"}}));
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="新建标签页"]')!.click());
  expect(presentBrowser).toHaveBeenLastCalledWith(expect.objectContaining({navigation:{action:"new-tab"}}));
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="关闭标签：Second page"]')!.click());
  expect(presentBrowser).toHaveBeenLastCalledWith(expect.objectContaining({navigation:{action:"close-tab",pageId:"second"}}));
});
