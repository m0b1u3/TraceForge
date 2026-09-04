import { createHash, randomUUID } from "node:crypto";
import {
  permissionProfileFingerprint,
  resourceLimitsFingerprint,
  type BrokeredHttpResponse,
  type BrokeredNetworkReceipt,
  type ExecutionAttribution,
  type ExecutionNode,
  type ExecutionResourceLimits,
  type ProcessAccess,
  type ProcessDescriptor,
} from "@traceforge/execution-node";
import type { EffectivePermissionProfile } from "@traceforge/orchestration-core";
import type {
  BrowserControlAction,
  BrowserControlResult,
  BrowserObservationPayload,
  BrowserObservationRequest,
  BrowserObservationResult,
  BrowserTakeoverState,
  BrowserViewIdentity,
} from "./chromium-page-runtime.js";

export type BrowserRequestKind = "document" | "iframe" | "fetch" | "xhr" | "websocket" | "download" | "other";
export type BrowserRequestInitiator = "navigation" | "redirect" | "popup" | "subresource" | "background";

export interface BrowserSessionOwner extends Omit<ExecutionAttribution, "actionId" | "idempotencyKey"> {
  authorizationAction: string;
}

export interface BrowserProcessConfiguration {
  controlTransport: "pipe";
  controllerIdentity: BrowserControllerIdentity;
  expectedSandboxBackend?: string;
  expectedBackendMeasurement?: string;
  executable: string;
  arguments: string[];
  workingDirectory: string;
  environment?: Record<string, string>;
  permissions: EffectivePermissionProfile;
  resources: ExecutionResourceLimits;
  timeoutMs: number;
  outputLimitBytes: number;
}

export interface InterceptedBrowserRequest {
  id: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  bodyBase64?: string;
  kind: BrowserRequestKind;
  initiator: BrowserRequestInitiator;
  frameId: string;
  navigationId: string | null;
  redirectFromRequestId: string | null;
  responseLimitBytes: number;
  timeoutMs: number;
}

export interface BrowserControllerProof {
  controlTransport: "pipe";
  requestInterception: "before_network";
  browserDirectNetwork: "os_denied";
  serviceWorkers: "disabled";
  downloads: "intercepted";
  webSockets: "intercepted_or_blocked";
  identity: BrowserControllerIdentity;
}

export interface BrowserControllerIdentity {
  protocol: "traceforge.browser-controller.v1";
  controllerVersion: string;
  controllerSha256: string;
  browserVersion: string;
  browserSha256: string;
}

export type BrowserResponseDirective =
  | { action: "fulfill"; requestId: string; status: number; headers: Array<{ name: string; value: string }>;
      bodyBase64: string; receiptRef: string; artifactRef: string | null }
  | { action: "block"; requestId: string; reason: "websocket_streaming_unavailable" | "unsupported_scheme" | "policy_denied" };

export interface BrowserControllerConnection {
  proof: BrowserControllerProof;
  start(
    intercept: (request: InterceptedBrowserRequest) => Promise<BrowserResponseDirective>,
    onFailure: (error: Error) => void,
  ): Promise<void> | void;
  observe(request: BrowserObservationRequest): Promise<BrowserObservationPayload>;
  act(action: BrowserControlAction): Promise<BrowserControlResult>;
  observeManual(takeoverId: string, request: BrowserObservationRequest): Promise<BrowserObservationPayload>;
  actManual(takeoverId: string, action: BrowserControlAction): Promise<BrowserControlResult>;
  beginTakeover(): Promise<BrowserTakeoverState>;
  resumeTakeover(takeoverId: string): Promise<BrowserTakeoverState>;
  close(reason: string): Promise<void> | void;
}

export interface BrowserControllerPort {
  attach(input: {
    sessionId: string;
    process: ProcessDescriptor;
    access: ProcessAccess;
    expectedIdentity: BrowserControllerIdentity;
  }): Promise<BrowserControllerConnection>;
}

export interface BrowserAuthorizationPort {
  assertSessionCurrent(owner: BrowserSessionOwner): Promise<void> | void;
  authorizeRequest(input: {
    owner: BrowserSessionOwner;
    url: string;
    method: string;
    kind: BrowserRequestKind;
  }): Promise<{ authorizationRef: string; canonicalUrl: string; expiresAt: string }>;
}

export interface BrowserArtifactPort {
  recordDownload(input: {
    sessionId: string;
    owner: BrowserSessionOwner;
    request: InterceptedBrowserRequest;
    receipt: BrokeredNetworkReceipt;
    headers: Array<{ name: string; value: string }>;
    bodyBase64: string;
    byteSize: number;
    sha256: string;
  }): Promise<{ ref: string }> | { ref: string };
  recordObservation(input: {
    sessionId: string;
    owner: BrowserSessionOwner;
    kind: BrowserObservationRequest["kind"];
    view: BrowserViewIdentity;
    mimeType: BrowserObservationPayload["mimeType"];
    bodyBase64: string;
    byteSize: number;
    sha256: string;
  }): Promise<{ ref: string }> | { ref: string };
}

export interface BrokeredBrowserLimits {
  maximumRequestsPerSession: number;
  maximumConcurrentRequests: number;
  maximumRequestBytes: number;
  maximumResponseBytes: number;
  maximumRequestTimeoutMs: number;
  maximumHeaders: number;
  maximumSessionMs: number;
  maximumObservationsPerSession: number;
  maximumActionsPerSession: number;
  maximumObservationBytes: number;
  maximumObservationRecords: number;
  maximumActionRecords: number;
  maximumControlTransitions: number;
}

export interface BrowserNetworkRecord {
  requestId: string;
  kind: BrowserRequestKind;
  initiator: BrowserRequestInitiator;
  origin: string;
  urlSha256: string;
  method: string;
  authorizationRef: string;
  receiptRef: string | null;
  artifactRef: string | null;
  outcome: "fulfilled" | "blocked";
  reason: string | null;
  at: string;
}

export interface BrowserSessionSnapshot {
  id: string;
  processId: string;
  owner: BrowserSessionOwner;
  status: "active" | "manual_control" | "frozen" | "closed";
  openedAt: string;
  expiresAt: string;
  requestCount: number;
  activeRequests: number;
  interactionGeneration: number;
  observationCount: number;
  actionCount: number;
  takeoverId: string | null;
  observations: Array<{
    kind: BrowserObservationRequest["kind"];
    artifactRef: string;
    sha256: string;
    byteSize: number;
    view: BrowserViewIdentity;
    at: string;
  }>;
  actions: Array<{
    id: string;
    kind: BrowserControlAction["kind"];
    origin: "agent" | "manual";
    inputSha256: string;
    view: BrowserViewIdentity;
    at: string;
  }>;
  controlTransitions: Array<{
    takeoverId: string;
    state: BrowserTakeoverState["state"];
    generation: number;
    at: string;
  }>;
  records: BrowserNetworkRecord[];
}

export interface BrokeredBrowserRuntimeOptions {
  executionNode: ExecutionNode;
  controller: BrowserControllerPort;
  authorization: BrowserAuthorizationPort;
  artifacts?: BrowserArtifactPort;
  limits?: Partial<BrokeredBrowserLimits>;
  now?: () => string;
  createId?: () => string;
}

const forbiddenEnvironment = new Set(["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]);
const forbiddenArguments = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--proxy-server",
  "--proxy-pac-url",
  "--remote-debugging-port",
];
const headerName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const methodName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

interface ActiveSession {
  snapshot: BrowserSessionSnapshot;
  access: ProcessAccess;
  connection: BrowserControllerConnection;
  hostPermissions: EffectivePermissionProfile;
  fingerprints: Map<string, string>;
  responses: Map<string, BrowserResponseDirective>;
  actionFingerprints: Map<string, string>;
  actionResponses: Map<string, BrowserControlResult>;
  interactionActive: boolean;
  controllerClosed: boolean;
  processTerminated: boolean;
}

export class BrokeredBrowserRuntime {
  readonly limits: BrokeredBrowserLimits;
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly now: () => string;
  private readonly createId: () => string;

  constructor(private readonly options: BrokeredBrowserRuntimeOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? randomUUID;
    this.limits = {
      maximumRequestsPerSession: options.limits?.maximumRequestsPerSession ?? 2_000,
      maximumConcurrentRequests: options.limits?.maximumConcurrentRequests ?? 16,
      maximumRequestBytes: options.limits?.maximumRequestBytes ?? 1024 * 1024,
      maximumResponseBytes: options.limits?.maximumResponseBytes ?? 4 * 1024 * 1024,
      maximumRequestTimeoutMs: options.limits?.maximumRequestTimeoutMs ?? 60_000,
      maximumHeaders: options.limits?.maximumHeaders ?? 128,
      maximumSessionMs: options.limits?.maximumSessionMs ?? 60 * 60_000,
      maximumObservationsPerSession: options.limits?.maximumObservationsPerSession ?? 500,
      maximumActionsPerSession: options.limits?.maximumActionsPerSession ?? 1_000,
      maximumObservationBytes: options.limits?.maximumObservationBytes ?? 1024 * 1024,
      maximumObservationRecords: options.limits?.maximumObservationRecords ?? 1_000,
      maximumActionRecords: options.limits?.maximumActionRecords ?? 1_000,
      maximumControlTransitions: options.limits?.maximumControlTransitions ?? 256,
    };
    if (Object.values(this.limits).some((value) => !Number.isSafeInteger(value) || value < 1)) {
      throw new Error("Brokered Browser limits must be positive safe integers");
    }
  }

  async open(owner: BrowserSessionOwner, process: BrowserProcessConfiguration): Promise<BrowserSessionSnapshot> {
    this.assertOwner(owner);
    this.assertProcessConfiguration(process);
    await this.options.authorization.assertSessionCurrent(owner);
    const sessionId = `browser_${this.createId()}`;
    const processPermissions = structuredClone(process.permissions);
    processPermissions.network = "deny";
    const hostPermissions = structuredClone(process.permissions);
    hostPermissions.network = "brokered";
    const attribution = this.attribution(owner, `browser-process:${sessionId}`);
    const started = await this.options.executionNode.startProcess({
      requestId: `browser-process:${sessionId}`,
      attribution,
      executable: process.executable,
      arguments: [...process.arguments],
      workingDirectory: process.workingDirectory,
      environment: { ...(process.environment ?? {}) },
      stdin: "pipe",
      timeoutMs: process.timeoutMs,
      outputLimitBytes: process.outputLimitBytes,
      resources: structuredClone(process.resources),
      permissions: processPermissions,
    });
    const access = { processId: started.process.id, adoptionToken: started.adoptionToken };
    let connection: BrowserControllerConnection | undefined;
    try {
      this.assertProcessProof(started.process, processPermissions, process, attribution);
      const openedAt = this.now();
      const expiresAt = Math.min(
        Date.parse(openedAt) + this.limits.maximumSessionMs,
        Date.parse(owner.leaseExpiresAt),
      );
      const snapshot: BrowserSessionSnapshot = {
        id: sessionId,
        processId: started.process.id,
        owner: structuredClone(owner),
        status: "active",
        openedAt,
        expiresAt: new Date(expiresAt).toISOString(),
        requestCount: 0,
        activeRequests: 0,
        interactionGeneration: 1,
        observationCount: 0,
        actionCount: 0,
        takeoverId: null,
        observations: [],
        actions: [],
        controlTransitions: [],
        records: [],
      };
      connection = await this.options.controller.attach(
        { sessionId, process: structuredClone(started.process), access: structuredClone(access),
          expectedIdentity: structuredClone(process.controllerIdentity) },
      );
      this.assertControllerProof(connection.proof, process.controllerIdentity);
      this.sessions.set(sessionId, {
        snapshot,
        access,
        connection,
        hostPermissions,
        fingerprints: new Map(),
        responses: new Map(),
        actionFingerprints: new Map(),
        actionResponses: new Map(),
        interactionActive: false,
        controllerClosed: false,
        processTerminated: false,
      });
      await connection.start(
        (request) => this.intercept(sessionId, request),
        (error) => { void this.freeze(sessionId, `Browser controller failed: ${error.message}`).catch(() => undefined); },
      );
      return structuredClone(snapshot);
    } catch (error) {
      this.sessions.delete(sessionId);
      await Promise.resolve(connection?.close("Browser session initialization failed")).catch(() => undefined);
      await this.terminate(access, sessionId).catch(() => undefined);
      throw error;
    }
  }

  snapshot(sessionId: string): BrowserSessionSnapshot | undefined {
    const session = this.sessions.get(sessionId);
    return session ? structuredClone(session.snapshot) : undefined;
  }

  async observe(sessionId: string, request: BrowserObservationRequest): Promise<BrowserObservationResult> {
    const session = this.requireInteractiveSession(sessionId);
    return this.observeControlled(sessionId, session, request,
      () => session.connection.observe(structuredClone(request)));
  }

  async act(sessionId: string, input: BrowserControlAction): Promise<BrowserControlResult> {
    const session = this.requireInteractiveSession(sessionId);
    return this.actControlled(sessionId, session, input, "agent", (action) => session.connection.act(action));
  }

  async observeManual(sessionId: string, takeoverId: string,
    request: BrowserObservationRequest): Promise<BrowserObservationResult> {
    const session = this.requireManualSession(sessionId, takeoverId);
    return this.observeControlled(sessionId, session, request,
      () => session.connection.observeManual(takeoverId, structuredClone(request)));
  }

  async actManual(sessionId: string, takeoverId: string, input: BrowserControlAction): Promise<BrowserControlResult> {
    const session = this.requireManualSession(sessionId, takeoverId);
    return this.actControlled(sessionId, session, input, "manual", (action) => session.connection.actManual(takeoverId, action));
  }

  private async observeControlled(sessionId: string, session: ActiveSession, request: BrowserObservationRequest,
    execute: () => Promise<BrowserObservationPayload>): Promise<BrowserObservationResult> {
    if (!this.options.artifacts?.recordObservation) throw new Error("Browser observations require an Artifact port");
    if (session.snapshot.observationCount >= this.limits.maximumObservationsPerSession) {
      throw new Error("Browser observation budget exhausted");
    }
    this.claimInteraction(session);
    try {
      await this.assertCurrentOrFreeze(sessionId, session);
      const rawPayload = await execute();
      let payload: BrowserObservationPayload;
      try {
        payload = validateObservationPayload(rawPayload,
          session.snapshot.interactionGeneration, this.limits.maximumObservationBytes);
      } catch (error) {
        await this.freeze(sessionId, "Browser Controller returned an invalid observation").catch(() => undefined);
        throw error;
      }
      const artifact = await this.options.artifacts.recordObservation({
        sessionId,
        owner: structuredClone(session.snapshot.owner),
        kind: payload.kind,
        view: structuredClone(payload.view),
        mimeType: payload.mimeType,
        bodyBase64: payload.bodyBase64,
        byteSize: payload.byteSize,
        sha256: payload.sha256,
      });
      if (!artifact.ref.trim()) throw new Error("Browser Artifact port returned no observation reference");
      await this.assertCurrentOrFreeze(sessionId, session);
      session.snapshot.observationCount += 1;
      session.snapshot.observations.push({ kind: payload.kind, artifactRef: artifact.ref, sha256: payload.sha256,
        byteSize: payload.byteSize, view: structuredClone(payload.view), at: this.now() });
      if (session.snapshot.observations.length > this.limits.maximumObservationRecords) session.snapshot.observations.shift();
      const { bodyBase64: _bodyBase64, ...result } = payload;
      return { ...result, artifactRef: artifact.ref };
    } finally {
      session.interactionActive = false;
    }
  }

  private async actControlled(sessionId: string, session: ActiveSession, input: BrowserControlAction, origin: "agent" | "manual",
    execute: (action: BrowserControlAction) => Promise<BrowserControlResult>): Promise<BrowserControlResult> {
    if (session.snapshot.actionCount >= this.limits.maximumActionsPerSession) throw new Error("Browser action budget exhausted");
    const action = structuredClone(input);
    assertActionGeneration(action, session.snapshot.interactionGeneration);
    const fingerprint = digest(action);
    const priorFingerprint = session.actionFingerprints.get(action.id);
    if (priorFingerprint) {
      if (priorFingerprint !== fingerprint) throw new Error(`Browser action ${action.id} was reused with different input`);
      const prior = session.actionResponses.get(action.id);
      if (!prior) throw new Error(`Browser action ${action.id} has an uncertain prior result`);
      return structuredClone(prior);
    }
    session.actionFingerprints.set(action.id, fingerprint);
    session.snapshot.actionCount += 1;
    this.claimInteraction(session);
    try {
      await this.assertCurrentOrFreeze(sessionId, session);
      const rawResult = await execute(action);
      let result: BrowserControlResult;
      try {
        result = validateControlResult(rawResult, action.id,
          session.snapshot.interactionGeneration);
      } catch (error) {
        await this.freeze(sessionId, "Browser action result became uncertain").catch(() => undefined);
        throw error;
      }
      await this.assertCurrentOrFreeze(sessionId, session);
      session.actionResponses.set(action.id, structuredClone(result));
      session.snapshot.actions.push({ id: action.id, kind: action.kind, origin, inputSha256: fingerprint,
        view: structuredClone(result.view), at: this.now() });
      if (session.snapshot.actions.length > this.limits.maximumActionRecords) session.snapshot.actions.shift();
      return result;
    } finally {
      session.interactionActive = false;
    }
  }

  async beginManualControl(sessionId: string): Promise<BrowserTakeoverState> {
    const session = this.requireInteractiveSession(sessionId);
    this.claimInteraction(session);
    try {
      await this.assertCurrentOrFreeze(sessionId, session);
      const rawTakeover = await session.connection.beginTakeover();
      let takeover: BrowserTakeoverState;
      try {
        takeover = validateTakeover(rawTakeover, "manual_control",
          session.snapshot.interactionGeneration + 1);
      } catch (error) {
        await this.freeze(sessionId, "Browser manual-control transition became uncertain").catch(() => undefined);
        throw error;
      }
      session.snapshot.status = "manual_control";
      session.snapshot.interactionGeneration = takeover.generation;
      session.snapshot.takeoverId = takeover.takeoverId;
      session.snapshot.controlTransitions.push({ takeoverId: takeover.takeoverId, state: takeover.state,
        generation: takeover.generation, at: this.now() });
      if (session.snapshot.controlTransitions.length > this.limits.maximumControlTransitions) {
        session.snapshot.controlTransitions.shift();
      }
      session.actionFingerprints.clear();
      session.actionResponses.clear();
      return takeover;
    } finally {
      session.interactionActive = false;
    }
  }

  async resumeManualControl(sessionId: string, takeoverId: string): Promise<BrowserTakeoverState> {
    const session = this.requireSession(sessionId);
    if (session.snapshot.status !== "manual_control" || session.snapshot.takeoverId !== takeoverId) {
      throw new Error("Browser manual-control identity is stale or invalid");
    }
    this.claimInteraction(session);
    try {
      await this.assertCurrentOrFreeze(sessionId, session);
      const rawTakeover = await session.connection.resumeTakeover(takeoverId);
      let takeover: BrowserTakeoverState;
      try {
        takeover = validateTakeover(rawTakeover, "agent_control",
          session.snapshot.interactionGeneration + 1);
      } catch (error) {
        await this.freeze(sessionId, "Browser manual-control recovery became uncertain").catch(() => undefined);
        throw error;
      }
      session.snapshot.status = "active";
      session.snapshot.interactionGeneration = takeover.generation;
      session.snapshot.takeoverId = null;
      session.snapshot.controlTransitions.push({ takeoverId: takeover.takeoverId, state: takeover.state,
        generation: takeover.generation, at: this.now() });
      if (session.snapshot.controlTransitions.length > this.limits.maximumControlTransitions) {
        session.snapshot.controlTransitions.shift();
      }
      session.actionFingerprints.clear();
      session.actionResponses.clear();
      return takeover;
    } finally {
      session.interactionActive = false;
    }
  }

  async close(sessionId: string, reason = "Browser session closed"): Promise<BrowserSessionSnapshot> {
    const session = this.requireSession(sessionId);
    session.snapshot.status = "closed";
    await this.teardown(session, reason);
    return structuredClone(session.snapshot);
  }

  async freeze(sessionId: string, reason = "Browser authorization is no longer current"): Promise<BrowserSessionSnapshot> {
    const session = this.requireSession(sessionId);
    if (session.snapshot.status === "active" || session.snapshot.status === "manual_control") session.snapshot.status = "frozen";
    await this.teardown(session, reason);
    return structuredClone(session.snapshot);
  }

  private async intercept(sessionId: string, input: InterceptedBrowserRequest): Promise<BrowserResponseDirective> {
    const session = this.requireSession(sessionId);
    if (session.snapshot.status !== "active" && session.snapshot.status !== "manual_control") {
      throw new Error(`Browser session ${sessionId} is not active`);
    }
    const now = this.now();
    if (Date.parse(now) >= Date.parse(session.snapshot.expiresAt)) {
      await this.freeze(sessionId, "Browser session expired");
      throw new Error(`Browser session ${sessionId} expired`);
    }
    if (session.snapshot.requestCount >= this.limits.maximumRequestsPerSession) {
      await this.freeze(sessionId, "Browser request budget exhausted");
      throw new Error("Browser request budget exhausted");
    }
    if (session.snapshot.activeRequests >= this.limits.maximumConcurrentRequests) throw new Error("Browser request concurrency exhausted");
    const request = this.prepareRequest(input);
    const requestFingerprint = digest(request);
    const previousFingerprint = session.fingerprints.get(request.id);
    if (previousFingerprint) {
      if (previousFingerprint !== requestFingerprint) throw new Error(`Browser request ${request.id} was reused with different input`);
      const previous = session.responses.get(request.id);
      if (!previous) throw new Error(`Browser request ${request.id} has an uncertain prior result`);
      return structuredClone(previous);
    }
    session.fingerprints.set(request.id, requestFingerprint);
    session.snapshot.requestCount += 1;
    session.snapshot.activeRequests += 1;
    try {
      await this.assertCurrentOrFreeze(sessionId, session);
      const grant = await this.options.authorization.authorizeRequest({
        owner: structuredClone(session.snapshot.owner), url: request.url, method: request.method, kind: request.kind,
      });
      this.assertGrant(grant, request.url);
      if (request.kind === "websocket") {
        const blocked: BrowserResponseDirective = { action: "block", requestId: request.id, reason: "websocket_streaming_unavailable" };
        this.record(session, request, grant.authorizationRef, null, null, "blocked", blocked.reason);
        session.responses.set(request.id, structuredClone(blocked));
        return blocked;
      }
      const response = await this.options.executionNode.requestHttp({
        requestId: `browser-http:${sessionId}:${request.id}`,
        attribution: this.attribution(session.snapshot.owner, `browser-http:${sessionId}:${request.id}`),
        permissions: structuredClone(session.hostPermissions),
        authorizationAction: session.snapshot.owner.authorizationAction,
        url: grant.canonicalUrl,
        method: request.method,
        headers: structuredClone(request.headers),
        ...(request.bodyBase64 === undefined ? {} : { bodyBase64: request.bodyBase64 }),
        timeoutMs: request.timeoutMs,
        responseLimitBytes: request.responseLimitBytes,
      });
      this.assertResponse(response, session, request, grant.canonicalUrl);
      await this.assertCurrentOrFreeze(sessionId, session);
      let artifactRef: string | null = null;
      const isDownload = request.kind === "download" || response.headers.some((header) =>
        header.name.toLowerCase() === "content-disposition" && /^\s*attachment(?:\s*;|\s*$)/i.test(header.value));
      if (isDownload) {
        if (!this.options.artifacts) throw new Error("Browser downloads require an Artifact port");
        const artifact = await this.options.artifacts.recordDownload({ sessionId, owner: structuredClone(session.snapshot.owner),
          request: structuredClone(request), receipt: structuredClone(response.receipt), headers: structuredClone(response.headers),
          bodyBase64: response.bodyBase64, byteSize: response.responseBytes,
          sha256: createHash("sha256").update(Buffer.from(response.bodyBase64, "base64")).digest("hex") });
        if (!artifact.ref.trim()) throw new Error("Browser Artifact port returned no reference");
        artifactRef = artifact.ref;
      }
      const directive: BrowserResponseDirective = { action: "fulfill", requestId: request.id, status: response.status,
        headers: structuredClone(response.headers), bodyBase64: response.bodyBase64,
        receiptRef: `network-receipt:${response.receipt.id}`, artifactRef };
      this.record(session, request, grant.authorizationRef, directive.receiptRef, artifactRef, "fulfilled", null);
      session.responses.set(request.id, structuredClone(directive));
      return directive;
    } catch (error) {
      try {
        await this.options.authorization.assertSessionCurrent(session.snapshot.owner);
      } catch {
        await this.freeze(sessionId).catch(() => undefined);
      }
      throw error;
    } finally {
      session.snapshot.activeRequests -= 1;
    }
  }

  private assertOwner(owner: BrowserSessionOwner): void {
    for (const [key, value] of Object.entries(owner)) {
      if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > 4096) throw new Error(`Browser owner ${key} is invalid`);
    }
    if (!Number.isFinite(Date.parse(owner.leaseExpiresAt))) throw new Error("Browser owner lease expiry is invalid");
    if (Date.parse(owner.leaseExpiresAt) <= Date.parse(this.now())) throw new Error("Browser owner lease is expired");
  }

  private assertProcessConfiguration(process: BrowserProcessConfiguration): void {
    if (process.controlTransport !== "pipe") throw new Error("Browser control transport must be a pipe");
    this.assertControllerIdentity(process.controllerIdentity);
    if (!process.executable.trim() || !process.workingDirectory.trim()) throw new Error("Browser process paths are required");
    if (process.permissions.network !== "brokered") throw new Error("Brokered Browser requires brokered host networking");
    if (process.permissions.process.access !== "sandboxed") throw new Error("Browser process requires sandboxed execution permission");
    if (process.expectedSandboxBackend !== undefined && !process.expectedSandboxBackend.trim()) {
      throw new Error("Browser sandbox backend identity is invalid");
    }
    if (process.expectedBackendMeasurement !== undefined && !/^[a-f0-9]{64}$/.test(process.expectedBackendMeasurement)) {
      throw new Error("Browser sandbox backend measurement is invalid");
    }
    if (Object.keys(process.environment ?? {}).some((name) => forbiddenEnvironment.has(name.toUpperCase()))) {
      throw new Error("Browser process cannot receive ambient proxy environment variables");
    }
    if (process.arguments.some((argument) => forbiddenArguments.some((prefix) => argument === prefix || argument.startsWith(`${prefix}=`)))) {
      throw new Error("Browser process arguments cannot disable sandboxing or create an alternate network/control channel");
    }
    if (!Number.isSafeInteger(process.timeoutMs) || process.timeoutMs < 1 || !Number.isSafeInteger(process.outputLimitBytes) || process.outputLimitBytes < 1) {
      throw new Error("Browser process limits are invalid");
    }
  }

  private assertProcessProof(
    descriptor: ProcessDescriptor,
    permissions: EffectivePermissionProfile,
    configuration: BrowserProcessConfiguration,
    attribution: ExecutionAttribution,
  ): void {
    const enforcement = descriptor.enforcement;
    if (descriptor.state !== "running" || descriptor.terminal !== null
      || descriptor.executable !== configuration.executable
      || canonicalJson(descriptor.arguments) !== canonicalJson(configuration.arguments)
      || descriptor.workingDirectory !== configuration.workingDirectory
      || canonicalJson(descriptor.attribution) !== canonicalJson(attribution)
      || !enforcement.sandboxed || !enforcement.filesystemPolicyApplied || !enforcement.resourceLimitsApplied
      || enforcement.network !== "deny"
      || enforcement.permissionProfileFingerprint !== permissionProfileFingerprint(permissions)
      || enforcement.resourceLimitsFingerprint !== resourceLimitsFingerprint(configuration.resources)
      || (configuration.expectedSandboxBackend !== undefined && enforcement.sandboxBackend !== configuration.expectedSandboxBackend)
      || (configuration.expectedBackendMeasurement !== undefined
        && enforcement.backendMeasurement !== configuration.expectedBackendMeasurement)) {
      throw new Error("Browser process lacks OS-enforced sandbox or denied-network proof");
    }
  }

  private assertControllerProof(proof: BrowserControllerProof, expectedIdentity: BrowserControllerIdentity): void {
    if (proof.controlTransport !== "pipe" || proof.requestInterception !== "before_network"
      || proof.browserDirectNetwork !== "os_denied" || proof.serviceWorkers !== "disabled"
      || proof.downloads !== "intercepted" || proof.webSockets !== "intercepted_or_blocked"
      || canonicalJson(proof.identity) !== canonicalJson(expectedIdentity)) {
      throw new Error("Browser controller cannot prove complete pre-network interception");
    }
  }

  private assertControllerIdentity(identity: BrowserControllerIdentity): void {
    if (identity.protocol !== "traceforge.browser-controller.v1"
      || !identity.controllerVersion.trim() || !identity.browserVersion.trim()
      || !/^[a-f0-9]{64}$/.test(identity.controllerSha256)
      || !/^[a-f0-9]{64}$/.test(identity.browserSha256)) {
      throw new Error("Browser controller identity is invalid");
    }
  }

  private prepareRequest(input: InterceptedBrowserRequest): InterceptedBrowserRequest {
    if (!input.id.trim() || !input.frameId.trim()) throw new Error("Browser request identity is required");
    if (!(["document", "iframe", "fetch", "xhr", "websocket", "download", "other"] as const).includes(input.kind)) {
      throw new Error("Browser request kind is invalid");
    }
    if (!(["navigation", "redirect", "popup", "subresource", "background"] as const).includes(input.initiator)) {
      throw new Error("Browser request initiator is invalid");
    }
    let url: URL;
    try { url = new URL(input.url); } catch { throw new Error("Browser request URL is invalid"); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error("Browser request uses an unsupported scheme");
    url.hash = "";
    const method = input.method.toUpperCase();
    if (!methodName.test(method) || method === "CONNECT") throw new Error("Browser request method is invalid");
    const headers = Object.entries(input.headers);
    if (headers.length > this.limits.maximumHeaders || headers.some(([name, value]) => !headerName.test(name)
      || typeof value !== "string" || /[\r\n]/.test(value))) throw new Error("Browser request headers are invalid");
    const bodyBytes = input.bodyBase64 === undefined ? 0 : canonicalBase64Bytes(input.bodyBase64);
    if (bodyBytes > this.limits.maximumRequestBytes) throw new Error("Browser request body exceeds its limit");
    if (!Number.isSafeInteger(input.responseLimitBytes) || input.responseLimitBytes < 1 || input.responseLimitBytes > this.limits.maximumResponseBytes
      || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1
      || input.timeoutMs > this.limits.maximumRequestTimeoutMs) throw new Error("Browser request limits are invalid");
    return { ...structuredClone(input), url: url.href, method };
  }

  private assertGrant(grant: { authorizationRef: string; canonicalUrl: string; expiresAt: string }, requestedUrl: string): void {
    let canonicalUrl: string;
    try {
      const parsed = new URL(grant.canonicalUrl);
      parsed.hash = "";
      canonicalUrl = parsed.href;
    } catch {
      throw new Error("Browser network authorization is invalid or expired");
    }
    if (!grant.authorizationRef.trim() || canonicalUrl !== requestedUrl
      || !Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= Date.parse(this.now())) {
      throw new Error("Browser network authorization is invalid or expired");
    }
  }

  private assertResponse(response: BrokeredHttpResponse, session: ActiveSession, request: InterceptedBrowserRequest, url: string): void {
    const expectedRequestId = `browser-http:${session.snapshot.id}:${request.id}`;
    const attribution = response.receipt.attribution;
    if (attribution.caseId !== session.snapshot.owner.caseId
      || attribution.runId !== session.snapshot.owner.runId
      || attribution.workId !== session.snapshot.owner.workId
      || attribution.workerId !== session.snapshot.owner.workerId
      || attribution.scopeRef !== session.snapshot.owner.scopeRef
      || attribution.leaseId !== session.snapshot.owner.leaseId
      || attribution.leaseExpiresAt !== session.snapshot.owner.leaseExpiresAt
      || attribution.actionId !== expectedRequestId || attribution.idempotencyKey !== expectedRequestId
      || response.receipt.requestId !== expectedRequestId || !response.receipt.authorizationRef.trim()
      || response.receipt.url !== url || response.receipt.method !== request.method
      || response.receipt.authorizationAction !== session.snapshot.owner.authorizationAction
      || response.receipt.permissionProfileFingerprint !== permissionProfileFingerprint(session.hostPermissions)
      || response.receipt.redirectFollowed !== false || response.receipt.status !== response.status
      || response.receipt.responseBytes !== response.responseBytes
      || response.receipt.responseBodyTruncated !== response.bodyTruncated
      || !Number.isSafeInteger(response.status) || response.status < 100 || response.status > 599
      || response.headers.length > this.limits.maximumHeaders
      || response.headers.some((header) => !headerName.test(header.name) || /[\r\n]/.test(header.value))
      || response.responseBytes > request.responseLimitBytes
      || canonicalBase64Bytes(response.bodyBase64) !== response.responseBytes) {
      throw new Error("Browser broker returned mismatched attribution or network receipt");
    }
  }

  private record(session: ActiveSession, request: InterceptedBrowserRequest, authorizationRef: string,
    receiptRef: string | null, artifactRef: string | null, outcome: BrowserNetworkRecord["outcome"], reason: string | null): void {
    const url = new URL(request.url);
    session.snapshot.records.push({ requestId: request.id, kind: request.kind, initiator: request.initiator,
      origin: url.origin, urlSha256: createHash("sha256").update(request.url).digest("hex"), method: request.method,
      authorizationRef, receiptRef, artifactRef, outcome, reason, at: this.now() });
  }

  private async assertCurrentOrFreeze(sessionId: string, session: ActiveSession): Promise<void> {
    try {
      await this.options.authorization.assertSessionCurrent(session.snapshot.owner);
    } catch (error) {
      await this.freeze(sessionId).catch(() => undefined);
      throw error;
    }
  }

  private attribution(owner: BrowserSessionOwner, actionId: string): ExecutionAttribution {
    return { caseId: owner.caseId, runId: owner.runId, workId: owner.workId, workerId: owner.workerId,
      scopeRef: owner.scopeRef, leaseId: owner.leaseId, leaseExpiresAt: owner.leaseExpiresAt,
      actionId, idempotencyKey: actionId };
  }

  private requireSession(sessionId: string): ActiveSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown Browser session ${sessionId}`);
    return session;
  }

  private requireInteractiveSession(sessionId: string): ActiveSession {
    const session = this.requireSession(sessionId);
    if (session.snapshot.status !== "active") throw new Error(`Browser session ${sessionId} is not under agent control`);
    return session;
  }

  private requireManualSession(sessionId: string, takeoverId: string): ActiveSession {
    const session = this.requireSession(sessionId);
    if (session.snapshot.status !== "manual_control" || session.snapshot.takeoverId !== takeoverId) {
      throw new Error("Browser manual-control identity is stale or invalid");
    }
    return session;
  }

  private claimInteraction(session: ActiveSession): void {
    if (session.interactionActive) throw new Error("Browser interaction concurrency exhausted");
    session.interactionActive = true;
  }

  private async teardown(session: ActiveSession, reason: string): Promise<void> {
    let firstError: unknown;
    try {
      if (!session.controllerClosed) {
        await session.connection.close(reason);
        session.controllerClosed = true;
      }
    } catch (error) {
      firstError = error;
    }
    try {
      if (!session.processTerminated) {
        await this.terminate(session.access, session.snapshot.id);
        session.processTerminated = true;
      }
    } catch (error) {
      firstError ??= error;
    }
    if (firstError) throw firstError;
  }

  private async terminate(access: ProcessAccess, sessionId: string): Promise<void> {
    await this.options.executionNode.terminateProcess({ ...access, operationId: `browser-close:${sessionId}`,
      force: true });
  }
}

function validateObservationPayload(value: unknown, generation: number, maximumBytes: number): BrowserObservationPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Browser observation payload is invalid");
  const payload = structuredClone(value) as BrowserObservationPayload;
  if ((payload.kind !== "dom" && payload.kind !== "screenshot") || !isBrowserView(payload.view)
    || payload.view.generation !== generation) throw new Error("Browser observation identity is invalid or stale");
  const expectedMime = payload.kind === "dom" ? "application/vnd.traceforge.browser-dom+json" : "image/png";
  if (payload.mimeType !== expectedMime || typeof payload.bodyBase64 !== "string") throw new Error("Browser observation media type is invalid");
  const bytes = canonicalBase64Bytes(payload.bodyBase64);
  if (!Number.isSafeInteger(payload.byteSize) || payload.byteSize !== bytes || bytes > maximumBytes
    || typeof payload.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(payload.sha256)
    || createHash("sha256").update(Buffer.from(payload.bodyBase64, "base64")).digest("hex") !== payload.sha256) {
    throw new Error("Browser observation bytes do not match their bounded identity");
  }
  const summary = payload.summary as unknown;
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) throw new Error("Browser observation summary is invalid");
  const record = summary as Record<string, unknown>;
  if (!Number.isSafeInteger(record.nodeCount) || (record.nodeCount as number) < 0 || typeof record.truncated !== "boolean") {
    throw new Error("Browser observation summary is invalid");
  }
  if (record.change !== null) {
    if (!record.change || typeof record.change !== "object" || Array.isArray(record.change)) throw new Error("Browser DOM change summary is invalid");
    const change = record.change as Record<string, unknown>;
    if (change.baseSha256 !== null && (typeof change.baseSha256 !== "string" || !/^[a-f0-9]{64}$/.test(change.baseSha256))) {
      throw new Error("Browser DOM change base is invalid");
    }
    if (![change.added, change.removed, change.changed].every((entry) => Number.isSafeInteger(entry) && (entry as number) >= 0)) {
      throw new Error("Browser DOM change counts are invalid");
    }
  }
  const body = Buffer.from(payload.bodyBase64, "base64");
  if (payload.kind === "screenshot") {
    if (record.nodeCount !== 0 || record.change !== null || body.length < 8
      || !body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new Error("Browser screenshot observation is invalid");
    }
  } else {
    if (record.change === null) throw new Error("Browser DOM observation has no change identity");
    let decoded: unknown;
    try { decoded = JSON.parse(body.toString("utf8")); } catch { throw new Error("Browser DOM Artifact is not valid JSON"); }
    if (!isExactRecord(decoded, ["change", "format", "nodes", "sensitiveValues", "view"])) {
      throw new Error("Browser DOM Artifact schema is invalid");
    }
    const document = decoded as Record<string, unknown>;
    if (document.format !== 1 || document.sensitiveValues !== "omitted"
      || canonicalJson(document.view) !== canonicalJson(payload.view)
      || canonicalJson(document.change) !== canonicalJson(record.change)
      || !Array.isArray(document.nodes) || document.nodes.length !== record.nodeCount) {
      throw new Error("Browser DOM Artifact identity is invalid");
    }
    for (const value of document.nodes) validateDomArtifactNode(value, payload.view);
  }
  return payload;
}

function validateDomArtifactNode(value: unknown, view: BrowserViewIdentity): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Browser DOM node is invalid");
  const node = value as Record<string, unknown>;
  const keys = Object.keys(node).sort();
  const withoutElement = ["checked", "description", "disabled", "editable", "expanded", "focusable", "name", "role"];
  const withElement = [...withoutElement, "element"].sort();
  if (JSON.stringify(keys) !== JSON.stringify(node.element === undefined ? withoutElement : withElement)
    || ![node.role, node.name, node.description].every((entry) => typeof entry === "string")
    || ![node.disabled, node.focusable, node.editable].every((entry) => typeof entry === "boolean")
    || ![node.checked, node.expanded].every((entry) => entry === null || typeof entry === "boolean")) {
    throw new Error("Browser DOM node schema is invalid");
  }
  if ([node.role, node.name, node.description].some((entry) => Buffer.byteLength(entry as string) > 2048)) {
    throw new Error("Browser DOM node text exceeds its limit");
  }
  if (node.element !== undefined) {
    if (!node.element || typeof node.element !== "object" || Array.isArray(node.element)) throw new Error("Browser DOM element is invalid");
    const element = node.element as Record<string, unknown>;
    if (JSON.stringify(Object.keys(element).sort()) !== JSON.stringify(["backendNodeId", "view"])
      || !Number.isSafeInteger(element.backendNodeId) || (element.backendNodeId as number) < 1
      || canonicalJson(element.view) !== canonicalJson(view)) throw new Error("Browser DOM element identity is invalid");
  }
}

function isExactRecord(value: unknown, keys: string[]): boolean {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value as Record<string, unknown>).sort()) === JSON.stringify([...keys].sort());
}

function assertActionGeneration(action: BrowserControlAction, generation: number): void {
  if (!action || typeof action !== "object" || typeof action.id !== "string" || !action.id.trim()
    || Buffer.byteLength(action.id) > 4096 || !["navigate", "click", "fill", "press"].includes(action.kind)) {
    throw new Error("Browser action is invalid");
  }
  if (action.kind === "navigate") {
    if (!isBrowserView(action.view) || action.view.generation !== generation) {
      throw new Error("Browser action uses an invalid or stale page view");
    }
    return;
  }
  if (!action.element || !isBrowserView(action.element.view) || !Number.isSafeInteger(action.element.backendNodeId)
    || action.element.backendNodeId < 1 || action.element.view.generation !== generation) {
    throw new Error("Browser action uses an invalid or stale element reference");
  }
}

function validateControlResult(value: unknown, actionId: string, generation: number): BrowserControlResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Browser control result is invalid");
  const result = structuredClone(value) as BrowserControlResult;
  if (result.id !== actionId || !isBrowserView(result.view) || result.view.generation !== generation) {
    throw new Error("Browser control result identity is invalid or stale");
  }
  return result;
}

function validateTakeover(value: unknown, state: BrowserTakeoverState["state"], generation: number): BrowserTakeoverState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Browser takeover result is invalid");
  const takeover = structuredClone(value) as BrowserTakeoverState;
  if (typeof takeover.takeoverId !== "string" || !takeover.takeoverId.trim() || Buffer.byteLength(takeover.takeoverId) > 4096
    || takeover.state !== state || takeover.generation !== generation || !Array.isArray(takeover.pages) || takeover.pages.length > 32
    || takeover.pages.some((view) => !isBrowserView(view) || view.generation !== generation)) {
    throw new Error("Browser takeover result identity is invalid");
  }
  return takeover;
}

function isBrowserView(value: unknown): value is BrowserViewIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const view = value as Record<string, unknown>;
  return Number.isSafeInteger(view.generation) && (view.generation as number) > 0
    && typeof view.pageId === "string" && Boolean(view.pageId.trim()) && Buffer.byteLength(view.pageId) <= 4096
    && typeof view.documentId === "string" && Boolean(view.documentId.trim()) && Buffer.byteLength(view.documentId) <= 4096;
}

function canonicalBase64Bytes(value: string): number {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
    || Buffer.from(value, "base64").toString("base64") !== value) throw new Error("Browser request body is not canonical base64");
  return Buffer.from(value, "base64").length;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export * from "./execution-node-controller.js";
export * from "./chromium-cdp-adapter.js";
export * from "./controller-process-runtime.js";
export * from "./chromium-pipe-transport.js";
export * from "./browser-runtime-release.js";
export * from "./chromium-controller-bootstrap.js";
export * from "./chromium-page-runtime.js";
export * from "./node-controller-entry.js";
export * from "./browser-runtime-tree.js";
export * from "./browser-runtime-release-builder.js";
export * from "./browser-runtime-source-lock.js";
export * from "./browser-runtime-archive.js";
export * from "./browser-runtime-source-review.js";
export * from "./browser-runtime-build-attestation.js";
