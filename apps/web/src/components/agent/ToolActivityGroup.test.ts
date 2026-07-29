// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ToolActivityGroup, toolActivityTone } from "./ToolActivityGroup.js";
import type { AgentConversationItem, AgentToolActivity } from "./agent-conversation.js";
import type { AgentEventRefs } from "@traceforge/shared";

// @ts-expect-error enable React act in jsdom tests
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function renderGroup(item: Extract<AgentConversationItem, { type: "tool_group" }>) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(createElement(ToolActivityGroup, { item })));
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

describe("recovered tool execution", () => {
  it("collapses a recovered failure while retaining its audit detail", async () => {
    const recovered = {
      ...activity("exec_command → exit=1"),
      outcome: "recovered" as const,
      recoveredByKey: "activity-2",
    };
    const succeeded = {
      ...activity("exec_command → exit=0"),
      key: "activity-2",
    };
    const row = await renderGroup({
      type: "tool_group",
      key: "group-recovered",
      tool: "exec_command",
      activities: [recovered, succeeded],
    });

    expect(row.textContent).toContain("Recovered execution");
    expect(row.textContent).not.toContain("Arguments");
    expect(row.querySelector('button[aria-label="Expand exec_command activity"]')).not.toBeNull();
  });
});

function activity(resultText: string, refs: AgentEventRefs | null = null): AgentToolActivity {
  return {
    key: "activity-1",
    tool: "http_replay",
    call: { type: "event", key: "event-1", kind: "tool_call", label: "Tool call", text: "http_replay({})", summary: "http_replay({})" },
    result: { type: "event", key: "event-2", kind: "tool_result", label: "Tool result", text: resultText, summary: resultText, refs },
    outcome: "succeeded",
  };
}

describe("ToolActivityGroup", () => {
  it("keeps ordinary successful executions collapsed into one audit row", async () => {
    const row = await renderGroup({ type: "tool_group", key: "group-1", tool: "http_replay", activities: [activity("http_replay → completed")] });

    expect(row.textContent).toContain("http_replay");
    expect(row.textContent).toContain("Completed");
    expect(row.textContent).not.toContain("Arguments");
    expect(row.querySelector('button[aria-label="Expand http_replay activity"]')).not.toBeNull();
  });

  it("auto-expands tool activity that produced traceable evidence", async () => {
    const refs = { factIds: ["fact_1"], taskIds: [], timelineEntryIds: [] };
    const row = await renderGroup({ type: "tool_group", key: "group-2", tool: "record_fact", activities: [activity("record_fact → stored", refs)] });

    expect(row.textContent).toContain("Produced evidence");
    expect(row.textContent).toContain("Arguments");
    expect(row.textContent).toContain("Result");
  });

  it("does not treat an HTTP status by itself as proof or a tool failure", () => {
    expect(toolActivityTone(activity("http_replay → status=500 bodyLength=0"))).toBe("complete");
    expect(toolActivityTone(activity('http_replay → status=404 body preview: {"error":"Not Found"}'))).toBe("complete");
    expect(toolActivityTone(activity("http_replay → failed: connection timeout"))).toBe("issue");
  });
});
