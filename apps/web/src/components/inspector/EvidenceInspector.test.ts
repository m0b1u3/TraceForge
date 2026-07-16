// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Fact } from "@traceforge/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../../store.js";
import { FindingInspector } from "./EvidenceInspector.js";

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

async function renderInspector(): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(createElement(FindingInspector, { fact })));
  return container;
}

describe("FindingInspector", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(async () => undefined) } });
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    useStore.setState(initialState, true);
    vi.restoreAllMocks();
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

  it("copies the original evidence even while the visual value is masked", async () => {
    const inspector = await renderInspector();
    const copy = inspector.querySelector<HTMLButtonElement>('[aria-label="Copy Evidence"]');
    await act(async () => copy?.click());

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(JSON.stringify(fact.value, null, 2));
    expect(inspector.querySelector('[aria-label="Copy Evidence"]')).not.toBeNull();
  });
});
