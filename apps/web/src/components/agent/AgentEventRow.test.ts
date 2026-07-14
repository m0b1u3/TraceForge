// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentEventRow } from "./AgentEventRow.js";
import type { AgentConversationEventItem } from "./agent-conversation.js";

// @ts-expect-error enable React act in jsdom tests
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function renderRow(item: AgentConversationEventItem): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(AgentEventRow, { item }));
  });
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

describe("AgentEventRow", () => {
  it("reveals the complete tool output without discarding the collapsed summary", async () => {
    const fullText = `browser_observe → ${"captured page content ".repeat(20)}`;
    const row = await renderRow({
      type: "event",
      key: "event-1",
      kind: "tool_result",
      label: "Tool result",
      text: fullText,
      summary: "browser_observe → captured page content...",
    });

    expect(row.textContent).toContain("captured page content...");
    expect(row.textContent).not.toContain(fullText);

    const expand = row.querySelector<HTMLButtonElement>('button[aria-label="Expand event"]');
    act(() => expand?.click());

    expect(row.textContent).toContain(fullText);
    expect(row.querySelector('button[aria-label="Collapse event"]')).not.toBeNull();
  });
});
