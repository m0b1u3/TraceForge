import { describe, expect, it, vi } from "vitest";
import {
  ChromiumCdpAdapter,
  type ChromiumCdpEvent,
  type ChromiumCdpPort,
} from "./chromium-cdp-adapter.js";
import type { BrowserControllerIdentity, BrowserResponseDirective, InterceptedBrowserRequest } from "./index.js";

const identity: BrowserControllerIdentity = {
  protocol: "traceforge.browser-controller.v1",
  controllerVersion: "1.0.0",
  controllerSha256: "a".repeat(64),
  browserVersion: "Chromium 140.0.0",
  browserSha256: "b".repeat(64),
};

class FakeCdp implements ChromiumCdpPort {
  readonly calls: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> = [];
  closed = 0;
  private eventListeners = new Set<(event: ChromiumCdpEvent) => void>();
  private failureListeners = new Set<(error: Error) => void>();
  async send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    this.calls.push({ method, params, ...(sessionId ? { sessionId } : {}) });
    return {};
  }
  onEvent(listener: (event: ChromiumCdpEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }
  onFailure(listener: (error: Error) => void): () => void {
    this.failureListeners.add(listener);
    return () => this.failureListeners.delete(listener);
  }
  async close(): Promise<void> { this.closed += 1; }
  emit(event: ChromiumCdpEvent): void { for (const listener of this.eventListeners) listener(event); }
  fail(error: Error): void { for (const listener of this.failureListeners) listener(error); }
}

function attached(type = "page", openerId?: string): ChromiumCdpEvent {
  return { method: "Target.attachedToTarget", params: {
    sessionId: `session_${type}_${openerId ?? "main"}`,
    targetInfo: { targetId: `target_${type}_${openerId ?? "main"}`, type, ...(openerId ? { openerId } : {}) },
  } };
}

function paused(patch: Record<string, unknown> = {}, sessionId = "session_page_main"): ChromiumCdpEvent {
  return { method: "Fetch.requestPaused", sessionId, params: {
    requestId: "fetch_1",
    networkId: "network_1",
    frameId: "target_page_main",
    resourceType: "Document",
    request: { url: "https://authorized.example/", method: "GET", headers: { Accept: "text/html" } },
    ...patch,
  } };
}

async function eventually(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    try { assertion(); return; } catch { await new Promise((resolve) => setTimeout(resolve, 5)); }
  }
  assertion();
}

function fixture() {
  const cdp = new FakeCdp();
  const adapter = new ChromiumCdpAdapter({ cdp, identity, requestTimeoutMs: 1000, responseLimitBytes: 4096 });
  return { cdp, adapter };
}

describe("Chromium CDP Adapter", () => {
  it("installs auto-attach, pre-network Fetch interception and deny-download policy before activation", async () => {
    const { cdp, adapter } = fixture();
    await adapter.initialize();
    expect(cdp.calls).toEqual([
      expect.objectContaining({ method: "Target.setDiscoverTargets" }),
      expect.objectContaining({ method: "Target.setAutoAttach", params: expect.objectContaining({ waitForDebuggerOnStart: true, flatten: true }) }),
      expect.objectContaining({ method: "Browser.setDownloadBehavior", params: expect.objectContaining({ behavior: "deny" }) }),
    ]);
    expect(adapter.proof).toMatchObject({ requestInterception: "before_network", serviceWorkers: "disabled", identity });
  });

  it("attaches every page and injects only the Host broker response into a paused navigation", async () => {
    const { cdp, adapter } = fixture();
    await adapter.initialize();
    const intercepted: InterceptedBrowserRequest[] = [];
    adapter.activate(async (request) => {
      intercepted.push(request);
      return { action: "fulfill", requestId: request.id, status: 200,
        headers: [{ name: "content-type", value: "text/html" }], bodyBase64: "PGgxPm9rPC9oMT4=", receiptRef: "receipt_1", artifactRef: null };
    }, vi.fn());
    cdp.emit(attached());
    await eventually(() => expect(cdp.calls.some((call) => call.method === "Runtime.runIfWaitingForDebugger")).toBe(true));
    cdp.emit(paused());
    await eventually(() => expect(cdp.calls.some((call) => call.method === "Fetch.fulfillRequest")).toBe(true));

    expect(intercepted[0]).toMatchObject({ kind: "document", initiator: "navigation", url: "https://authorized.example/" });
    expect(cdp.calls.find((call) => call.method === "Fetch.enable")).toMatchObject({ sessionId: "session_page_main",
      params: { handleAuthRequests: false } });
    expect(cdp.calls.find((call) => call.method === "Fetch.fulfillRequest")).toMatchObject({ sessionId: "session_page_main",
      params: { requestId: "fetch_1", responseCode: 200, body: "PGgxPm9rPC9oMT4=" } });
  });

  it("classifies popup, iframe, redirect, fetch, XHR and WebSocket without bypassing the Host handler", async () => {
    const { cdp, adapter } = fixture();
    await adapter.initialize();
    const observed: Array<Pick<InterceptedBrowserRequest, "kind" | "initiator">> = [];
    adapter.activate(async (request): Promise<BrowserResponseDirective> => {
      observed.push({ kind: request.kind, initiator: request.initiator });
      return { action: "block", requestId: request.id, reason: request.kind === "websocket" ? "websocket_streaming_unavailable" : "policy_denied" };
    }, vi.fn());
    cdp.emit(attached("page", "opener_1"));
    cdp.emit(attached("iframe"));
    await eventually(() => expect(cdp.calls.filter((call) => call.method === "Fetch.enable")).toHaveLength(2));
    cdp.emit(paused({}, "session_page_opener_1"));
    cdp.emit(paused({ requestId: "fetch_2" }, "session_iframe_main"));
    cdp.emit(paused({ requestId: "fetch_3", redirectedRequestId: "fetch_2" }));
    cdp.emit(paused({ requestId: "fetch_4", resourceType: "Fetch" }));
    cdp.emit(paused({ requestId: "fetch_5", resourceType: "XHR" }));
    cdp.emit(paused({ requestId: "fetch_6", resourceType: "WebSocket" }));
    await eventually(() => expect(observed).toHaveLength(6));
    expect(observed).toEqual([
      { kind: "document", initiator: "popup" },
      { kind: "iframe", initiator: "subresource" },
      { kind: "document", initiator: "redirect" },
      { kind: "fetch", initiator: "subresource" },
      { kind: "xhr", initiator: "subresource" },
      { kind: "websocket", initiator: "subresource" },
    ]);
    await eventually(() => expect(cdp.calls.filter((call) => call.method === "Fetch.failRequest")).toHaveLength(6));
  });

  it("terminates Service Workers before script release and rejects unsupported target types", async () => {
    const { cdp, adapter } = fixture();
    await adapter.initialize();
    adapter.activate(async () => { throw new Error("not expected"); }, vi.fn());
    cdp.emit(attached("service_worker"));
    cdp.emit(attached("shared_worker"));
    await eventually(() => expect(cdp.calls.some((call) => call.method === "Target.closeTarget")).toBe(true));
    expect(cdp.calls.find((call) => call.method === "Target.closeTarget")).toMatchObject({ params: { targetId: "target_service_worker_main" } });
    expect(cdp.calls.find((call) => call.method === "Target.detachFromTarget")).toBeTruthy();
  });

  it("fails the paused request when POST bytes are unavailable, capacity is exhausted or directives mismatch", async () => {
    const { cdp, adapter } = fixture();
    await adapter.initialize();
    const failures: Error[] = [];
    let release!: (directive: BrowserResponseDirective) => void;
    const deferred = new Promise<BrowserResponseDirective>((resolve) => { release = resolve; });
    adapter.activate(() => deferred, (error) => failures.push(error));
    cdp.emit(attached());
    await eventually(() => expect(cdp.calls.some((call) => call.method === "Fetch.enable")).toBe(true));
    cdp.emit(paused({ request: { url: "https://authorized.example/", method: "POST", headers: {}, hasPostData: true } }));
    await eventually(() => expect(failures[0]?.message).toMatch(/body is unavailable/));
    release({ action: "block", requestId: "wrong", reason: "policy_denied" });
    expect(cdp.calls.some((call) => call.method === "Fetch.fulfillRequest")).toBe(false);
  });

  it("allows only Artifact-backed denied downloads and reports CDP transport failure", async () => {
    const { cdp, adapter } = fixture();
    await adapter.initialize();
    const failures: Error[] = [];
    adapter.activate(async (request) => ({ action: "fulfill", requestId: request.id, status: 200, headers: [],
      bodyBase64: "", receiptRef: "receipt_1", artifactRef: "artifact_1" }), (error) => failures.push(error));
    cdp.emit(attached());
    await eventually(() => expect(cdp.calls.some((call) => call.method === "Fetch.enable")).toBe(true));
    cdp.emit(paused());
    await eventually(() => expect(cdp.calls.some((call) => call.method === "Fetch.fulfillRequest")).toBe(true));
    cdp.emit({ method: "Browser.downloadWillBegin", params: { url: "https://authorized.example/" } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(failures).toEqual([]);
    cdp.emit({ method: "Browser.downloadWillBegin", params: { url: "https://untracked.example/" } });
    await eventually(() => expect(failures.at(-1)?.message).toMatch(/outside the intercepted Artifact path/));
    cdp.emit({ method: "Target.targetCrashed", params: { targetId: "target_page_main" } });
    await eventually(() => expect(failures.at(-1)?.message).toBe("Chromium renderer target crashed"));
    cdp.fail(new Error("CDP pipe closed"));
    expect(failures.at(-1)?.message).toBe("CDP pipe closed");
  });
});
