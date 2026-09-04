import { describe, expect, it } from "vitest";
import { ChromiumPageRuntime, type BrowserElementReference } from "./chromium-page-runtime.js";
import type { ChromiumCdpEvent, ChromiumCdpPort } from "./chromium-cdp-adapter.js";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

class FakeCdp implements ChromiumCdpPort {
  readonly calls: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> = [];
  loaderId = "loader_1";
  nodes: unknown[] = [
    {
      backendDOMNodeId: 11,
      role: { value: "button" },
      name: { value: "Continue" },
      description: { value: "Move to the next step" },
      value: { value: "must-never-be-captured" },
      properties: [{ name: "focusable", value: { value: true } }],
    },
    { backendDOMNodeId: 12, role: { value: "StaticText" }, name: { value: "A page summary" }, properties: [] },
  ];

  async send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    this.calls.push({ method, params, ...(sessionId ? { sessionId } : {}) });
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame_1", loaderId: this.loaderId } } };
    if (method === "Accessibility.getFullAXTree") return { nodes: this.nodes };
    if (method === "Page.getLayoutMetrics") return { cssVisualViewport: {
      pageX: 0, pageY: 4, clientWidth: 5000, clientHeight: 5000,
    } };
    if (method === "Page.captureScreenshot") return { data: png.toString("base64") };
    if (method === "DOM.getBoxModel") return { model: { content: [0, 0, 10, 0, 10, 20, 0, 20] } };
    if (method === "Page.navigate") {
      this.loaderId = "loader_2";
      return { frameId: "frame_1", loaderId: this.loaderId };
    }
    return {};
  }
  onEvent(_listener: (event: ChromiumCdpEvent) => void): () => void { return () => undefined; }
  onFailure(_listener: (error: Error) => void): () => void { return () => undefined; }
  close(): void {}
}

function fixture(options: { maximumArtifactBytes?: number } = {}) {
  const cdp = new FakeCdp();
  const runtime = new ChromiumPageRuntime({ cdp, createId: () => "1", maximumDomNodes: 20,
    maximumArtifactBytes: options.maximumArtifactBytes ?? 16 * 1024, maximumScreenshotWidth: 1280,
    maximumScreenshotHeight: 720, maximumScreenshotPixels: 1280 * 720, maximumTextBytes: 1024 });
  runtime.registerTarget("page_1", "target_1", "page");
  return { cdp, runtime };
}

function domBody(bodyBase64: string) {
  return JSON.parse(Buffer.from(bodyBase64, "base64").toString("utf8")) as {
    nodes: Array<{ name: string; element?: BrowserElementReference }>;
  };
}

describe("ChromiumPageRuntime", () => {
  it("creates bounded accessibility artifacts, stable element references and DOM change summaries", async () => {
    const { cdp, runtime } = fixture();
    const first = await runtime.observe({ kind: "dom" });
    const firstBody = domBody(first.bodyBase64);
    expect(first.mimeType).toBe("application/vnd.traceforge.browser-dom+json");
    expect(first.summary).toMatchObject({ nodeCount: 2, change: { baseSha256: null, added: 2, removed: 0, changed: 0 } });
    expect(firstBody.nodes[0]?.element).toEqual({
      view: { generation: 1, pageId: "page_1", documentId: "loader_1" }, backendNodeId: 11,
    });
    expect(Buffer.from(first.bodyBase64, "base64").toString("utf8")).not.toContain("must-never-be-captured");

    cdp.nodes = [
      { backendDOMNodeId: 11, role: { value: "button" }, name: { value: "Continue now" },
        properties: [{ name: "focusable", value: { value: true } }] },
      { backendDOMNodeId: 13, role: { value: "link" }, name: { value: "Details" }, properties: [] },
    ];
    const second = await runtime.observe({ kind: "dom", pageId: "page_1" });
    expect(second.summary.change).toEqual({ baseSha256: first.sha256, added: 1, removed: 1, changed: 1 });
  });

  it("captures a clipped PNG and rejects artifacts that exceed the hard byte limit", async () => {
    const { cdp, runtime } = fixture();
    const result = await runtime.observe({ kind: "screenshot" });
    expect(result).toMatchObject({ kind: "screenshot", mimeType: "image/png", byteSize: png.length });
    expect(cdp.calls.find((call) => call.method === "Page.captureScreenshot")?.params).toMatchObject({
      captureBeyondViewport: false,
      clip: { width: 1280, height: 720, scale: 1 },
    });
    await expect(fixture({ maximumArtifactBytes: 8 }).runtime.observe({ kind: "screenshot" }))
      .rejects.toThrow("Artifact limit");
  });

  it("uses document-bound references for click/fill/key and rejects them after navigation", async () => {
    const { cdp, runtime } = fixture();
    const reference = domBody((await runtime.observe({ kind: "dom" })).bodyBase64).nodes[0]!.element!;
    await expect(runtime.act({ id: "action_forged", kind: "click",
      element: { ...reference, backendNodeId: 999 } })).rejects.toThrow("not issued");
    await expect(runtime.act({ id: "action_click", kind: "click", element: reference })).resolves.toMatchObject({ id: "action_click" });
    expect(cdp.calls.filter((call) => call.method === "Input.dispatchMouseEvent")).toHaveLength(2);
    await expect(runtime.act({ id: "action_fill_rejected", kind: "fill", element: reference, text: "bounded text" }))
      .rejects.toThrow("not issued as editable");
    cdp.nodes = [{ backendDOMNodeId: 14, role: { value: "textbox" }, name: { value: "Name" },
      properties: [{ name: "editable", value: { value: "plaintext" } }] }];
    const editable = domBody((await runtime.observe({ kind: "dom" })).bodyBase64).nodes[0]!.element!;
    await runtime.act({ id: "action_fill", kind: "fill", element: editable, text: "bounded text" });
    expect(cdp.calls.some((call) => call.method === "Input.insertText")).toBe(true);
    await runtime.act({ id: "action_press", kind: "press", element: editable, key: "Enter" });

    await runtime.act({ id: "action_navigate", kind: "navigate", view: editable.view, url: "https://authorized.example/next" });
    await expect(runtime.act({ id: "action_stale", kind: "click", element: reference })).rejects.toThrow("stale document");
    expect(cdp.calls.find((call) => call.method === "Page.navigate")?.params).toEqual({ url: "https://authorized.example/next" });
  });

  it("rotates control generations around manual takeover and requires a fresh observation after resume", async () => {
    const { runtime } = fixture();
    const reference = domBody((await runtime.observe({ kind: "dom" })).bodyBase64).nodes[0]!.element!;
    const handedOff = await runtime.beginTakeover();
    expect(handedOff).toMatchObject({ takeoverId: "browser-takeover:1", generation: 2, state: "manual_control" });
    await expect(runtime.observe({ kind: "dom" })).rejects.toThrow("paused for manual takeover");
    await expect(runtime.act({ id: "action_old", kind: "click", element: reference })).rejects.toThrow("paused for manual takeover");
    await expect(runtime.observeManual("wrong", { kind: "dom" })).rejects.toThrow("stale or invalid");
    const manualReference = domBody((await runtime.observeManual(handedOff.takeoverId, { kind: "dom" })).bodyBase64)
      .nodes[0]!.element!;
    await expect(runtime.actManual(handedOff.takeoverId, { id: "manual_click", kind: "click", element: manualReference }))
      .resolves.toMatchObject({ id: "manual_click", view: { generation: 2 } });
    await expect(runtime.resumeTakeover("wrong")).rejects.toThrow("stale or invalid");
    const resumed = await runtime.resumeTakeover(handedOff.takeoverId);
    expect(resumed).toMatchObject({ generation: 3, state: "agent_control" });
    await expect(runtime.act({ id: "action_old_after_resume", kind: "click", element: reference }))
      .rejects.toThrow("stale control generation");
    await expect(runtime.act({ id: "manual_action_after_resume", kind: "click", element: manualReference }))
      .rejects.toThrow("stale control generation");
    expect((await runtime.observe({ kind: "dom" })).view.generation).toBe(3);
  });
});
