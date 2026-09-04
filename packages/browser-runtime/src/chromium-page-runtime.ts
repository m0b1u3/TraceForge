import { createHash, randomUUID } from "node:crypto";
import type { ChromiumCdpPort } from "./chromium-cdp-adapter.js";

export interface BrowserViewIdentity {
  generation: number;
  pageId: string;
  documentId: string;
}

export interface BrowserElementReference {
  view: BrowserViewIdentity;
  backendNodeId: number;
}

export interface BrowserDomNode {
  role: string;
  name: string;
  description: string;
  disabled: boolean;
  focusable: boolean;
  editable: boolean;
  checked: boolean | null;
  expanded: boolean | null;
  element?: BrowserElementReference;
}

export interface BrowserDomChangeSummary {
  baseSha256: string | null;
  added: number;
  removed: number;
  changed: number;
}

export type BrowserObservationRequest =
  | { kind: "dom"; pageId?: string }
  | { kind: "screenshot"; pageId?: string };

export interface BrowserObservationPayload {
  kind: BrowserObservationRequest["kind"];
  view: BrowserViewIdentity;
  mimeType: "application/vnd.traceforge.browser-dom+json" | "image/png";
  bodyBase64: string;
  byteSize: number;
  sha256: string;
  summary: {
    nodeCount: number;
    truncated: boolean;
    change: BrowserDomChangeSummary | null;
  };
}

export interface BrowserObservationResult extends Omit<BrowserObservationPayload, "bodyBase64"> {
  artifactRef: string;
}

export type BrowserControlAction =
  | { id: string; kind: "navigate"; view: BrowserViewIdentity; url: string }
  | { id: string; kind: "click"; element: BrowserElementReference }
  | { id: string; kind: "fill"; element: BrowserElementReference; text: string }
  | { id: string; kind: "press"; element: BrowserElementReference; key: BrowserControlKey };

export type BrowserControlKey = "Enter" | "Escape" | "Tab" | "Backspace" | "Delete"
  | "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Home" | "End" | "PageUp" | "PageDown";

export interface BrowserControlResult {
  id: string;
  view: BrowserViewIdentity;
}

export interface BrowserTakeoverState {
  takeoverId: string;
  generation: number;
  state: "manual_control" | "agent_control";
  pages: BrowserViewIdentity[];
}

export interface ChromiumPageRuntimeOptions {
  cdp: ChromiumCdpPort;
  maximumDomNodes?: number;
  maximumArtifactBytes?: number;
  maximumScreenshotWidth?: number;
  maximumScreenshotHeight?: number;
  maximumScreenshotPixels?: number;
  maximumPages?: number;
  maximumTextBytes?: number;
  createId?: () => string;
}

interface PageTarget {
  targetId: string;
  type: "page" | "iframe";
}

interface PreviousDom {
  sha256: string;
  documentId: string;
  nodes: Map<number, string>;
}

interface IssuedElements {
  documentId: string;
  nodes: Map<number, { editable: boolean }>;
}

const controlKeys = new Set<BrowserControlKey>([
  "Enter", "Escape", "Tab", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Home", "End", "PageUp", "PageDown",
]);
const actionableRoles = new Set([
  "button", "checkbox", "combobox", "link", "listbox", "menuitem", "option", "radio", "searchbox",
  "slider", "spinbutton", "switch", "tab", "textbox", "treeitem",
]);

export class ChromiumPageRuntime {
  private readonly pages = new Map<string, PageTarget>();
  private readonly previousDom = new Map<string, PreviousDom>();
  private readonly issuedElements = new Map<string, IssuedElements>();
  private readonly maximumDomNodes: number;
  private readonly maximumArtifactBytes: number;
  private readonly maximumScreenshotWidth: number;
  private readonly maximumScreenshotHeight: number;
  private readonly maximumScreenshotPixels: number;
  private readonly maximumPages: number;
  private readonly maximumTextBytes: number;
  private readonly createId: () => string;
  private generation = 1;
  private controlState: "agent_control" | "manual_control" = "agent_control";
  private takeoverId: string | null = null;

  constructor(private readonly options: ChromiumPageRuntimeOptions) {
    this.maximumDomNodes = options.maximumDomNodes ?? 2_000;
    this.maximumArtifactBytes = options.maximumArtifactBytes ?? 1024 * 1024;
    this.maximumScreenshotWidth = options.maximumScreenshotWidth ?? 2_048;
    this.maximumScreenshotHeight = options.maximumScreenshotHeight ?? 2_048;
    this.maximumScreenshotPixels = options.maximumScreenshotPixels ?? 4_194_304;
    this.maximumPages = options.maximumPages ?? 16;
    this.maximumTextBytes = options.maximumTextBytes ?? 2_048;
    this.createId = options.createId ?? randomUUID;
    if ([this.maximumDomNodes, this.maximumArtifactBytes, this.maximumScreenshotWidth,
      this.maximumScreenshotHeight, this.maximumScreenshotPixels, this.maximumPages, this.maximumTextBytes]
      .some((value) => !Number.isSafeInteger(value) || value < 1)) throw new Error("Chromium page limits are invalid");
  }

  registerTarget(sessionId: string, targetId: string, type: string): void {
    if (type !== "page" && type !== "iframe") return;
    if (!sessionId.trim() || !targetId.trim()) throw new Error("Chromium page target identity is invalid");
    if (!this.pages.has(sessionId) && this.pages.size >= this.maximumPages) throw new Error("Chromium page capacity is exhausted");
    if (this.pages.get(sessionId)?.targetId !== targetId) {
      this.previousDom.delete(sessionId);
      this.issuedElements.delete(sessionId);
    }
    this.pages.set(sessionId, { targetId, type });
  }

  removeTarget(sessionId: string): void {
    this.pages.delete(sessionId);
    this.previousDom.delete(sessionId);
    this.issuedElements.delete(sessionId);
  }

  async observe(request: BrowserObservationRequest): Promise<BrowserObservationPayload> {
    this.assertAgentControl();
    return this.observeCurrent(request);
  }

  async observeManual(takeoverId: string, request: BrowserObservationRequest): Promise<BrowserObservationPayload> {
    this.assertManualControl(takeoverId);
    return this.observeCurrent(request);
  }

  private async observeCurrent(request: BrowserObservationRequest): Promise<BrowserObservationPayload> {
    const pageId = this.selectPage(request.pageId);
    return request.kind === "dom" ? this.captureDom(pageId) : this.captureScreenshot(pageId);
  }

  async act(action: BrowserControlAction): Promise<BrowserControlResult> {
    this.assertAgentControl();
    return this.performAction(action);
  }

  async actManual(takeoverId: string, action: BrowserControlAction): Promise<BrowserControlResult> {
    this.assertManualControl(takeoverId);
    return this.performAction(action);
  }

  private async performAction(action: BrowserControlAction): Promise<BrowserControlResult> {
    assertActionId(action.id);
    if (action.kind === "navigate") {
      const current = await this.assertCurrentView(action.view);
      const pageId = current.pageId;
      let url: URL;
      try { url = new URL(action.url); } catch { throw new Error("Browser navigation URL is invalid"); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || Buffer.byteLength(url.href) > 64 * 1024) {
        throw new Error("Browser navigation URL is outside the supported channel");
      }
      const result = record(await this.options.cdp.send("Page.navigate", { url: url.href }, pageId), "Page.navigate result");
      const errorText = optionalText(result.errorText);
      if (errorText) throw new Error(`Browser navigation failed: ${boundedText(errorText, 1024)}`);
      const loaderId = optionalText(result.loaderId);
      const view = loaderId ? { generation: this.generation, pageId, documentId: loaderId } : await this.currentView(pageId);
      this.previousDom.delete(pageId);
      this.issuedElements.delete(pageId);
      return { id: action.id, view };
    }
    const issued = await this.assertCurrentElement(action.element);
    if (action.kind === "click") await this.click(action.element, issued.view.pageId);
    if (action.kind === "fill") {
      if (!issued.editable) throw new Error("Browser element was not issued as editable");
      await this.fill(action.element, issued.view.pageId, action.text);
    }
    if (action.kind === "press") await this.press(action.element, issued.view.pageId, action.key);
    return { id: action.id, view: await this.currentView(issued.view.pageId) };
  }

  async beginTakeover(): Promise<BrowserTakeoverState> {
    if (this.controlState !== "agent_control") throw new Error("Browser is already under manual control");
    const nextGeneration = this.generation + 1;
    const nextTakeoverId = `browser-takeover:${this.createId()}`;
    const pages = await this.views(nextGeneration);
    this.controlState = "manual_control";
    this.generation = nextGeneration;
    this.takeoverId = nextTakeoverId;
    this.previousDom.clear();
    this.issuedElements.clear();
    return { takeoverId: nextTakeoverId, generation: nextGeneration, state: "manual_control", pages };
  }

  async resumeTakeover(takeoverId: string): Promise<BrowserTakeoverState> {
    if (this.controlState !== "manual_control" || !this.takeoverId || takeoverId !== this.takeoverId) {
      throw new Error("Browser takeover identity is stale or invalid");
    }
    const completedId = this.takeoverId;
    const nextGeneration = this.generation + 1;
    const pages = await this.views(nextGeneration);
    this.takeoverId = null;
    this.generation = nextGeneration;
    this.previousDom.clear();
    this.issuedElements.clear();
    this.controlState = "agent_control";
    return { takeoverId: completedId, generation: nextGeneration, state: "agent_control", pages };
  }

  private async captureDom(pageId: string): Promise<BrowserObservationPayload> {
    const view = await this.currentView(pageId);
    const response = record(await this.options.cdp.send("Accessibility.getFullAXTree", {}, pageId), "Accessibility tree");
    if (!Array.isArray(response.nodes)) throw new Error("Accessibility tree nodes are invalid");
    const nodes: BrowserDomNode[] = [];
    const signatures = new Map<number, string>();
    const backendNodeIds: number[] = [];
    let truncated = response.nodes.length > this.maximumDomNodes;
    for (const value of response.nodes) {
      if (nodes.length >= this.maximumDomNodes) break;
      const node = record(value, "Accessibility node");
      if (node.ignored === true || !Number.isSafeInteger(node.backendDOMNodeId) || (node.backendDOMNodeId as number) < 1) continue;
      const backendNodeId = node.backendDOMNodeId as number;
      const role = axText(node.role);
      const properties = axProperties(node.properties);
      const focusable = properties.focusable === true;
      const editable = properties.editable === true || typeof properties.editable === "string";
      const entry: BrowserDomNode = {
        role: boundedText(role, 128),
        name: boundedText(axText(node.name), this.maximumTextBytes),
        description: boundedText(axText(node.description), this.maximumTextBytes),
        disabled: properties.disabled === true,
        focusable,
        editable,
        checked: booleanOrNull(properties.checked),
        expanded: booleanOrNull(properties.expanded),
        ...((focusable || editable || actionableRoles.has(role.toLowerCase())) ? {
          element: { view: structuredClone(view), backendNodeId },
        } : {}),
      };
      nodes.push(entry);
      backendNodeIds.push(backendNodeId);
      signatures.set(backendNodeId, digestJson(entry));
    }
    const previous = this.previousDom.get(pageId);
    let change = diffDom(previous?.documentId === view.documentId ? previous : undefined, signatures);
    const document = { format: 1, view, nodes, change, sensitiveValues: "omitted" };
    let body = Buffer.from(JSON.stringify(document), "utf8");
    if (body.length > this.maximumArtifactBytes && nodes.length) {
      let low = 0, high = nodes.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        const candidate = Buffer.from(JSON.stringify({ ...document, nodes: nodes.slice(0, middle) }), "utf8");
        if (candidate.length <= this.maximumArtifactBytes) low = middle;
        else high = middle - 1;
      }
      nodes.splice(low);
      backendNodeIds.splice(low);
      for (const id of [...signatures.keys()]) if (!backendNodeIds.includes(id)) signatures.delete(id);
      truncated = true;
      change = diffDom(previous?.documentId === view.documentId ? previous : undefined, signatures);
      body = Buffer.from(JSON.stringify({ ...document, nodes, change }), "utf8");
      while (body.length > this.maximumArtifactBytes && nodes.length) {
        nodes.pop();
        const removedId = backendNodeIds.pop();
        if (removedId !== undefined) signatures.delete(removedId);
        change = diffDom(previous?.documentId === view.documentId ? previous : undefined, signatures);
        body = Buffer.from(JSON.stringify({ ...document, nodes, change }), "utf8");
      }
    }
    if (body.length > this.maximumArtifactBytes) throw new Error("Browser DOM observation exceeds its Artifact limit");
    const sha256 = createHash("sha256").update(body).digest("hex");
    this.previousDom.set(pageId, { sha256, documentId: view.documentId, nodes: signatures });
    this.issuedElements.set(pageId, { documentId: view.documentId, nodes: new Map(nodes.flatMap((node) =>
      node.element ? [[node.element.backendNodeId, { editable: node.editable }] as const] : [])) });
    return {
      kind: "dom",
      view,
      mimeType: "application/vnd.traceforge.browser-dom+json",
      bodyBase64: body.toString("base64"),
      byteSize: body.length,
      sha256,
      summary: { nodeCount: nodes.length, truncated, change },
    };
  }

  private async captureScreenshot(pageId: string): Promise<BrowserObservationPayload> {
    const view = await this.currentView(pageId);
    const metrics = record(await this.options.cdp.send("Page.getLayoutMetrics", {}, pageId), "Page layout metrics");
    const viewport = record(metrics.cssVisualViewport ?? metrics.visualViewport, "Page visual viewport");
    const width = Math.min(positiveNumber(viewport.clientWidth, "viewport width"), this.maximumScreenshotWidth);
    const height = Math.min(positiveNumber(viewport.clientHeight, "viewport height"), this.maximumScreenshotHeight,
      Math.max(1, Math.floor(this.maximumScreenshotPixels / width)));
    const capture = record(await this.options.cdp.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
      clip: {
        x: finiteNumber(viewport.pageX ?? 0, "viewport x"),
        y: finiteNumber(viewport.pageY ?? 0, "viewport y"),
        width,
        height,
        scale: 1,
      },
    }, pageId), "Page screenshot");
    const data = canonicalBase64(capture.data, "Page screenshot data");
    const body = Buffer.from(data, "base64");
    if (body.length > this.maximumArtifactBytes) throw new Error("Browser screenshot exceeds its Artifact limit");
    if (body.length < 8 || !body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new Error("Browser screenshot is not a PNG image");
    }
    return {
      kind: "screenshot",
      view,
      mimeType: "image/png",
      bodyBase64: data,
      byteSize: body.length,
      sha256: createHash("sha256").update(body).digest("hex"),
      summary: { nodeCount: 0, truncated: false, change: null },
    };
  }

  private async click(element: BrowserElementReference, pageId: string): Promise<void> {
    await this.options.cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: element.backendNodeId }, pageId);
    const response = record(await this.options.cdp.send("DOM.getBoxModel", { backendNodeId: element.backendNodeId }, pageId), "DOM box model");
    const model = record(response.model, "DOM box model value");
    if (!Array.isArray(model.content) || model.content.length !== 8 || model.content.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
      throw new Error("DOM element has no bounded clickable box");
    }
    const xs = [model.content[0], model.content[2], model.content[4], model.content[6]] as number[];
    const ys = [model.content[1], model.content[3], model.content[5], model.content[7]] as number[];
    const x = xs.reduce((sum, value) => sum + value, 0) / 4;
    const y = ys.reduce((sum, value) => sum + value, 0) / 4;
    await this.options.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, pageId);
    await this.options.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, pageId);
  }

  private async fill(element: BrowserElementReference, pageId: string, value: string): Promise<void> {
    if (typeof value !== "string" || Buffer.byteLength(value) > this.maximumTextBytes) throw new Error("Browser fill text exceeds its limit");
    await this.options.cdp.send("DOM.focus", { backendNodeId: element.backendNodeId }, pageId);
    await this.options.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", code: "KeyA", modifiers: 2 }, pageId);
    await this.options.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2 }, pageId);
    await this.options.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Backspace", code: "Backspace" }, pageId);
    await this.options.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace" }, pageId);
    await this.options.cdp.send("Input.insertText", { text: value }, pageId);
  }

  private async press(element: BrowserElementReference, pageId: string, key: BrowserControlKey): Promise<void> {
    if (!controlKeys.has(key)) throw new Error("Browser control key is not allowed");
    await this.options.cdp.send("DOM.focus", { backendNodeId: element.backendNodeId }, pageId);
    await this.options.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key }, pageId);
    await this.options.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key }, pageId);
  }

  private async assertCurrentElement(element: BrowserElementReference): Promise<{ view: BrowserViewIdentity; editable: boolean }> {
    if (!isView(element?.view) || !Number.isSafeInteger(element.backendNodeId) || element.backendNodeId < 1) {
      throw new Error("Browser element reference is invalid");
    }
    if (element.view.generation !== this.generation) throw new Error("Browser element reference belongs to a stale control generation");
    const view = await this.currentView(this.selectPage(element.view.pageId));
    if (view.documentId !== element.view.documentId) throw new Error("Browser element reference belongs to a stale document");
    const issued = this.issuedElements.get(view.pageId);
    const capability = issued?.documentId === view.documentId ? issued.nodes.get(element.backendNodeId) : undefined;
    if (!capability) throw new Error("Browser element reference was not issued by the latest DOM observation");
    return { view, editable: capability.editable };
  }

  private async assertCurrentView(input: BrowserViewIdentity): Promise<BrowserViewIdentity> {
    if (!isView(input) || input.generation !== this.generation) throw new Error("Browser view belongs to a stale control generation");
    const view = await this.currentView(this.selectPage(input.pageId));
    if (view.documentId !== input.documentId) throw new Error("Browser view belongs to a stale document");
    return view;
  }

  private selectPage(pageId?: string): string {
    if (pageId !== undefined) {
      const page = this.pages.get(pageId);
      if (!page || page.type !== "page") throw new Error("Browser page is unknown or is not a top-level page");
      return pageId;
    }
    const selected = [...this.pages].find(([, page]) => page.type === "page");
    if (!selected) throw new Error("Browser has no controllable page");
    return selected[0];
  }

  private async currentView(pageId: string): Promise<BrowserViewIdentity> {
    const response = record(await this.options.cdp.send("Page.getFrameTree", {}, pageId), "Page frame tree");
    const frameTree = record(response.frameTree, "Page frame tree root");
    const frame = record(frameTree.frame, "Page root frame");
    return {
      generation: this.generation,
      pageId,
      documentId: requiredText(frame.loaderId, "Page document identity"),
    };
  }

  private async views(generation = this.generation): Promise<BrowserViewIdentity[]> {
    const pageIds = [...this.pages].filter(([, page]) => page.type === "page").map(([pageId]) => pageId);
    return Promise.all(pageIds.map(async (pageId) => ({ ...(await this.currentView(pageId)), generation })));
  }

  private assertAgentControl(): void {
    if (this.controlState !== "agent_control") throw new Error("Browser agent control is paused for manual takeover");
  }

  private assertManualControl(takeoverId: string): void {
    if (this.controlState !== "manual_control" || !this.takeoverId || takeoverId !== this.takeoverId) {
      throw new Error("Browser manual-control identity is stale or invalid");
    }
  }
}

function diffDom(previous: PreviousDom | undefined, current: Map<number, string>): BrowserDomChangeSummary {
  if (!previous) return { baseSha256: null, added: current.size, removed: 0, changed: 0 };
  let added = 0, removed = 0, changed = 0;
  for (const [id, signature] of current) {
    if (!previous.nodes.has(id)) added += 1;
    else if (previous.nodes.get(id) !== signature) changed += 1;
  }
  for (const id of previous.nodes.keys()) if (!current.has(id)) removed += 1;
  return { baseSha256: previous.sha256, added, removed, changed };
}

function axText(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const text = (value as Record<string, unknown>).value;
  return typeof text === "string" ? text : "";
}

function axProperties(value: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (!Array.isArray(value)) return result;
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const property = item as Record<string, unknown>;
    if (typeof property.name !== "string" || !property.value || typeof property.value !== "object") continue;
    result[property.name] = (property.value as Record<string, unknown>).value;
  }
  return result;
}

function booleanOrNull(value: unknown): boolean | null { return typeof value === "boolean" ? value : null; }

function boundedText(value: string, maximumBytes: number): string {
  let result = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  if (Buffer.byteLength(result) <= maximumBytes) return result;
  let low = 0, high = result.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(result.slice(0, middle)) <= maximumBytes) low = middle;
    else high = middle - 1;
  }
  return result.slice(0, low);
}

function digestJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function canonicalBase64(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
    || Buffer.from(value, "base64").toString("base64") !== value) throw new Error(`${label} is invalid`);
  return value;
}

function positiveNumber(value: unknown, label: string): number {
  const number = finiteNumber(value, label);
  if (number <= 0) throw new Error(`${label} is invalid`);
  return number;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} is invalid`);
  return value;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > 4096) throw new Error(`${label} is invalid`);
  return value;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function isView(value: unknown): value is BrowserViewIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const view = value as Record<string, unknown>;
  return Number.isSafeInteger(view.generation) && (view.generation as number) > 0
    && typeof view.pageId === "string" && Boolean(view.pageId.trim())
    && typeof view.documentId === "string" && Boolean(view.documentId.trim());
}

function assertActionId(value: string): void {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > 4096) throw new Error("Browser action identity is invalid");
}
