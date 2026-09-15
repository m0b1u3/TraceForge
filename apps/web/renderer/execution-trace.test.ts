// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { ExecutionTrace, mergeTrace } from "./execution-trace";
import type { ScenarioAgentEvent } from "@traceforge/shared/scenario-agent-events";

const event = (sequence: number, item: object, turnId = "turn") => ({ protocolVersion: 2, id: `event-${sequence}`, sequence, caseId: "case", runId: "run", workId: "work", role: "worker", turnId, createdAt: "2026-09-15T00:00:00.000Z", method: "item/updated", params: { item: { type: "toolCall", id: "tool", tool: "workspace_execute", status: "inProgress", risk: "privileged", summary: null, refs: [], ...item } } }) as ScenarioAgentEvent;
it("merges live snapshots without losing command and keeps turns separate", () => {
  const rows = mergeTrace([], [event(1, { commandPreview: "command", dispatchState: "requested" }), event(2, { outputPreview: "first", dispatchState: "dispatched" }), event(3, { status: "completed", outputPreview: "final" }), event(4, {}, "other-turn")]);
  expect(rows).toHaveLength(2);
  expect((rows[0]!.params as any).item).toMatchObject({ commandPreview: "command", outputPreview: "final", status: "completed" });
});
it("updates the same expanded process in place and renders output as inert text", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const node = document.createElement("div"); document.body.append(node); const root = createRoot(node);
  try {
    await act(async () => root.render(React.createElement(ExecutionTrace, { events: [event(1, { outputPreview: "first" })] })));
    const details = node.querySelector("details"); expect(details?.open).toBe(true);
    await act(async () => root.render(React.createElement(ExecutionTrace, { events: [event(2, { outputPreview: 'first\n<script>not executable</script>' })] })));
    expect(node.querySelector("details")).toBe(details);
    expect(node.querySelector("script")).toBeNull(); expect(node.textContent).toContain("not executable");
    expect(node.textContent).toContain("输出持续更新");
  } finally { act(() => root.unmount()); node.remove(); }
});
