// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { HostWorkbench } from "./host-workbench";

let dispose: (() => void) | undefined;
afterEach(() => { act(() => dispose?.()); document.body.replaceChildren(); localStorage.clear(); });

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
  expect(node.textContent).toContain("已保存会话");
  expect(node.textContent).not.toContain("观察 01");
  expect(node.textContent).not.toContain("查看并确认");
  const select = [...node.querySelectorAll("button")].find(button => button.textContent?.startsWith("已保存会话"))!;
  await act(async () => { select.click(); });
  expect(node.textContent).toContain("记录你的调查意图");
  expect(node.querySelector("textarea")?.disabled).toBe(false);
  expect(calls).toContain("/api/desktop/conversations/conversation-1/messages?after=0&limit=100");
});
