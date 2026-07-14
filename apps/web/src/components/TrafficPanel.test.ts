// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TrafficEntry } from "@traceforge/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useStore } from "../store.js";
import { formatTrafficTime, TrafficPanel } from "./TrafficPanel.js";

// @ts-expect-error enable React act in jsdom tests
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const initialState = useStore.getState();
let root: Root | null = null;
let container: HTMLDivElement | null = null;

const capturedEntry: TrafficEntry = {
  id: "traffic_1",
  caseId: "case_1",
  method: "POST",
  url: "https://target.test/api/login?next=%2Fadmin",
  requestHeaders: { "content-type": "application/json", authorization: "Bearer redacted" },
  requestBody: '{"username":"admin"}',
  responseStatus: 401,
  responseBody: '{"error":"invalid credentials"}',
  createdAt: "2026-07-07T08:09:10.000Z",
};

async function renderTrafficPanel(): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(TrafficPanel));
  });
  return container;
}

describe("TrafficPanel", () => {
  beforeEach(() => {
    useStore.setState({
      caseId: null,
      traffic: [capturedEntry],
      browserController: "llm",
      browserUrl: "https://target.test",
    });
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    useStore.setState(initialState, true);
  });

  it("renders a compact request time for traffic cards", () => {
    expect(formatTrafficTime("2026-07-07T08:09:10.000Z", "en-US", "UTC")).toBe("08:09:10");
  });

  it("uses an accessible disclosure for captured request evidence", async () => {
    const panel = await renderTrafficPanel();
    const trigger = panel.querySelector<HTMLButtonElement>(".request-row-trigger");

    expect(trigger?.tagName).toBe("BUTTON");
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    expect(trigger?.getAttribute("aria-controls")).toBe("traffic-detail-traffic_1");
    expect(trigger?.textContent).toContain("POST");
    expect(trigger?.textContent).toContain("401");
    expect(trigger?.textContent).toContain(capturedEntry.url);

    act(() => trigger?.click());

    expect(trigger?.getAttribute("aria-expanded")).toBe("true");
    const detail = panel.querySelector<HTMLElement>("#traffic-detail-traffic_1");
    expect(detail?.textContent).toContain("Request headers");
    expect(detail?.textContent).toContain("Request body");
    expect(detail?.textContent).toContain("Response body");
    expect(detail?.textContent).toContain("authorization");
    expect(detail?.textContent).toContain("invalid credentials");
  });

  it("clears captured evidence through the real store action", async () => {
    const panel = await renderTrafficPanel();
    const clear = Array.from(panel.querySelectorAll("button")).find((button) => button.textContent === "Clear");

    act(() => clear?.click());

    expect(useStore.getState().traffic).toEqual([]);
    expect(panel.textContent).toContain("Capture ready");
    expect(panel.textContent).toContain("Requests0");
    expect(clear?.disabled).toBe(true);
  });

  it("represents an unfinished response without inventing a status or body", async () => {
    useStore.setState({
      traffic: [{ ...capturedEntry, id: "traffic_pending", responseStatus: null, responseBody: null }],
    });
    const panel = await renderTrafficPanel();
    const trigger = panel.querySelector<HTMLButtonElement>(".request-row-trigger");

    expect(trigger?.textContent).toContain("Pending");
    act(() => trigger?.click());
    expect(panel.textContent).toContain("No response body captured");
  });
});
