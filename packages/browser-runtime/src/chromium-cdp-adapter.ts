import type {
  BrowserControllerIdentity,
  BrowserControllerProof,
  BrowserRequestInitiator,
  BrowserRequestKind,
  BrowserResponseDirective,
  InterceptedBrowserRequest,
} from "./index.js";
import {
  ChromiumPageRuntime,
  type BrowserControlAction,
  type BrowserControlResult,
  type BrowserObservationPayload,
  type BrowserObservationRequest,
  type BrowserTakeoverState,
  type ChromiumPageRuntimeOptions,
} from "./chromium-page-runtime.js";

export interface ChromiumCdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

export interface ChromiumCdpPort {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
  onEvent(listener: (event: ChromiumCdpEvent) => void): () => void;
  onFailure(listener: (error: Error) => void): () => void;
  close(): Promise<void> | void;
}

export interface ChromiumCdpAdapterOptions {
  cdp: ChromiumCdpPort;
  identity: BrowserControllerIdentity;
  maximumConcurrentRequests?: number;
  responseLimitBytes?: number;
  requestTimeoutMs?: number;
  createRequestId?: (event: ChromiumCdpEvent) => string;
  page?: Omit<ChromiumPageRuntimeOptions, "cdp">;
}

interface TargetBinding {
  targetId: string;
  type: string;
  openerId: string | null;
}

export class ChromiumCdpAdapter {
  readonly proof: BrowserControllerProof;
  private readonly maximumConcurrentRequests: number;
  private readonly responseLimitBytes: number;
  private readonly requestTimeoutMs: number;
  private readonly createRequestId: (event: ChromiumCdpEvent) => string;
  private readonly pages: ChromiumPageRuntime;
  private readonly targets = new Map<string, TargetBinding>();
  private readonly pending = new Set<string>();
  private readonly allowedDownloads = new Set<string>();
  private readonly background = new Set<Promise<void>>();
  private intercept: ((request: InterceptedBrowserRequest) => Promise<BrowserResponseDirective>) | undefined;
  private failure: ((error: Error) => void) | undefined;
  private unsubscribeEvent: (() => void) | undefined;
  private unsubscribeFailure: (() => void) | undefined;
  private closed = false;
  private fatalError: Error | undefined;

  constructor(private readonly options: ChromiumCdpAdapterOptions) {
    this.maximumConcurrentRequests = options.maximumConcurrentRequests ?? 16;
    this.responseLimitBytes = options.responseLimitBytes ?? 4 * 1024 * 1024;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.createRequestId = options.createRequestId ?? ((event) => `${event.sessionId ?? "browser"}:${text(event.params.requestId, "CDP request id")}`);
    this.pages = new ChromiumPageRuntime({ cdp: options.cdp, ...(options.page ?? {}) });
    if (![this.maximumConcurrentRequests, this.responseLimitBytes, this.requestTimeoutMs]
      .every((value) => Number.isSafeInteger(value) && value > 0)) throw new Error("Chromium CDP Adapter limits are invalid");
    this.proof = {
      controlTransport: "pipe",
      requestInterception: "before_network",
      browserDirectNetwork: "os_denied",
      serviceWorkers: "disabled",
      downloads: "intercepted",
      webSockets: "intercepted_or_blocked",
      identity: structuredClone(options.identity),
    };
  }

  async initialize(): Promise<void> {
    if (this.unsubscribeEvent) throw new Error("Chromium CDP Adapter is already initialized");
    this.unsubscribeEvent = this.options.cdp.onEvent((event) => this.schedule(event));
    this.unsubscribeFailure = this.options.cdp.onFailure((error) => this.fail(error));
    await this.options.cdp.send("Target.setDiscoverTargets", { discover: true });
    await this.options.cdp.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: [
        { type: "page", exclude: false },
        { type: "iframe", exclude: false },
        { type: "service_worker", exclude: false },
        { type: "worker", exclude: false },
      ],
    });
    await this.options.cdp.send("Browser.setDownloadBehavior", { behavior: "deny", eventsEnabled: true });
  }

  activate(
    intercept: (request: InterceptedBrowserRequest) => Promise<BrowserResponseDirective>,
    onFailure: (error: Error) => void,
  ): void {
    if (this.closed || !this.unsubscribeEvent) throw new Error("Chromium CDP Adapter is unavailable");
    if (this.fatalError) throw this.fatalError;
    if (this.intercept) throw new Error("Chromium CDP Adapter is already active");
    this.intercept = intercept;
    this.failure = onFailure;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.intercept = undefined;
    this.unsubscribeEvent?.();
    this.unsubscribeFailure?.();
    await Promise.allSettled([...this.background]);
    await this.options.cdp.close();
  }

  observe(request: BrowserObservationRequest): Promise<BrowserObservationPayload> {
    if (this.closed || !this.intercept) return Promise.reject(new Error("Chromium CDP Adapter is not active"));
    return this.pages.observe(request);
  }

  act(action: BrowserControlAction): Promise<BrowserControlResult> {
    if (this.closed || !this.intercept) return Promise.reject(new Error("Chromium CDP Adapter is not active"));
    return this.pages.act(action);
  }

  observeManual(takeoverId: string, request: BrowserObservationRequest): Promise<BrowserObservationPayload> {
    if (this.closed || !this.intercept) return Promise.reject(new Error("Chromium CDP Adapter is not active"));
    return this.pages.observeManual(takeoverId, request);
  }

  actManual(takeoverId: string, action: BrowserControlAction): Promise<BrowserControlResult> {
    if (this.closed || !this.intercept) return Promise.reject(new Error("Chromium CDP Adapter is not active"));
    return this.pages.actManual(takeoverId, action);
  }

  beginTakeover(): Promise<BrowserTakeoverState> {
    if (this.closed || !this.intercept) return Promise.reject(new Error("Chromium CDP Adapter is not active"));
    return this.pages.beginTakeover();
  }

  resumeTakeover(takeoverId: string): Promise<BrowserTakeoverState> {
    if (this.closed || !this.intercept) return Promise.reject(new Error("Chromium CDP Adapter is not active"));
    return this.pages.resumeTakeover(takeoverId);
  }

  private schedule(event: ChromiumCdpEvent): void {
    if (this.closed) return;
    const task = this.onEvent(event).catch((error) => this.fail(asError(error)));
    this.background.add(task);
    void task.finally(() => this.background.delete(task));
  }

  private async onEvent(event: ChromiumCdpEvent): Promise<void> {
    if (event.method === "Target.targetCrashed" || event.method === "Inspector.targetCrashed") {
      throw new Error("Chromium renderer target crashed");
    }
    if (event.method === "Target.attachedToTarget") return this.attachTarget(event);
    if (event.method === "Target.detachedFromTarget") {
      const sessionId = text(event.params.sessionId, "CDP detached session id");
      this.targets.delete(sessionId);
      this.pages.removeTarget(sessionId);
      return;
    }
    if (event.method === "Fetch.requestPaused") return this.requestPaused(event);
    if (event.method === "Browser.downloadWillBegin") {
      const url = text(event.params.url, "Chromium download URL");
      if (!this.allowedDownloads.delete(url)) {
        throw new Error("Chromium attempted a disk download outside the intercepted Artifact path");
      }
    }
  }

  private async attachTarget(event: ChromiumCdpEvent): Promise<void> {
    const sessionId = text(event.params.sessionId, "CDP attached session id");
    const targetInfo = record(event.params.targetInfo, "CDP target info");
    const binding: TargetBinding = {
      targetId: text(targetInfo.targetId, "CDP target id"),
      type: text(targetInfo.type, "CDP target type"),
      openerId: optionalText(targetInfo.openerId),
    };
    if (binding.type === "service_worker") {
      await this.options.cdp.send("Target.closeTarget", { targetId: binding.targetId });
      return;
    }
    if (!["page", "iframe", "worker"].includes(binding.type)) {
      await this.options.cdp.send("Target.detachFromTarget", { sessionId });
      return;
    }
    this.targets.set(sessionId, binding);
    await this.options.cdp.send("Fetch.enable", { patterns: [
      { urlPattern: "http://*/*", requestStage: "Request" },
      { urlPattern: "https://*/*", requestStage: "Request" },
    ], handleAuthRequests: false }, sessionId);
    await this.options.cdp.send("Network.enable", { maxTotalBufferSize: 0, maxResourceBufferSize: 0 }, sessionId);
    this.pages.registerTarget(sessionId, binding.targetId, binding.type);
    await this.options.cdp.send("Runtime.runIfWaitingForDebugger", {}, sessionId);
  }

  private async requestPaused(event: ChromiumCdpEvent): Promise<void> {
    const sessionId = text(event.sessionId, "CDP request session id");
    const cdpRequestId = text(event.params.requestId, "CDP request id");
    if (!this.intercept) {
      await this.failRequest(sessionId, cdpRequestId);
      throw new Error("Chromium emitted a network request before Controller activation");
    }
    if (this.pending.size >= this.maximumConcurrentRequests) {
      await this.failRequest(sessionId, cdpRequestId);
      throw new Error("Chromium intercepted request capacity is exhausted");
    }
    const requestId = this.createRequestId(event);
    if (this.pending.has(requestId)) {
      await this.failRequest(sessionId, cdpRequestId);
      throw new Error("Chromium reused an active intercepted request identity");
    }
    let request: InterceptedBrowserRequest;
    try {
      request = this.mapRequest(event, requestId);
    } catch (error) {
      await this.failRequest(sessionId, cdpRequestId).catch(() => undefined);
      throw error;
    }
    this.pending.add(requestId);
    try {
      const directive = await this.intercept(request);
      if (directive.requestId !== requestId) throw new Error("Browser response directive request identity mismatch");
      if (directive.action === "fulfill") {
        if (directive.artifactRef) this.allowedDownloads.add(request.url);
        await this.options.cdp.send("Fetch.fulfillRequest", {
          requestId: cdpRequestId,
          responseCode: directive.status,
          responseHeaders: directive.headers,
          body: directive.bodyBase64,
        }, sessionId);
      } else await this.failRequest(sessionId, cdpRequestId);
    } catch (error) {
      await this.failRequest(sessionId, cdpRequestId).catch(() => undefined);
      throw error;
    } finally {
      this.pending.delete(requestId);
    }
  }

  private mapRequest(event: ChromiumCdpEvent, id: string): InterceptedBrowserRequest {
    const value = record(event.params.request, "CDP request");
    const hasPostData = value.hasPostData === true;
    const postData = typeof value.postData === "string" ? value.postData : undefined;
    const postDataEntries = Array.isArray(value.postDataEntries) ? value.postDataEntries.map((entry) => {
      const bytes = record(entry, "CDP post data entry").bytes;
      if (typeof bytes !== "string") throw new Error("CDP post data bytes are invalid");
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(bytes)
        || Buffer.from(bytes, "base64").toString("base64") !== bytes) throw new Error("CDP post data bytes are not canonical base64");
      return Buffer.from(bytes, "base64");
    }) : [];
    const body = postDataEntries.length ? Buffer.concat(postDataEntries)
      : postData === undefined ? undefined : Buffer.from(postData, "utf8");
    if (hasPostData && body === undefined) throw new Error("Chromium request body is unavailable before network dispatch");
    const binding = this.targets.get(text(event.sessionId, "CDP request session id"));
    const frameId = optionalText(event.params.frameId) ?? `target:${binding?.targetId ?? "unknown"}`;
    const resourceType = optionalText(event.params.resourceType) ?? "Other";
    const redirected = optionalText(event.params.redirectedRequestId);
    return {
      id,
      url: text(value.url, "CDP request URL"),
      method: text(value.method, "CDP request method"),
      headers: stringRecord(value.headers, "CDP request headers"),
      ...(body === undefined ? {} : { bodyBase64: body.toString("base64") }),
      kind: requestKind(resourceType, binding, frameId),
      initiator: requestInitiator(resourceType, binding, frameId, Boolean(redirected)),
      frameId,
      navigationId: optionalText(event.params.networkId),
      redirectFromRequestId: redirected,
      responseLimitBytes: this.responseLimitBytes,
      timeoutMs: this.requestTimeoutMs,
    };
  }

  private failRequest(sessionId: string, requestId: string): Promise<unknown> {
    return this.options.cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, sessionId);
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.fatalError ??= error;
    this.failure?.(error);
  }
}

function requestKind(resourceType: string, binding: TargetBinding | undefined, frameId: string): BrowserRequestKind {
  if (resourceType === "WebSocket") return "websocket";
  if (resourceType === "Document") {
    if (binding?.openerId) return "document";
    return binding?.type === "iframe" || (binding?.type === "page" && frameId !== binding.targetId) ? "iframe" : "document";
  }
  if (resourceType === "Fetch") return "fetch";
  if (resourceType === "XHR") return "xhr";
  return "other";
}

function requestInitiator(resourceType: string, binding: TargetBinding | undefined, frameId: string,
  redirected: boolean): BrowserRequestInitiator {
  if (redirected) return "redirect";
  if (resourceType === "Document") return binding?.openerId ? "popup"
    : binding?.type === "iframe" || (binding?.type === "page" && frameId !== binding.targetId) ? "subresource" : "navigation";
  if (binding?.type === "worker") return "background";
  return "subresource";
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > 64 * 1024) throw new Error(`${label} is invalid`);
  return value;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function stringRecord(value: unknown, label: string): Record<string, string> {
  const input = record(value, label);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(input)) {
    if (typeof entry !== "string") throw new Error(`${label} contains a non-string value`);
    result[key] = entry;
  }
  return result;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
