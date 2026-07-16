// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { WorkspaceLayout, getWorkspaceMode } from "./WorkspaceLayout.js";

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
        agent: createElement("div", null, "Agent workspace"),
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
});

describe("WorkspaceLayout", () => {
  it("closes a tablet drawer with Escape and returns focus to its trigger", () => {
    const workspace = renderWorkspace(1024).querySelector(".workspace-shell");
    const trafficTrigger = document.querySelector<HTMLButtonElement>("button[value='traffic']");

    expect(workspace).not.toBeNull();
    expect(trafficTrigger).not.toBeNull();

    act(() => trafficTrigger?.click());
    expect(workspace?.getAttribute("data-active-panel")).toBe("traffic");
    expect(document.querySelector("#workspace-traffic")?.getAttribute("role")).toBe("dialog");
    expect(document.querySelector("#workspace-traffic")?.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(document.querySelector("#workspace-traffic"));

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
    expect(workspace?.textContent).toContain("Agent workspace");
    expect(workspace?.textContent).toContain("Knowledge base");
  });
});
