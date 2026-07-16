// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store.js";
import { BrowserControls } from "./BrowserPanel.js";

// @ts-expect-error enable React act in jsdom tests
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const initialState = useStore.getState();
let root: Root | null = null;
let container: HTMLDivElement | null = null;

function response(body: object = { ok: true }): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function renderControls(): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(createElement(BrowserControls)));
  return container;
}

async function clickButton(label: string): Promise<void> {
  const button = Array.from(container?.querySelectorAll("button") ?? [])
    .find((candidate) => candidate.textContent?.includes(label));
  expect(button).toBeDefined();
  await act(async () => button?.click());
}

describe("BrowserControls", () => {
  beforeEach(() => {
    useStore.setState({
      caseId: "case_1",
      browserController: null,
      browserUrl: "",
      toast: null,
    });
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    useStore.setState(initialState, true);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("uses the launch response as the immediate source of browser state", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({
      ok: true,
      controller: "llm",
      url: "https://target.test/",
    }));
    const controls = await renderControls();

    await clickButton("Launch browser");

    expect(fetch).toHaveBeenCalledWith("/api/cases/case_1/browser/start", { method: "POST" });
    expect(useStore.getState().browserController).toBe("llm");
    expect(useStore.getState().browserUrl).toBe("https://target.test/");
    expect(controls.textContent).toContain("Take over");
  });

  it("updates control ownership from takeover and release responses", async () => {
    useStore.setState({ browserController: "llm", browserUrl: "https://target.test/" });
    vi.mocked(fetch)
      .mockResolvedValueOnce(response({ ok: true, controller: "human" }))
      .mockResolvedValueOnce(response({ ok: true, controller: "llm" }));
    const controls = await renderControls();

    await clickButton("Take over");
    expect(useStore.getState().browserController).toBe("human");
    expect(controls.textContent).toContain("Return to Agent");

    await clickButton("Return to Agent");
    expect(useStore.getState().browserController).toBe("llm");
    expect(controls.textContent).toContain("Take over");
  });

  it("resets the browser state after the stop request completes", async () => {
    useStore.setState({ browserController: "llm", browserUrl: "https://target.test/" });
    vi.mocked(fetch).mockResolvedValueOnce(response());
    const controls = await renderControls();

    await clickButton("Stop");

    expect(fetch).toHaveBeenCalledWith("/api/cases/case_1/browser/stop", { method: "POST" });
    expect(useStore.getState().browserController).toBeNull();
    expect(useStore.getState().browserUrl).toBe("");
    expect(controls.textContent).toContain("Launch browser");
  });

  it("does not expose browser process details when launch fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      error: "browserType.launch: spawn UNKNOWN --user-data-dir=C:\\\\Users\\\\Administrator\\\\Temp",
    }), {
      status: 500,
      headers: { "content-type": "application/json" },
    }));
    await renderControls();

    await clickButton("Launch browser");

    expect(useStore.getState().toast?.message).toBe(
      "Unable to launch the shared browser. Check that Chromium is installed and permitted to run.",
    );
    expect(useStore.getState().toast?.message).not.toContain("user-data-dir");
    expect(useStore.getState().toast?.tone).toBe("error");
  });
});
