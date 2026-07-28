// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { WorkspaceLayout, getWorkspaceMode } from "./WorkspaceLayout.js";
import { useStore } from "../store.js";

// @ts-expect-error enable React act in jsdom tests
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function setViewportWidth(width: number) {
  Object.defineProperty(globalThis, "innerWidth", { configurable: true, value: width });
}

function renderWorkspace(width: number) {
  setViewportWidth(width);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      createElement(WorkspaceLayout, {
        traffic: createElement("div", null, "Traffic evidence"),
        agent: createElement("div", null, "Agent console"),
        knowledge: createElement("div", null, "Knowledge base"),
      }),
    );
  });
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  document.body.innerHTML = "";
  useStore.setState({ workspacePanelRequest: null });
});

describe("getWorkspaceMode", () => {
  it.each([
    [1440, "columns"],
    [1100, "columns"],
    [1099, "drawer"],
    [768, "drawer"],
    [767, "single"],
    [375, "single"],
  ] as const)("maps %ipx to %s", (width, expected) => {
    expect(getWorkspaceMode(width)).toBe(expected);
  });
});

describe("desktop workspace layout", () => {
  it("fits its minimum tracks at the 1100px columns boundary while body overflow is hidden", () => {
    const css = readFileSync("apps/web/src/app.css", "utf8");
    const minimumViewportWidth = 1100;
    const horizontalPadding = 0;
    const columnGaps = 0;
    const minimumTrackWidth = 248 + 430 + 320;

    expect(css).toContain("grid-template-columns: clamp(248px, 18vw, 288px) minmax(0, 1fr) clamp(320px, 24vw, 380px);");
    expect(minimumTrackWidth + columnGaps + horizontalPadding).toBeLessThanOrEqual(minimumViewportWidth);
  });

  it("keeps the Agent console in the primary center column", () => {
    const css = readFileSync("apps/web/src/app.css", "utf8");
    expect(css).toMatch(/\.workspace-shell\s*\{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\)/);
    expect(css).not.toContain('grid-template-rows: minmax(0, 1fr) minmax(200px, 35%);');
  });
});

describe("WorkspaceLayout", () => {
  it("defaults to the Agent console as the active panel", () => {
    const workspace = renderWorkspace(1440).querySelector(".workspace-shell");
    expect(workspace?.getAttribute("data-active-panel")).toBe("agent");
    expect(document.querySelector("#workspace-agent")?.textContent).toContain("Agent console");
  });

  it("opens the Knowledge drawer for a programmatic navigation request and restores focus", () => {
    const workspace = renderWorkspace(1024).querySelector(".workspace-shell");
    const source = document.createElement("button");
    source.textContent = "Locate validation task";
    document.body.appendChild(source);
    source.focus();

    act(() => useStore.setState({ workspacePanelRequest: { panel: "knowledge", requestId: 1 } }));

    expect(workspace?.getAttribute("data-active-panel")).toBe("knowledge");
    expect(document.querySelector("#workspace-knowledge")?.getAttribute("role")).toBe("dialog");
    const close = document.querySelector<HTMLButtonElement>("button[aria-label='Close Knowledge panel']");
    expect(document.activeElement).toBe(close);

    act(() => close?.click());
    expect(document.activeElement).toBe(source);
  });

  it("provides a visible tablet drawer close action and returns focus to its trigger", () => {
    const workspace = renderWorkspace(1024).querySelector(".workspace-shell");
    const trafficTrigger = document.querySelector<HTMLButtonElement>("button[value='traffic']");

    expect(workspace).not.toBeNull();
    expect(trafficTrigger).not.toBeNull();

    act(() => trafficTrigger?.click());
    expect(workspace?.getAttribute("data-active-panel")).toBe("traffic");
    expect(document.querySelector("#workspace-traffic")?.getAttribute("role")).toBe("dialog");
    expect(document.querySelector("#workspace-traffic")?.getAttribute("aria-modal")).toBe("true");
    const closeButton = document.querySelector<HTMLButtonElement>("button[aria-label='Close Traffic panel']");
    expect(closeButton).not.toBeNull();
    expect(document.activeElement).toBe(closeButton);

    act(() => closeButton?.click());
    expect(workspace?.getAttribute("data-active-panel")).toBe("agent");
    expect(document.activeElement).toBe(trafficTrigger);

    act(() => trafficTrigger?.click());

    act(() => globalThis.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(workspace?.getAttribute("data-active-panel")).toBe("agent");
    expect(document.activeElement).toBe(trafficTrigger);
  });

  it("uses accessible single-panel switching on mobile without discarding panel content", () => {
    const workspace = renderWorkspace(375).querySelector(".workspace-shell");
    const knowledgeTrigger = document.querySelector<HTMLButtonElement>("button[value='knowledge']");

    expect(workspace?.getAttribute("data-mode")).toBe("single");
    expect(knowledgeTrigger?.getAttribute("aria-pressed")).toBe("false");

    act(() => knowledgeTrigger?.click());

    expect(workspace?.getAttribute("data-active-panel")).toBe("knowledge");
    expect(knowledgeTrigger?.getAttribute("aria-pressed")).toBe("true");
    expect(workspace?.textContent).toContain("Traffic evidence");
    expect(workspace?.textContent).toContain("Agent console");
    expect(workspace?.textContent).toContain("Knowledge base");
  });

});
