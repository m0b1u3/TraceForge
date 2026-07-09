// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement, type ComponentType, act } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import { SettingsModal, type SettingsModalProps } from "./SettingsModal.js";
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

describe("SettingsModal", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    useStore.setState({
      loadLlmConfig: vi.fn().mockResolvedValue(undefined),
      saveLlmConfig: vi.fn().mockResolvedValue(undefined),
      testLlmConfig: vi.fn().mockResolvedValue({ ok: true }),
      setSettingsModalOpen: vi.fn(),
    });
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

  it("omits jsonMode when saving with the default JSON mode selected", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const saveLlmConfig = vi.fn().mockResolvedValue(undefined);
    useStore.setState({ saveLlmConfig });

    await act(async () => {
      root.render(
        createElement(TestableSettingsModal, {
          open: true,
          initialConfig: {
            provider: "openai",
            model: "LongCat-2.0",
            apiKeyMasked: "••••••••",
            jsonMode: undefined,
          },
        })
      );
    });

    const form = document.querySelector("form");
    expect(form).not.toBeNull();
    await act(async () => {
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(saveLlmConfig).toHaveBeenCalledWith(expect.not.objectContaining({ jsonMode: expect.anything() }));

    act(() => {
      root.unmount();
    });
  });

  it("does not use an empty string as a Radix SelectItem value", () => {
    const source = readFileSync("apps/web/src/components/SettingsModal.tsx", "utf8");
    expect(source).not.toContain('{ value: "", label: "Default" }');
  });
});
