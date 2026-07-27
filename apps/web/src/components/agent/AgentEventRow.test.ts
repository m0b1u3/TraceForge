// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentEventRow, validationEventState } from "./AgentEventRow.js";
import type { ValidationWorkflowSnapshot } from "@traceforge/shared";
import type { AgentConversationEventItem } from "./agent-conversation.js";
import { useStore } from "../../store.js";

// @ts-expect-error enable React act in jsdom tests
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const initialState = useStore.getState();

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
  useStore.setState(initialState, true);
});

describe("AgentEventRow", () => {
  it("derives current validation state from the live workflow instead of freezing log-time state", () => {
    const task = { id: "task_1", caseId: "case_1", title: "Reproduce independently", status: "running", reason: "", blockedBy: [], triggerWhen: [], relatedFacts: [], priority: "high", createdAt: "now", updatedAt: "now", updateCount: 0 } as const;
    const workflow: ValidationWorkflowSnapshot = {
      caseId: "case_1", runId: "run_1", revision: 2, generatedAt: "now", runningLease: "task_1", leader: { taskId: "task_1", score: 88 },
      exploration: { consecutiveValidationShifts: 0, explorationBoundariesRemaining: 0 },
      items: [{ findingId: "finding_1", findingTitle: "IDOR", findingStatus: "validating", consensusStatus: "insufficient", confidence: .7, taskId: "task_1", taskStatus: "running", priorityScore: 88, priorityReasons: [], completionReady: false, missingEvidence: ["independent replay"], feedback: null }], auditIssues: [],
    };
    expect(validationEventState("validation_task_claimed", { kind: "task", id: "task_1" }, workflow, task, null).label).toBe("Active");
    expect(validationEventState("validation_task_completion_blocked", { kind: "task", id: "task_1" }, workflow, task, null).label).toBe("Blocked");
    expect(validationEventState("validation_priority_shifted", { kind: "task", id: "task_1" }, { ...workflow, leader: null }, task, null).label).toBe("Superseded");
  });

  it("navigates a validation event to its related task", async () => {
    useStore.setState({ tasks: [{ id: "task_1", caseId: "case_1", title: "Reproduce independently", status: "open", reason: "", blockedBy: [], triggerWhen: [], relatedFacts: [], priority: "high", createdAt: "now", updatedAt: "now", updateCount: 0 }] });
    const row = await renderRow({
      type: "event",
      key: "event-validation",
      kind: "validation",
      label: "Evidence gate",
      text: "Blocked task_1 · missing independent evidence",
      summary: "Blocked task_1 · missing independent evidence",
      target: { kind: "task", id: "task_1" },
      eventType: "validation_task_completion_blocked",
      createdAt: "2026-07-21T08:15:30.000Z",
    });

    act(() => row.querySelector<HTMLButtonElement>('button[aria-label="Locate related knowledge"]')?.click());

    expect(useStore.getState().selectedTaskId).toBe("task_1");
    expect(useStore.getState().inspectorMode).toBe("task");
    expect(useStore.getState().knowledgeTarget).toEqual(expect.objectContaining({ kind: "task", id: "task_1" }));
    expect(row.textContent).toContain("Reproduce independently");
    expect(row.querySelector("time")?.getAttribute("datetime")).toBe("2026-07-21T08:15:30.000Z");
  });

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

  it("renders produced-knowledge chips on tool results and selects the entity on click", async () => {
    useStore.setState({
      facts: [{ id: "fact_1", caseId: "case_1", type: "vulnerability_hint", title: "Heapdump endpoint exposed", value: {}, source: { type: "agent", ref: "run_1" }, confidence: .95, tags: [], validity: "valid", findingStatus: null, createdAt: "now", updatedAt: "now", updateCount: 0 }],
    });
    const row = await renderRow({
      type: "event",
      key: "event-refs",
      kind: "tool_result",
      label: "Tool result",
      text: "record_fact → recorded",
      summary: "record_fact → recorded",
      refs: { factIds: ["fact_1"], taskIds: ["task_9"], timelineEntryIds: ["tl_1"] },
    });

    const factChip = row.querySelector<HTMLButtonElement>('button[data-ref-kind="fact"]');
    expect(factChip?.textContent).toContain("Heapdump endpoint exposed");
    expect(row.querySelector('button[data-ref-kind="task"]')?.textContent).toContain("task_9");

    act(() => factChip?.click());

    expect(useStore.getState().selectedFactId).toBe("fact_1");
    expect(useStore.getState().inspectorMode).toBe("finding");
  });

  it("renders no chips when a tool result has no refs", async () => {
    const row = await renderRow({
      type: "event",
      key: "event-no-refs",
      kind: "tool_result",
      label: "Tool result",
      text: "get_traffic → []",
      summary: "get_traffic → []",
    });
    expect(row.querySelector(".agent-event-refs")).toBeNull();
  });
});
