// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Fact } from "@traceforge/shared";
import { afterEach, describe, expect, it } from "vitest";
import { useStore } from "../../store.js";
import { FindingInspector, ToolEventInspector } from "./EvidenceInspector.js";

// @ts-expect-error enable React act in jsdom tests
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const initialState = useStore.getState();
let root: Root | null = null;
let container: HTMLDivElement | null = null;

const fact: Fact = {
  id: "fact_1",
  caseId: "case_1",
  type: "credential",
  title: "Recovered account",
  value: { username: "admin", password: "correct-horse", nested: { accessToken: "token-value" } },
  source: { type: "traffic", ref: "traffic_1" },
  confidence: 0.95,
  tags: [],
  createdAt: "2026-07-16T00:00:00.000Z",
  updateCount: 0,
  updatedAt: "",
  validity: "valid",
};

async function renderInspector(props: { targetRequestId?: number; onTargetHandled?: (requestId: number) => void } = {}): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(createElement(FindingInspector, { fact, ...props })));
  return container;
}

describe("FindingInspector", () => {
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    useStore.setState(initialState, true);
  });

  it("masks nested sensitive evidence until explicitly revealed", async () => {
    const inspector = await renderInspector();
    expect(inspector.textContent).toContain("admin");
    expect(inspector.textContent).toContain("••••••••");
    expect(inspector.textContent).not.toContain("correct-horse");
    expect(inspector.textContent).not.toContain("token-value");

    const reveal = inspector.querySelector<HTMLButtonElement>('[aria-label="Show sensitive evidence"]');
    await act(async () => reveal?.click());
    expect(inspector.textContent).toContain("correct-horse");
    expect(inspector.textContent).toContain("token-value");
  });

  it("focuses and identifies a finding reached through validation navigation", async () => {
    const inspector = await renderInspector({ targetRequestId: 7 });
    const target = inspector.querySelector<HTMLElement>('.context-inspector');
    expect(target?.classList.contains("is-targeted")).toBe(true);
    expect(target?.getAttribute("aria-current")).toBe("location");
    expect(document.activeElement).toBe(target);
  });

  it("explains a structured tool failure without hiding the raw result", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(createElement(ToolEventInspector, {
      event: {
        kind: "tool_result",
        label: "Tool result",
        text: "analysis_tool → exit=2",
        outcome: "failed",
        failureDiagnostic: {
          category: "command_exit",
          retryable: false,
          summary: "The command completed with a non-zero exit status.",
          recommendation: "Correct the command before retrying.",
        },
      },
    })));

    expect(container.textContent).toContain("Command Exit");
    expect(container.textContent).toContain("Change required before retry");
    expect(container.textContent).toContain("Correct the command before retrying.");
    expect(container.textContent).toContain("analysis_tool → exit=2");
  });
});
