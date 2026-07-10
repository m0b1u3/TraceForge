// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { AgentRun } from "@traceforge/shared";
import { TopBar, formatTopBarTokenTotal, getTopBarRunStatus } from "./TopBar.js";
import { useStore } from "../store.js";

// @ts-expect-error enable React act in jsdom tests
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const initialState = useStore.getState();

const activeRun: AgentRun = {
  id: "run_1",
  caseId: "case_1",
  goal: "Inspect the target",
  status: "running",
  createdAt: "now",
  startedAt: "now",
  finishedAt: null,
  interruptReason: null,
  completionReason: null,
  error: null,
  promptTokens: 1_200,
  completionTokens: 34,
  totalTokens: 1_234,
};

function renderTopBar(): string {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(TopBar));
  });
  const html = container.innerHTML;
  act(() => {
    root.unmount();
  });
  container.remove();
  return html;
}

describe("TopBar", () => {
  beforeEach(() => {
    useStore.setState({
      caseId: "case_1",
      browserController: "llm",
      browserUrl: "https://example.test",
      activeRun,
      agentBusy: true,
      tokenUsage: { promptTokens: 1_200, completionTokens: 34, totalTokens: 1_234 },
    });
  });

  afterEach(() => {
    useStore.setState(initialState, true);
    document.body.innerHTML = "";
  });

  it("renders the brand name", () => {
    const html = renderTopBar();
    expect(html).toContain("TraceForge");
    expect(html).toContain("red-team workbench");
  });

  it("renders the control pill when caseId is present", () => {
    const html = renderTopBar();
    expect(html).toContain("llm");
    expect(html).toContain("https://example.test");
  });

  it("renders persisted active Run status and cumulative Token usage from the store", () => {
    const html = renderTopBar();

    expect(html).toContain("Run running");
    expect(html).toContain("Tokens 1,234");
  });

  it("formats persisted run status and token totals", () => {
    expect(getTopBarRunStatus({ status: "running" }, false)).toBe("running");
    expect(getTopBarRunStatus(null, true)).toBe("running");
    expect(formatTopBarTokenTotal(1234)).toBe("Tokens 1,234");
  });
});
