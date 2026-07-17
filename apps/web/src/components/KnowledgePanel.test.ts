// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { KnowledgePanel } from "./KnowledgePanel.js";
import { useStore } from "../store.js";

// @ts-expect-error enable React act in jsdom tests
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const initialState = useStore.getState();
let root: Root | null = null;
let container: HTMLDivElement | null = null;

function renderPanel() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(createElement(KnowledgePanel)));
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container = null;
  useStore.setState(initialState, true);
  document.body.innerHTML = "";
});

describe("KnowledgePanel", () => {
  it("mounts only the active tab content", async () => {
    useStore.setState({
      activeTab: "facts",
      facts: [],
      tasks: [{
        id: "task_1",
        caseId: "case_1",
        title: "Verify authorization boundary",
        status: "open",
        reason: "",
        blockedBy: [],
        triggerWhen: [],
        relatedFacts: [],
        priority: "high",
        createdAt: "now",
        updatedAt: "now",
        updateCount: 0,
      }],
      timeline: [],
      warnings: [],
      selectedTrafficId: null,
      selectedFactId: null,
      selectedAgentEvent: null,
    });
    const panel = renderPanel();

    expect(panel.textContent).toContain("Awaiting verified evidence");
    expect(panel.textContent).not.toContain("Verify authorization boundary");

    await act(async () => {
      useStore.getState().setActiveTab("tasks");
      await Promise.resolve();
    });

    expect(panel.textContent).toContain("Verify authorization boundary");
    expect(panel.textContent).not.toContain("Awaiting verified evidence");
  });
});
