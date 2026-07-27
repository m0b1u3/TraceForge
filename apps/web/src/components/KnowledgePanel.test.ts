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

const fact = {
  id: "fact_1",
  caseId: "case_1",
  type: "finding",
  title: "SQL injection in /article",
  value: { endpoint: "/article" },
  source: { type: "ai", ref: "run_1" },
  confidence: 0.9,
  tags: [],
  createdAt: "now",
  updateCount: 0,
  updatedAt: "",
  validity: "valid" as const,
  findingStatus: "verified" as const,
};

describe("KnowledgePanel", () => {
  it("shows the case overview with the latest findings when nothing is selected", () => {
    useStore.setState({
      facts: [fact],
      tasks: [],
      selectedTrafficId: null,
      selectedFactId: null,
      selectedTaskId: null,
      selectedTimelineNodeId: null,
      selectedAgentEvent: null,
    });
    const panel = renderPanel();

    expect(panel.textContent).toContain("Overview");
    expect(panel.textContent).toContain("Latest evidence");
    expect(panel.textContent).toContain("SQL injection in /article");
  });

  it("switches from the overview to the finding inspector on selection", async () => {
    useStore.setState({
      facts: [fact],
      tasks: [],
      selectedTrafficId: null,
      selectedFactId: null,
      selectedTaskId: null,
      selectedTimelineNodeId: null,
      selectedAgentEvent: null,
    });
    const panel = renderPanel();
    expect(panel.textContent).toContain("Overview");

    await act(async () => {
      useStore.getState().selectFact("fact_1");
      await Promise.resolve();
    });

    expect(panel.textContent).not.toContain("Latest evidence");
    expect(panel.textContent).toContain("Verified evidence");
    expect(panel.textContent).toContain("SQL injection in /article");
  });
});
