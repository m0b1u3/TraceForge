// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AgentRun } from "@traceforge/shared";
import { TopBar, formatTopBarTokenTotal, getTopBarRunStatus } from "./TopBar.js";
import { useStore } from "../store.js";

// @ts-expect-error enable React act in jsdom tests
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const initialState = useStore.getState();
let root: Root | null = null;
let container: HTMLDivElement | null = null;

const activeRun: AgentRun = {
  id: "run_1",
  caseId: "case_1",
  goal: "Inspect the target",
  status: "completed",
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

async function renderTopBar(): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  const mountedRoot = createRoot(container);
  root = mountedRoot;
  await act(async () => {
    mountedRoot.render(createElement(TopBar));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return container;
}

describe("TopBar", () => {
  beforeEach(() => {
    useStore.setState({
      caseId: "case_1",
      browserController: "llm",
      browserUrl: "https://example.test",
      activeRun,
      agentBusy: true,
      tokenUsage: { promptTokens: 9_000, completionTokens: 876, totalTokens: 9_876 },
    });
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container = null;
    useStore.setState(initialState, true);
    document.body.innerHTML = "";
  });

  it("renders the brand name", async () => {
    const topBar = await renderTopBar();
    expect(topBar.innerHTML).toContain("TraceForge");
    expect(topBar.innerHTML).toContain("red-team workbench");
  });

  it("renders the control pill when caseId is present", async () => {
    const topBar = await renderTopBar();
    expect(topBar.innerHTML).toContain("llm");
    expect(topBar.innerHTML).toContain("https://example.test");
  });

  it("renders persisted active Run status and cumulative Token usage from the store", async () => {
    const topBar = await renderTopBar();

    expect(topBar.innerHTML).toContain("Run completed");
    expect(topBar.innerHTML).toContain("Tokens 9,876");

    act(() => {
      useStore.setState({
        activeRun: null,
        agentBusy: false,
        tokenUsage: { promptTokens: 4_000, completionTokens: 321, totalTokens: 4_321 },
      });
    });

    expect(topBar.innerHTML).toContain("Run idle");
    expect(topBar.innerHTML).toContain("Tokens 4,321");
  });

  it("formats persisted run status and token totals", () => {
    expect(getTopBarRunStatus({ status: "running" }, false)).toBe("running");
    expect(getTopBarRunStatus(null, true)).toBe("running");
    expect(formatTopBarTokenTotal(1234)).toBe("Tokens 1,234");
  });
});
