// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { createElement, type ComponentType, act } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import { buildLlmConfigInput, SettingsModal, type SettingsModalProps, validateLlmSettings } from "./SettingsModal.js";
import { useStore } from "../store.js";

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

function mountSettings(props: SettingsModalProps) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(createElement(TestableSettingsModal, props)); });
  return {
    unmount: () => act(() => root.unmount()),
    button: (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.replace(/\s+/g, "") === label.replace(/\s+/g, "")),
  };
}

describe("SettingsModal", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
    document.documentElement.dataset.theme = "dark";
    useStore.setState({ settingsModalOpen: false, llmConfig: null });
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
    expect(html).toContain("Runtime");
    expect(html).toContain("Interface");
    expect(html).toContain("Test Connection");
  });

  it("renders nothing when closed", () => {
    const html = renderToHtml(createElement(TestableSettingsModal, { open: false }));
    expect(html).toBe("");
  });

  it("shows the persisted API key as a safe masked value", () => {
    const html = renderToHtml(
      createElement(TestableSettingsModal, {
        open: true,
        initialConfig: { provider: "openai", model: "m", apiKeyMasked: "MASKED-KEY" },
      })
    );

    expect(html).toContain('value="MASKED-KEY"');
    expect(html).toContain("Stored securely. Reveal it or focus the field to replace it.");
    expect(html).toContain('aria-label="Show API key"');
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
      currency: "",
      inputPricePerMillion: "",
      outputPricePerMillion: "",
    });

    expect(input).toEqual({
      provider: "openai",
      model: "deepseek-chat",
      baseUrl: "https://api.deepseek.com",
      apiKey: undefined,
      jsonMode: undefined,
      contextWindowTokens: 128000,
      maxOutputTokens: 8192,
      currency: null,
      inputPricePerMillion: null,
      outputPricePerMillion: null,
    });
  });

  it("builds and validates a complete pricing configuration", () => {
    const input = buildLlmConfigInput({
      provider: "openai",
      model: "priced-model",
      apiKey: "",
      baseUrl: "",
      jsonMode: "default",
      contextWindowTokens: "",
      maxOutputTokens: "",
      currency: "CNY",
      inputPricePerMillion: "1.5",
      outputPricePerMillion: "6",
    });
    expect(validateLlmSettings(input)).toBeNull();
    expect(input).toMatchObject({ currency: "CNY", inputPricePerMillion: 1.5, outputPricePerMillion: 6 });
  });

  it("rejects incomplete pricing", () => {
    expect(validateLlmSettings({
      provider: "openai",
      model: "priced-model",
      currency: "USD",
      inputPricePerMillion: null,
      outputPricePerMillion: null,
    })).toContain("both token prices");
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

  it("switches sections and only shows connection testing for the model section", () => {
    const view = mountSettings({ open: true, initialConfig: { provider: "openai", model: "m" } });
    expect(view.button("Test Connection")).toBeTruthy();

    act(() => { view.button("Runtime Context and pricing")?.click(); });
    expect(document.body.textContent).toContain("Usage pricing");
    expect(view.button("Test Connection")).toBeUndefined();

    act(() => { view.button("Interface Appearance preferences")?.click(); });
    expect(document.body.textContent).toContain("Appearance");
    expect(document.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toContain("Dark");
    view.unmount();
  });

  it("enables save only after a persisted field changes", () => {
    const view = mountSettings({ open: true, initialConfig: { provider: "openai", model: "m" } });
    const save = view.button("Save changes");
    expect(save?.disabled).toBe(true);

    const model = document.querySelector<HTMLInputElement>("#model")!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(model, "changed-model");
      model.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(save?.disabled).toBe(false);
    view.unmount();
  });

  it("clears a stored API key only when the user starts replacing it", () => {
    const view = mountSettings({ open: true, initialConfig: { provider: "openai", model: "m", apiKeyMasked: "MASKED-KEY" } });
    const apiKey = document.querySelector<HTMLInputElement>("#apiKey")!;
    expect(apiKey.value).toBe("MASKED-KEY");
    act(() => { apiKey.focus(); });
    expect(apiKey.value).toBe("");

    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(apiKey, "replacement-key");
      apiKey.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(apiKey.value).toBe("replacement-key");
    expect(view.button("Save changes")?.disabled).toBe(false);
    view.unmount();
  });

  it("synchronizes theme selection while keeping configuration save disabled", () => {
    const view = mountSettings({ open: true, initialConfig: { provider: "openai", model: "m" } });
    act(() => { view.button("Interface Appearance preferences")?.click(); });
    const light = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((item) => item.textContent?.includes("Light"));
    act(() => { light?.click(); });
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(light?.getAttribute("aria-checked")).toBe("true");
    expect(view.button("Save changes")?.disabled).toBe(true);
    view.unmount();
  });

});
