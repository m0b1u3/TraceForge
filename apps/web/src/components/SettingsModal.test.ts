import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import { SettingsModal } from "./SettingsModal.js";

describe("SettingsModal", () => {
  it("renders Settings modal when open", () => {
    const html = renderToString(createElement(SettingsModal, {
      open: true,
      initialConfig: { provider: "openai", model: "m", apiKeyEnv: "K", apiKeyMasked: "••••••••" },
    }));
    expect(html).toContain("Settings");
    expect(html).toContain("Provider");
    expect(html).toContain("Model");
    expect(html).toContain("API Key");
  });

  it("renders nothing when closed", () => {
    const html = renderToString(createElement(SettingsModal, { open: false }));
    expect(html).toBe("");
  });
});
