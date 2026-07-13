// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { createElement, type ComponentType, act } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import { buildLlmConfigInput, SettingsModal, type SettingsModalProps, validateLlmSettings } from "./SettingsModal.js";

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
  beforeEach(() => {
    document.body.innerHTML = "";
  });

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

  it("builds a manually configured endpoint without injecting provider defaults", () => {
    const input = buildLlmConfigInput({
      provider: "openai",
      model: "  deepseek-chat  ",
      apiKey: "",
      baseUrl: "  https://api.deepseek.com  ",
      jsonMode: "default",
      contextWindowTokens: "128000",
      maxOutputTokens: "8192",
    });

    expect(input).toEqual({
      provider: "openai",
      model: "deepseek-chat",
      baseUrl: "https://api.deepseek.com",
      apiKey: undefined,
      jsonMode: undefined,
      contextWindowTokens: 128000,
      maxOutputTokens: 8192,
    });
  });

  it("rejects an output budget that consumes the whole context window", () => {
    expect(validateLlmSettings({
      provider: "openai",
      model: "deepseek-chat",
      contextWindowTokens: 8192,
      maxOutputTokens: 8192,
    })).toContain("smaller than the context window");
  });

  it("does not use an empty string as a Radix SelectItem value", () => {
    const source = readFileSync("apps/web/src/components/SettingsModal.tsx", "utf8");
    expect(source).not.toContain('{ value: "", label: "Default" }');
    expect(source).not.toContain("Use LongCat default");
  });
});
