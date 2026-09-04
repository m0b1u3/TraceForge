import { describe, expect, it } from "vitest";
import { ChromiumCdpAdapter, type ChromiumCdpEvent, type ChromiumCdpPort } from "./chromium-cdp-adapter.js";
import { BrowserControllerProcessRuntime, type BrowserControllerProcessIo } from "./controller-process-runtime.js";
import { BROWSER_CONTROLLER_PROTOCOL, LengthPrefixedJsonDecoder, encodeLengthPrefixedJson } from "./execution-node-controller.js";

class FakeIo implements BrowserControllerProcessIo {
  outputs: unknown[] = [];
  exitCodes: number[] = [];
  private data = new Set<(data: Buffer) => void>();
  private failures = new Set<(error: Error) => void>();
  private decoder = new LengthPrefixedJsonDecoder(1024 * 1024, 2 * 1024 * 1024);
  onData(listener: (data: Buffer) => void): () => void { this.data.add(listener); return () => this.data.delete(listener); }
  onFailure(listener: (error: Error) => void): () => void { this.failures.add(listener); return () => this.failures.delete(listener); }
  write(data: Buffer): void { this.outputs.push(...this.decoder.push(data)); }
  close(exitCode: number): void { this.exitCodes.push(exitCode); }
  input(value: unknown): void {
    const frame = encodeLengthPrefixedJson(value, 1024 * 1024);
    for (const listener of this.data) listener(frame);
  }
}

class FakeCdp implements ChromiumCdpPort {
  calls: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> = [];
  private events = new Set<(event: ChromiumCdpEvent) => void>();
  private failures = new Set<(error: Error) => void>();
  async send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    this.calls.push({ method, params, ...(sessionId ? { sessionId } : {}) });
    if (method === "Page.getFrameTree") return { frameTree: { frame: { loaderId: "document_1" } } };
    if (method === "Accessibility.getFullAXTree") return { nodes: [{ backendDOMNodeId: 11,
      role: { value: "button" }, name: { value: "Continue" }, properties: [] }] };
    if (method === "DOM.getBoxModel") return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } };
    return {};
  }
  onEvent(listener: (event: ChromiumCdpEvent) => void): () => void { this.events.add(listener); return () => this.events.delete(listener); }
  onFailure(listener: (error: Error) => void): () => void { this.failures.add(listener); return () => this.failures.delete(listener); }
  close(): void {}
  emit(event: ChromiumCdpEvent): void { for (const listener of this.events) listener(event); }
}

async function eventually(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    try { assertion(); return; } catch { await new Promise((resolve) => setTimeout(resolve, 5)); }
  }
  assertion();
}

function fixture() {
  const io = new FakeIo(), cdp = new FakeCdp();
  const adapter = new ChromiumCdpAdapter({ cdp, identity: {
    protocol: BROWSER_CONTROLLER_PROTOCOL, controllerVersion: "1.0.0", controllerSha256: "a".repeat(64),
    browserVersion: "Chromium 140", browserSha256: "b".repeat(64),
  }, requestTimeoutMs: 1000, responseLimitBytes: 4096 });
  const runtime = new BrowserControllerProcessRuntime({ io, adapter, maximumFrameBytes: 1024 * 1024,
    maximumBufferedBytes: 2 * 1024 * 1024, requestTimeoutMs: 1000, createId: () => "1" });
  return { io, cdp, runtime };
}

describe("Browser Controller Process Runtime", () => {
  it("bridges a paused Chromium request to the Host and injects only the returned Broker directive", async () => {
    const { io, cdp, runtime } = fixture();
    await runtime.start();
    expect(io.outputs[0]).toMatchObject({ type: "ready", proof: { requestInterception: "before_network" } });
    io.input({ protocol: BROWSER_CONTROLLER_PROTOCOL, type: "command", id: "activate_1", command: "activate", input: {} });
    await eventually(() => expect(io.outputs.some((frame) => (frame as { id?: string }).id === "activate_1")).toBe(true));
    cdp.emit({ method: "Target.attachedToTarget", params: { sessionId: "cdp_1",
      targetInfo: { targetId: "target_1", type: "page" } } });
    await eventually(() => expect(cdp.calls.some((call) => call.method === "Fetch.enable")).toBe(true));
    cdp.emit({ method: "Fetch.requestPaused", sessionId: "cdp_1", params: { requestId: "fetch_1", resourceType: "Document",
      frameId: "frame_1", networkId: "network_1",
      request: { url: "https://authorized.example/", method: "GET", headers: {} } } });
    await eventually(() => expect(io.outputs.some((frame) => (frame as { type?: string }).type === "request")).toBe(true));
    const requestFrame = io.outputs.find((frame) => (frame as { type?: string }).type === "request") as { id: string; request: { url: string } };
    expect(requestFrame.request.url).toBe("https://authorized.example/");
    io.input({ protocol: BROWSER_CONTROLLER_PROTOCOL, type: "request_result", id: requestFrame.id, ok: true,
      directive: { action: "fulfill", requestId: "cdp_1:fetch_1", status: 200, headers: [], bodyBase64: "",
        receiptRef: "network-receipt:1", artifactRef: null } });
    await eventually(() => expect(cdp.calls.some((call) => call.method === "Fetch.fulfillRequest")).toBe(true));

    io.input({ protocol: BROWSER_CONTROLLER_PROTOCOL, type: "command", id: "shutdown_1", command: "shutdown", input: {} });
    await eventually(() => expect(io.exitCodes).toEqual([0]));
  });

  it("closes the controller process with failure on malformed or unknown Host input", async () => {
    const { io, runtime } = fixture();
    await runtime.start();
    io.input({ protocol: BROWSER_CONTROLLER_PROTOCOL, type: "unexpected", id: "bad_1" });
    await eventually(() => expect(io.exitCodes).toEqual([1]));
  });

  it("carries bounded observation, control and manual-takeover commands over the same process protocol", async () => {
    const { io, cdp, runtime } = fixture();
    await runtime.start();
    io.input({ protocol: BROWSER_CONTROLLER_PROTOCOL, type: "command", id: "activate", command: "activate", input: {} });
    await eventually(() => expect(io.outputs.some((frame) => (frame as { id?: string }).id === "activate")).toBe(true));
    cdp.emit({ method: "Target.attachedToTarget", params: { sessionId: "page_1",
      targetInfo: { targetId: "target_1", type: "page" } } });
    await eventually(() => expect(cdp.calls.some((call) => call.method === "Runtime.runIfWaitingForDebugger")).toBe(true));

    io.input({ protocol: BROWSER_CONTROLLER_PROTOCOL, type: "command", id: "observe", command: "observe", input: { kind: "dom" } });
    await eventually(() => expect(io.outputs.some((frame) => (frame as { id?: string }).id === "observe")).toBe(true));
    const observed = io.outputs.find((frame) => (frame as { id?: string }).id === "observe") as {
      result: { view: { generation: number; pageId: string; documentId: string }; bodyBase64: string };
    };
    expect(observed.result).toMatchObject({ view: { generation: 1, pageId: "page_1", documentId: "document_1" } });
    const dom = JSON.parse(Buffer.from(observed.result.bodyBase64, "base64").toString("utf8"));
    const element = dom.nodes[0].element;

    io.input({ protocol: BROWSER_CONTROLLER_PROTOCOL, type: "command", id: "act", command: "act",
      input: { id: "action_1", kind: "click", element } });
    await eventually(() => expect(io.outputs.some((frame) => (frame as { id?: string }).id === "act")).toBe(true));
    expect(cdp.calls.filter((call) => call.method === "Input.dispatchMouseEvent")).toHaveLength(2);

    io.input({ protocol: BROWSER_CONTROLLER_PROTOCOL, type: "command", id: "handoff", command: "begin_takeover", input: {} });
    await eventually(() => expect(io.outputs.some((frame) => (frame as { id?: string }).id === "handoff")).toBe(true));
    const handoff = io.outputs.find((frame) => (frame as { id?: string }).id === "handoff") as { result: { takeoverId: string } };
    io.input({ protocol: BROWSER_CONTROLLER_PROTOCOL, type: "command", id: "manual_observe", command: "manual_observe",
      input: { takeoverId: handoff.result.takeoverId, request: { kind: "dom" } } });
    await eventually(() => expect(io.outputs.some((frame) => (frame as { id?: string }).id === "manual_observe")).toBe(true));
    const manualObserved = io.outputs.find((frame) => (frame as { id?: string }).id === "manual_observe") as {
      result: { bodyBase64: string };
    };
    const manualDom = JSON.parse(Buffer.from(manualObserved.result.bodyBase64, "base64").toString("utf8"));
    io.input({ protocol: BROWSER_CONTROLLER_PROTOCOL, type: "command", id: "manual_act", command: "manual_act",
      input: { takeoverId: handoff.result.takeoverId,
        action: { id: "manual_action", kind: "click", element: manualDom.nodes[0].element } } });
    await eventually(() => expect(io.outputs.some((frame) => (frame as { id?: string }).id === "manual_act")).toBe(true));
    expect(io.outputs.find((frame) => (frame as { id?: string }).id === "manual_act")).toMatchObject({ ok: true });
    io.input({ protocol: BROWSER_CONTROLLER_PROTOCOL, type: "command", id: "resume", command: "resume_takeover",
      input: { takeoverId: handoff.result.takeoverId } });
    await eventually(() => expect(io.outputs.some((frame) => (frame as { id?: string }).id === "resume")).toBe(true));
    expect(io.outputs.find((frame) => (frame as { id?: string }).id === "resume")).toMatchObject({
      ok: true, result: { state: "agent_control", generation: 3 },
    });
  });
});
