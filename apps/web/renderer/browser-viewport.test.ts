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
  expect(document.body.textContent).toContain("https://fixture.invalid/page"); expect(request).not.toHaveBeenCalled();
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
