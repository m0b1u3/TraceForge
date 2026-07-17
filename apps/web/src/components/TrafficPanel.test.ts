// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TrafficEntry } from "@traceforge/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useStore } from "../store.js";
import { filterTraffic, formatTrafficTime, TrafficPanel } from "./TrafficPanel.js";

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
  responseHeaders: { "content-type": "application/json; charset=utf-8", "content-length": "31" },
  responseSize: 31,
  contentType: "application/json; charset=utf-8",
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

  it("filters real traffic fields by query, method, and status family", () => {
    const entries: TrafficEntry[] = [
      capturedEntry,
      { ...capturedEntry, id: "traffic_2", method: "GET", url: "https://target.test/assets/app.js", responseStatus: 200, contentType: "text/javascript" },
      { ...capturedEntry, id: "traffic_3", method: "DELETE", url: "https://target.test/api/users/1", responseStatus: 503, contentType: "application/json" },
      { ...capturedEntry, id: "traffic_4", method: "OPTIONS", url: "https://target.test/api/users", responseStatus: null, contentType: null },
    ];

    expect(filterTraffic(entries, "app.js", "all", "all").map((entry) => entry.id)).toEqual(["traffic_2"]);
    expect(filterTraffic(entries, "", "DELETE", "5xx").map((entry) => entry.id)).toEqual(["traffic_3"]);
    expect(filterTraffic(entries, "pending", "other", "pending").map((entry) => entry.id)).toEqual(["traffic_4"]);
    expect(filterTraffic(entries, "application/json", "all", "4xx").map((entry) => entry.id)).toEqual(["traffic_1"]);
  });

  it("makes the current browser control owner explicit", async () => {
    const panel = await renderTrafficPanel();
    expect(panel.textContent).toContain("Control ownerAgent");

    act(() => useStore.setState({ browserController: "human" }));
    expect(panel.textContent).toContain("Control ownerOperator");
  });

  it("selects captured request evidence for the context inspector", async () => {
    const panel = await renderTrafficPanel();
    const trigger = panel.querySelector<HTMLButtonElement>(".request-row-trigger");

    expect(trigger?.tagName).toBe("BUTTON");
    expect(trigger?.getAttribute("aria-pressed")).toBe("false");
    expect(trigger?.textContent).toContain("POST");
    expect(trigger?.textContent).toContain("401");
    expect(trigger?.textContent).toContain("application/json");
    expect(trigger?.textContent).toContain("31 B");
    expect(trigger?.textContent).toContain(capturedEntry.url);

    act(() => trigger?.click());

    expect(trigger?.getAttribute("aria-pressed")).toBe("true");
    expect(useStore.getState().selectedTrafficId).toBe("traffic_1");
    expect(useStore.getState().inspectorMode).toBe("traffic");
  });

  it("requires an accessible confirmation before clearing persisted traffic", async () => {
    const panel = await renderTrafficPanel();
    const clear = Array.from(panel.querySelectorAll("button")).find((button) => button.textContent === "Clear");

    await act(async () => clear?.click());

    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Clear captured traffic?");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("1 captured request");
    const cancel = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find((button) => button.textContent === "Cancel");
    expect(cancel).toBeDefined();
    await act(async () => cancel?.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(useStore.getState().traffic).toHaveLength(1);
  });

  it("represents an unfinished response without inventing a status or body", async () => {
    useStore.setState({
      traffic: [{ ...capturedEntry, id: "traffic_pending", responseStatus: null, responseBody: null }],
    });
    const panel = await renderTrafficPanel();
    const trigger = panel.querySelector<HTMLButtonElement>(".request-row-trigger");

    expect(trigger?.textContent).toContain("Pending");
    act(() => trigger?.click());
    expect(useStore.getState().selectedTrafficId).toBe("traffic_pending");
  });

  it("bounds mounted request rows while retaining the complete searchable dataset", async () => {
    useStore.setState({
      traffic: Array.from({ length: 505 }, (_, index) => ({
        ...capturedEntry,
        id: `traffic_${index}`,
        url: `https://target.test/request/${index}`,
      })),
      selectedTrafficId: null,
    });
    const panel = await renderTrafficPanel();

    expect(panel.querySelectorAll(".request-row")).toHaveLength(500);
    expect(panel.textContent).toContain("500 of 505");
    expect(panel.textContent).toContain("Refine the filters to inspect loaded history");
  });
});
