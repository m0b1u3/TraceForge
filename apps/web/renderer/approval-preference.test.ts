// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { ApprovalPreference } from "./approval-preference";
import type { DesktopConversations } from "./desktop-conversation-transport";

it("switches repeatedly without a task or authorization form and reloads after a lost response", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  let value = { revision: 0, routineApprovalRequired: true }, lose = false, posts = 0;
  const bridge: DesktopConversations = { protocolVersion: 1, async request(input) {
    if (input.method === "POST") {
      posts++; const update = JSON.parse(input.body!);
      expect(update.expectedRevision).toBe(value.revision);
      value = { revision: value.revision + 1, routineApprovalRequired: update.routineApprovalRequired };
      if (lose) throw new Error("lost reply");
    }
    return { status: 200, body: value };
  } };
  const node = document.createElement("div"); document.body.append(node); const root = createRoot(node);
  const toggle = () => node.querySelector<HTMLButtonElement>('[role="switch"]')!;
  try {
    await act(async () => root.render(React.createElement(ApprovalPreference, { bridge })));
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    await act(async () => toggle().click()); expect(toggle().getAttribute("aria-checked")).toBe("false");
    await act(async () => toggle().click()); expect(toggle().getAttribute("aria-checked")).toBe("true");
    lose = true; await act(async () => toggle().click());
    expect(toggle().disabled).toBe(true); expect(node.querySelector('[role="alert"]')).not.toBeNull();
    await act(async () => [...node.querySelectorAll("button")].find(b => b.textContent === "重新读取")!.click());
    expect(toggle().getAttribute("aria-checked")).toBe("false"); expect(posts).toBe(3);
  } finally { act(() => root.unmount()); node.remove(); }
});
