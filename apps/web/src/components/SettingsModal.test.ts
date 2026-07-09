import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement, type ComponentType } from "react";
import { SettingsModal, type SettingsModalProps } from "./SettingsModal.js";

const TestableSettingsModal = SettingsModal as ComponentType<SettingsModalProps>;

describe("SettingsModal", () => {
  it("renders Settings modal when open", () => {
    const html = renderToString(createElement(TestableSettingsModal, {
      open: true,
      initialConfig: { provider: "openai", model: "m", apiKeyMasked: "••••••••" },
    }));
    expect(html).toContain("Settings");
    expect(html).toContain("Provider");
    expect(html).toContain("Model");
    expect(html).toContain("API Key");
    expect(html).toContain("Base URL");
    expect(html).toContain("Test Connection");
  });

  it("renders nothing when closed", () => {
    const html = renderToString(createElement(TestableSettingsModal, { open: false }));
    expect(html).toBe("");
  });
});
