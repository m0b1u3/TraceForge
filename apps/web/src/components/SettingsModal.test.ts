// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { createElement, type ComponentType, act } from "react";
import { createRoot } from "react-dom/client";
import { SettingsModal, type SettingsModalProps } from "./SettingsModal.js";

// @ts-expect-error enable React act in jsdom tests
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const TestableSettingsModal = SettingsModal as ComponentType<SettingsModalProps>;

function renderToHtml(element: React.ReactElement) {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  const html = document.body.innerHTML;
  act(() => {
    root.unmount();
  });
  return html;
}

describe("SettingsModal", () => {
  it("renders Settings modal when open", () => {
    const html = renderToHtml(
      createElement(TestableSettingsModal, {
        open: true,
        initialConfig: { provider: "openai", model: "m", apiKeyMasked: "••••••••" },
      })
    );
    expect(html).toContain("Settings");
    expect(html).toContain("Provider");
    expect(html).toContain("Model");
    expect(html).toContain("API Key");
    expect(html).toContain("Base URL");
    expect(html).toContain("Test Connection");
  });

  it("renders nothing when closed", () => {
    const html = renderToHtml(createElement(TestableSettingsModal, { open: false }));
    expect(html).toBe("");
  });
});
