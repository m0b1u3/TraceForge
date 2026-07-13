// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalInterventionCard, ScopeInterventionCard } from "./AgentInterventionCard.js";

// @ts-expect-error enable React act in jsdom tests
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function render(element: ReturnType<typeof createElement>): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(element));
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

describe("AgentInterventionCard", () => {
  it("keeps a failed approval actionable and explains recovery", async () => {
    const card = await render(createElement(ApprovalInterventionCard, {
      tool: "exec_command",
      input: "{\"command\":\"curl target\"}",
      action: null,
      error: "Submit approval failed: network unavailable.",
      onApprove: () => undefined,
      onReject: () => undefined,
    }));

    expect(card.querySelector('[role="alert"]')?.textContent).toContain("still pending");
    expect(Array.from(card.querySelectorAll("button")).every((button) => !button.disabled)).toBe(true);
  });

  it("uses explicit authorization language and locks both actions while submitting", async () => {
    const card = await render(createElement(ScopeInterventionCard, {
      host: "10.0.13.229:8080",
      reason: "User requested testing this host.",
      action: "scope-approved",
      error: null,
      onApprove: () => undefined,
      onReject: () => undefined,
    }));

    expect(card.textContent).toContain("requesting authorization");
    expect(card.textContent).toContain("Keep blocked");
    expect(Array.from(card.querySelectorAll("button")).every((button) => button.disabled)).toBe(true);
  });
});
