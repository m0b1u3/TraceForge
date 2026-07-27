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
        canvas: createElement("div", null, "Evidence graph"),
        knowledge: createElement("div", null, "Knowledge base"),
        dock: createElement("div", null, "Run console"),
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
  useStore.setState({ workspacePanelRequest: null, dockCollapsed: false });
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
    const horizontalPadding = 16 * 2;
    const columnGaps = 16 * 2;
    const minimumTrackWidth = 240 + 430 + 340;

    expect(css).toContain("grid-template-columns: minmax(240px, 0.72fr) minmax(430px, 1.42fr) minmax(340px, 1.12fr);");
    expect(minimumTrackWidth + columnGaps + horizontalPadding).toBeLessThanOrEqual(minimumViewportWidth);
  });

  it("spans the run dock across all columns below the panes", () => {
    const css = readFileSync("apps/web/src/app.css", "utf8");
    expect(css).toMatch(/\.workspace-dock\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/);
    expect(css).toMatch(/\.workspace-shell\s*\{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\)\s*auto/);
  });
});

describe("WorkspaceLayout", () => {
  it("defaults to the graph canvas as the active panel", () => {
    const workspace = renderWorkspace(1440).querySelector(".workspace-shell");
    expect(workspace?.getAttribute("data-active-panel")).toBe("canvas");
    expect(document.querySelector("#workspace-canvas")?.textContent).toContain("Evidence graph");
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
    expect(workspace?.getAttribute("data-active-panel")).toBe("canvas");
    expect(document.activeElement).toBe(trafficTrigger);

    act(() => trafficTrigger?.click());

    act(() => globalThis.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(workspace?.getAttribute("data-active-panel")).toBe("canvas");
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
    expect(workspace?.textContent).toContain("Evidence graph");
    expect(workspace?.textContent).toContain("Knowledge base");
  });

  it("collapses the run dock to a slim bar and expands it back via the toggle", () => {
    const workspace = renderWorkspace(1440).querySelector(".workspace-shell");
    const toggle = document.querySelector<HTMLButtonElement>(".workspace-dock-toggle");

    expect(workspace?.getAttribute("data-dock")).toBe("expanded");
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(workspace?.textContent).toContain("Run console");

    act(() => toggle?.click());

    expect(workspace?.getAttribute("data-dock")).toBe("collapsed");
    expect(useStore.getState().dockCollapsed).toBe(true);
    expect(document.querySelector(".workspace-dock-body")).toBeNull();

    act(() => toggle?.click());

    expect(workspace?.getAttribute("data-dock")).toBe("expanded");
    expect(useStore.getState().dockCollapsed).toBe(false);
    expect(workspace?.textContent).toContain("Run console");
  });
});
