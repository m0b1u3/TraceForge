import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  permissionProfileFingerprint,
  resourceLimitsFingerprint,
  type BrokeredHttpRequest,
  type ExecutionNode,
  type ProcessDescriptor,
  type StartProcessRequest,
} from "@traceforge/execution-node";
import type { EffectivePermissionProfile } from "@traceforge/orchestration-core";
import {
  BrokeredBrowserRuntime,
  type BrowserControllerProof,
  type BrowserControllerIdentity,
  type BrowserProcessConfiguration,
  type BrowserResponseDirective,
  type BrowserSessionOwner,
  type BrowserControlAction,
  type BrowserObservationRequest,
  type InterceptedBrowserRequest,
} from "./index.js";

const openedAt = "2026-09-04T02:00:00.000Z";
const leaseExpiresAt = "2026-09-04T03:00:00.000Z";
const controllerIdentity: BrowserControllerIdentity = {
  protocol: "traceforge.browser-controller.v1",
  controllerVersion: "1.0.0",
  controllerSha256: "a".repeat(64),
  browserVersion: "Chromium 140.0.0",
  browserSha256: "b".repeat(64),
};

function owner(patch: Partial<BrowserSessionOwner> = {}): BrowserSessionOwner {
  return {
    caseId: "case_1",
    runId: "run_1",
    workId: "work_1",
    workerId: "worker_1",
    scopeRef: "scope_1",
    leaseId: "lease_1",
    leaseExpiresAt,
    authorizationAction: "browser.network.request",
    ...patch,
  };
}

function permissions(patch: Partial<EffectivePermissionProfile> = {}): EffectivePermissionProfile {
  return {
    version: 1,
    platform: "linux",
    filesystem: { read: [{ path: "/opt/browser", scope: "tree" }], write: [], deny: [] },
    network: "brokered",
    process: { access: "sandboxed", interactive: false, background: false },
    secrets: "handles_only",
    sources: ["test"],
    ...patch,
  };
}

function processConfiguration(patch: Partial<BrowserProcessConfiguration> = {}): BrowserProcessConfiguration {
  return {
    controlTransport: "pipe",
    controllerIdentity,
    expectedSandboxBackend: "test-native",
    expectedBackendMeasurement: "c".repeat(64),
    executable: "/opt/browser/chromium",
    arguments: ["--headless", "--remote-debugging-pipe"],
    workingDirectory: "/opt/browser",
    environment: { LANG: "C.UTF-8" },
    permissions: permissions(),
    resources: { cpuTimeMs: 30_000, memoryBytes: 512 * 1024 * 1024, maximumProcesses: 32, writeBytes: 1024 * 1024 },
    timeoutMs: 60_000,
    outputLimitBytes: 1024 * 1024,
    ...patch,
  };
}

function intercepted(patch: Partial<InterceptedBrowserRequest> = {}): InterceptedBrowserRequest {
  return {
    id: "request_1",
    url: "https://authorized.example/path?secret=must-not-be-snapshotted",
    method: "GET",
    headers: { Accept: "text/html" },
    kind: "document",
    initiator: "navigation",
    frameId: "frame_1",
    navigationId: "navigation_1",
    redirectFromRequestId: null,
    responseLimitBytes: 4096,
    timeoutMs: 10_000,
    ...patch,
  };
}

function descriptor(request: StartProcessRequest, enforcement: Partial<ProcessDescriptor["enforcement"]> = {}): ProcessDescriptor {
  return {
    id: "process_1",
    nodeId: "node_1",
    pid: 1234,
    state: "running",
    attribution: structuredClone(request.attribution),
    executable: request.executable,
    arguments: [...request.arguments],
    workingDirectory: request.workingDirectory,
    terminal: null,
    enforcement: {
      sandboxBackend: "test-native",
      backendMeasurement: "c".repeat(64),
      sandboxed: true,
      filesystemPolicyApplied: true,
      permissionProfileFingerprint: permissionProfileFingerprint(request.permissions),
      resourceLimitsApplied: true,
      resourceLimitsFingerprint: resourceLimitsFingerprint(request.resources),
      network: "deny",
      ...enforcement,
    },
    startedAt: openedAt,
    updatedAt: openedAt,
    exitedAt: null,
    exitCode: null,
    exitSignal: null,
    resourceLimitExceeded: null,
    capturedOutputBytes: 0,
    omittedOutputBytes: 0,
    lastEventSequence: 1,
  };
}

const validProof: BrowserControllerProof = {
  controlTransport: "pipe",
  requestInterception: "before_network",
  browserDirectNetwork: "os_denied",
  serviceWorkers: "disabled",
  downloads: "intercepted",
  webSockets: "intercepted_or_blocked",
  identity: controllerIdentity,
};

function fixture(options: {
  proof?: BrowserControllerProof;
  processEnforcement?: Partial<ProcessDescriptor["enforcement"]>;
  assertCurrent?: () => void;
  now?: () => string;
  artifacts?: boolean;
} = {}) {
  let process: ProcessDescriptor | undefined;
  let intercept: ((request: InterceptedBrowserRequest) => Promise<BrowserResponseDirective>) | undefined;
  let controllerFailure: ((error: Error) => void) | undefined;
  const startProcess = vi.fn(async (request: StartProcessRequest) => {
    process = descriptor(request, options.processEnforcement);
    return { process, adoptionToken: "adopt_1", replayed: false };
  });
  const requestHttp = vi.fn(async (request: BrokeredHttpRequest) => {
    const body = Buffer.from("redirect", "utf8");
    return {
      receipt: {
        id: `receipt_${request.requestId}`,
        nodeId: "node_1",
        requestId: request.requestId,
        attribution: structuredClone(request.attribution),
        authorizationRef: "node_authorization_1",
        authorizationAction: request.authorizationAction,
        url: request.url,
        method: request.method,
        status: 302,
        requestBytes: request.bodyBase64 ? Buffer.from(request.bodyBase64, "base64").length : 0,
        responseBytes: body.length,
        responseBodyTruncated: false,
        permissionProfileFingerprint: permissionProfileFingerprint(request.permissions),
        redirectFollowed: false as const,
        startedAt: openedAt,
        completedAt: openedAt,
      },
      status: 302,
      headers: [{ name: "location", value: "https://authorized.example/next" }],
      bodyBase64: body.toString("base64"),
      responseBytes: body.length,
      bodyTruncated: false,
      replayed: false,
    };
  });
  const terminateProcess = vi.fn(async () => {
    if (!process) throw new Error("process was not started");
    return { ...process, state: "exited" as const, exitedAt: openedAt };
  });
  const executionNode = { startProcess, requestHttp, terminateProcess } as unknown as ExecutionNode;
  const close = vi.fn(async () => undefined);
  let interactionGeneration = 1;
  let takeoverId: string | null = null;
  const start = vi.fn(async (handler: typeof intercept, onFailure: (error: Error) => void) => {
    intercept = handler;
    controllerFailure = onFailure;
  });
  const observe = vi.fn(async (request: BrowserObservationRequest) => {
    const view = { generation: interactionGeneration, pageId: "page_1", documentId: "document_1" };
    const change = request.kind === "dom" ? { baseSha256: null, added: 0, removed: 0, changed: 0 } : null;
    const observationBody = request.kind === "dom"
      ? Buffer.from(JSON.stringify({ format: 1, view, nodes: [], change, sensitiveValues: "omitted" }))
      : Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    return {
      kind: request.kind,
      view,
      mimeType: request.kind === "dom" as const ? "application/vnd.traceforge.browser-dom+json" as const : "image/png" as const,
      bodyBase64: observationBody.toString("base64"),
      byteSize: observationBody.length,
      sha256: createHash("sha256").update(observationBody).digest("hex"),
      summary: { nodeCount: 0, truncated: false, change },
    };
  });
  const act = vi.fn(async (action: BrowserControlAction) => ({ id: action.id,
    view: { generation: interactionGeneration, pageId: "page_1", documentId: "document_1" } }));
  const observeManual = vi.fn(async (id: string, request: BrowserObservationRequest) => {
    if (id !== takeoverId) throw new Error("stale takeover");
    return observe(request);
  });
  const actManual = vi.fn(async (id: string, action: BrowserControlAction) => {
    if (id !== takeoverId) throw new Error("stale takeover");
    return act(action);
  });
  const beginTakeover = vi.fn(async () => {
    interactionGeneration += 1;
    takeoverId = "takeover_1";
    return { takeoverId, generation: interactionGeneration, state: "manual_control" as const,
      pages: [{ generation: interactionGeneration, pageId: "page_1", documentId: "document_1" }] };
  });
  const resumeTakeover = vi.fn(async (id: string) => {
    if (id !== takeoverId) throw new Error("stale takeover");
    interactionGeneration += 1;
    return { takeoverId: id, generation: interactionGeneration, state: "agent_control" as const,
      pages: [{ generation: interactionGeneration, pageId: "page_1", documentId: "document_2" }] };
  });
  const attach = vi.fn(async () => ({ proof: options.proof ?? validProof, start, observe, act, observeManual, actManual,
    beginTakeover, resumeTakeover, close }));
  const assertSessionCurrent = vi.fn(options.assertCurrent ?? (() => undefined));
  const authorizeRequest = vi.fn(async (input: { url: string }) => ({
    authorizationRef: "browser_authorization_1",
    canonicalUrl: new URL(input.url).href,
    expiresAt: leaseExpiresAt,
  }));
  const recordDownload = vi.fn(async () => ({ ref: "artifact_download_1" }));
  const recordObservation = vi.fn(async () => ({ ref: "artifact_observation_1" }));
  const runtime = new BrokeredBrowserRuntime({
    executionNode,
    controller: { attach },
    authorization: { assertSessionCurrent, authorizeRequest },
    ...(options.artifacts === false ? {} : { artifacts: { recordDownload, recordObservation } }),
    now: options.now ?? (() => openedAt),
    createId: () => "session_1",
  });
  return {
    runtime,
    startProcess,
    requestHttp,
    terminateProcess,
    attach,
    start,
    close,
    assertSessionCurrent,
    authorizeRequest,
    recordDownload,
    recordObservation,
    observe,
    act,
    observeManual,
    actManual,
    beginTakeover,
    resumeTakeover,
    invoke: (request: InterceptedBrowserRequest) => {
      if (!intercept) throw new Error("controller was not started");
      return intercept(request);
    },
    failController: (error: Error) => {
      if (!controllerFailure) throw new Error("controller was not started");
      controllerFailure(error);
    },
  };
}

describe("Brokered Browser Runtime", () => {
  it("denies browser OS networking and brokers navigation, redirects, popups, frames, fetch/XHR and downloads one request at a time", async () => {
    const subject = fixture();
    const session = await subject.runtime.open(owner(), processConfiguration());

    expect(subject.startProcess).toHaveBeenCalledWith(expect.objectContaining({
      stdin: "pipe",
      permissions: expect.objectContaining({ network: "deny", process: expect.objectContaining({ access: "sandboxed" }) }),
    }));
    expect(subject.attach).toHaveBeenCalledOnce();
    expect(subject.start).toHaveBeenCalledOnce();

    const requests: InterceptedBrowserRequest[] = [
      intercepted(),
      intercepted({ id: "request_2", initiator: "redirect", redirectFromRequestId: "request_1" }),
      intercepted({ id: "request_3", initiator: "popup", frameId: "popup_1", navigationId: "navigation_2" }),
      intercepted({ id: "request_4", kind: "iframe", initiator: "subresource", frameId: "frame_2" }),
      intercepted({ id: "request_5", kind: "fetch", initiator: "background" }),
      intercepted({ id: "request_6", kind: "xhr", initiator: "background" }),
      intercepted({ id: "request_7", kind: "download", initiator: "navigation" }),
    ];
    for (const request of requests) {
      await expect(subject.invoke(request)).resolves.toMatchObject({
        action: "fulfill",
        requestId: request.id,
        status: 302,
      });
    }

    expect(subject.authorizeRequest).toHaveBeenCalledTimes(requests.length);
    expect(subject.requestHttp).toHaveBeenCalledTimes(requests.length);
    for (const [request] of subject.requestHttp.mock.calls) {
      expect(request.permissions.network).toBe("brokered");
      expect(request.attribution).toMatchObject({ caseId: "case_1", runId: "run_1", workId: "work_1", leaseId: "lease_1" });
    }
    expect(subject.recordDownload).toHaveBeenCalledOnce();
    expect(subject.recordDownload).toHaveBeenCalledWith(expect.objectContaining({
      byteSize: 8,
      sha256: "093452239d0e2e43b06b9d5cd8ac735c26449e340e001f87904765bb30e2293e",
    }));

    const snapshot = subject.runtime.snapshot(session.id)!;
    expect(snapshot.records).toHaveLength(requests.length);
    expect(snapshot.records[2]).toMatchObject({ initiator: "popup", origin: "https://authorized.example" });
    expect(JSON.stringify(snapshot)).not.toContain("must-not-be-snapshotted");

    await subject.runtime.close(session.id);
    await subject.runtime.close(session.id);
    expect(subject.close).toHaveBeenCalledOnce();
    expect(subject.terminateProcess).toHaveBeenCalledOnce();
  });

  it("authorizes but blocks WebSocket streams until a bounded streaming broker exists", async () => {
    const subject = fixture();
    const session = await subject.runtime.open(owner(), processConfiguration());
    await expect(subject.invoke(intercepted({ kind: "websocket", initiator: "background" }))).resolves.toEqual({
      action: "block",
      requestId: "request_1",
      reason: "websocket_streaming_unavailable",
    });
    expect(subject.authorizeRequest).toHaveBeenCalledOnce();
    expect(subject.requestHttp).not.toHaveBeenCalled();
    expect(subject.runtime.snapshot(session.id)?.records[0]).toMatchObject({ outcome: "blocked", kind: "websocket" });
  });

  it("rejects direct or absent host network authority, unrestricted execution and ambient proxy channels before launch", async () => {
    const variants: BrowserProcessConfiguration[] = [
      processConfiguration({ permissions: permissions({ network: "direct" }) }),
      processConfiguration({ permissions: permissions({ network: "deny" }) }),
      processConfiguration({ permissions: permissions({ process: { access: "unrestricted", interactive: false, background: false } }) }),
      processConfiguration({ environment: { Https_Proxy: "http://127.0.0.1:8080" } }),
      processConfiguration({ arguments: ["--remote-debugging-pipe", "--no-sandbox"] }),
    ];
    for (const configuration of variants) {
      const subject = fixture();
      await expect(subject.runtime.open(owner(), configuration)).rejects.toThrow(/brokered|sandbox|proxy/i);
      expect(subject.startProcess).not.toHaveBeenCalled();
    }
  });

  it("terminates the process when native enforcement or controller interception proof is incomplete", async () => {
    const weakProcess = fixture({ processEnforcement: { network: "brokered" } });
    await expect(weakProcess.runtime.open(owner(), processConfiguration())).rejects.toThrow(/OS-enforced sandbox/);
    expect(weakProcess.terminateProcess).toHaveBeenCalledOnce();

    const weakController = fixture({ proof: { ...validProof, serviceWorkers: "enabled" as "disabled" } });
    await expect(weakController.runtime.open(owner(), processConfiguration())).rejects.toThrow(/complete pre-network interception/);
    expect(weakController.start).not.toHaveBeenCalled();
    expect(weakController.close).toHaveBeenCalledOnce();
    expect(weakController.terminateProcess).toHaveBeenCalledOnce();
  });

  it("freezes and kills the browser when ownership becomes stale after a brokered effect", async () => {
    let checks = 0;
    const subject = fixture({ assertCurrent: () => {
      checks += 1;
      if (checks >= 3) throw new Error("lease is no longer current");
    } });
    const session = await subject.runtime.open(owner(), processConfiguration());

    await expect(subject.invoke(intercepted())).rejects.toThrow(/no longer current/);
    expect(subject.requestHttp).toHaveBeenCalledOnce();
    expect(subject.runtime.snapshot(session.id)).toMatchObject({ status: "frozen", records: [] });
    expect(subject.close).toHaveBeenCalledOnce();
    expect(subject.terminateProcess).toHaveBeenCalledOnce();
  });

  it("replays completed interceptions, fails closed on changed IDs and enforces session lifetime", async () => {
    let clock = openedAt;
    const subject = fixture({ now: () => clock });
    const session = await subject.runtime.open(owner(), processConfiguration());
    const request = intercepted({ headers: { Accept: "text/html", "X-Test": "1" } });
    const first = await subject.invoke(request);
    const replay = await subject.invoke(intercepted({ headers: { "X-Test": "1", Accept: "text/html" } }));
    expect(replay).toEqual(first);
    expect(subject.requestHttp).toHaveBeenCalledOnce();
    expect(subject.authorizeRequest).toHaveBeenCalledOnce();
    await expect(subject.invoke(intercepted({ headers: { Accept: "application/json" } }))).rejects.toThrow(/different input/);

    clock = leaseExpiresAt;
    await expect(subject.invoke(intercepted({ id: "request_2" }))).rejects.toThrow(/expired/);
    expect(subject.runtime.snapshot(session.id)?.status).toBe("frozen");
  });

  it("never returns a downloaded body when durable Artifact recording is unavailable", async () => {
    const subject = fixture({ artifacts: false });
    await subject.runtime.open(owner(), processConfiguration());
    await expect(subject.invoke(intercepted({ kind: "download" }))).rejects.toThrow(/Artifact port/);
    expect(subject.requestHttp).toHaveBeenCalledOnce();
    await expect(subject.invoke(intercepted({ kind: "download" }))).rejects.toThrow(/uncertain prior result/);
  });

  it("records an attachment response as an Artifact even when Chromium classified its initiating request as a document", async () => {
    const subject = fixture();
    await subject.runtime.open(owner(), processConfiguration());
    const implementation = subject.requestHttp.getMockImplementation()!;
    subject.requestHttp.mockImplementationOnce(async (request) => ({
      ...(await implementation(request)),
      headers: [{ name: "content-disposition", value: "attachment; filename=result.bin" }],
    }));
    await expect(subject.invoke(intercepted({ kind: "document" }))).resolves.toMatchObject({ artifactRef: "artifact_download_1" });
    expect(subject.recordDownload).toHaveBeenCalledOnce();
  });

  it("stores DOM observations as bounded Artifacts and replays completed control actions by stable id", async () => {
    const subject = fixture();
    const session = await subject.runtime.open(owner(), processConfiguration());
    const observation = await subject.runtime.observe(session.id, { kind: "dom" });
    expect(observation).toMatchObject({
      kind: "dom",
      artifactRef: "artifact_observation_1",
      view: { generation: 1, pageId: "page_1", documentId: "document_1" },
    });
    expect(observation).not.toHaveProperty("bodyBase64");
    expect(subject.recordObservation).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: session.id,
      kind: "dom",
      byteSize: expect.any(Number),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    const element = { view: observation.view, backendNodeId: 11 };
    const action = { id: "action_1", kind: "click" as const, element };
    const first = await subject.runtime.act(session.id, action);
    const replay = await subject.runtime.act(session.id, action);
    expect(replay).toEqual(first);
    expect(subject.act).toHaveBeenCalledOnce();
    await expect(subject.runtime.act(session.id, { ...action, kind: "fill", text: "different" }))
      .rejects.toThrow("reused with different input");
    expect(subject.runtime.snapshot(session.id)).toMatchObject({ observationCount: 1, actionCount: 1,
      observations: [{ artifactRef: "artifact_observation_1" }],
      actions: [{ id: "action_1", kind: "click", origin: "agent", inputSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }] });
  });

  it("keeps brokered networking active during manual control and invalidates every pre-takeover element reference", async () => {
    const subject = fixture();
    const session = await subject.runtime.open(owner(), processConfiguration());
    const observation = await subject.runtime.observe(session.id, { kind: "dom" });
    const oldElement = { view: observation.view, backendNodeId: 11 };
    const handedOff = await subject.runtime.beginManualControl(session.id);
    expect(handedOff).toMatchObject({ state: "manual_control", generation: 2, takeoverId: "takeover_1" });
    expect(subject.runtime.snapshot(session.id)).toMatchObject({ status: "manual_control", interactionGeneration: 2 });
    await expect(subject.runtime.observe(session.id, { kind: "dom" })).rejects.toThrow("not under agent control");
    await expect(subject.runtime.act(session.id, { id: "old_action", kind: "click", element: oldElement }))
      .rejects.toThrow("not under agent control");
    await expect(subject.runtime.observeManual(session.id, "wrong", { kind: "dom" })).rejects.toThrow("stale or invalid");
    const manualObservation = await subject.runtime.observeManual(session.id, handedOff.takeoverId, { kind: "dom" });
    await expect(subject.runtime.actManual(session.id, handedOff.takeoverId, { id: "manual_action", kind: "click",
      element: { view: manualObservation.view, backendNodeId: 12 } })).resolves.toMatchObject({
      id: "manual_action", view: { generation: 2 },
    });
    expect(subject.observeManual).toHaveBeenCalledOnce();
    expect(subject.actManual).toHaveBeenCalledOnce();

    await expect(subject.invoke(intercepted({ id: "manual_navigation" }))).resolves.toMatchObject({ action: "fulfill" });
    await expect(subject.runtime.resumeManualControl(session.id, "wrong")).rejects.toThrow("stale or invalid");
    const resumed = await subject.runtime.resumeManualControl(session.id, handedOff.takeoverId);
    expect(resumed).toMatchObject({ state: "agent_control", generation: 3 });
    expect(subject.runtime.snapshot(session.id)).toMatchObject({ status: "active", interactionGeneration: 3, takeoverId: null });
    expect(subject.runtime.snapshot(session.id)?.controlTransitions).toEqual([
      expect.objectContaining({ takeoverId: "takeover_1", state: "manual_control", generation: 2 }),
      expect.objectContaining({ takeoverId: "takeover_1", state: "agent_control", generation: 3 }),
    ]);
    expect(subject.runtime.snapshot(session.id)?.actions).toEqual([
      expect.objectContaining({ id: "manual_action", origin: "manual" }),
    ]);
    await expect(subject.runtime.act(session.id, { id: "stale_manual_action", kind: "click",
      element: { view: manualObservation.view, backendNodeId: 12 } })).rejects.toThrow("stale element reference");
    await expect(subject.runtime.act(session.id, { id: "stale_after_resume", kind: "click", element: oldElement }))
      .rejects.toThrow("stale element reference");
    await expect(subject.runtime.observe(session.id, { kind: "dom" })).resolves.toMatchObject({
      view: { generation: 3, documentId: "document_1" },
    });
  });

  it("freezes the browser when Controller observation bytes or action identities cannot be trusted", async () => {
    const invalidObservation = fixture();
    const first = await invalidObservation.runtime.open(owner(), processConfiguration());
    invalidObservation.observe.mockResolvedValueOnce({
      kind: "dom",
      view: { generation: 1, pageId: "page_1", documentId: "document_1" },
      mimeType: "application/vnd.traceforge.browser-dom+json",
      bodyBase64: Buffer.from("{}").toString("base64"),
      byteSize: 2,
      sha256: "f".repeat(64),
      summary: { nodeCount: 0, truncated: false, change: { baseSha256: null, added: 0, removed: 0, changed: 0 } },
    });
    await expect(invalidObservation.runtime.observe(first.id, { kind: "dom" })).rejects.toThrow("bounded identity");
    expect(invalidObservation.runtime.snapshot(first.id)?.status).toBe("frozen");
    expect(invalidObservation.terminateProcess).toHaveBeenCalledOnce();

    const invalidAction = fixture();
    const second = await invalidAction.runtime.open(owner(), processConfiguration());
    const observation = await invalidAction.runtime.observe(second.id, { kind: "dom" });
    invalidAction.act.mockResolvedValueOnce({ id: "different_action",
      view: { generation: 1, pageId: "page_1", documentId: "document_1" } });
    await expect(invalidAction.runtime.act(second.id, { id: "action_1", kind: "click",
      element: { view: observation.view, backendNodeId: 11 } })).rejects.toThrow("result identity");
    expect(invalidAction.runtime.snapshot(second.id)?.status).toBe("frozen");
    expect(invalidAction.terminateProcess).toHaveBeenCalledOnce();
  });

  it("still terminates the OS process when controller shutdown fails and retries unfinished cleanup", async () => {
    const subject = fixture();
    const session = await subject.runtime.open(owner(), processConfiguration());
    subject.close.mockRejectedValueOnce(new Error("controller pipe failed"));

    await expect(subject.runtime.close(session.id)).rejects.toThrow(/controller pipe failed/);
    expect(subject.terminateProcess).toHaveBeenCalledOnce();
    await expect(subject.runtime.close(session.id)).resolves.toMatchObject({ status: "closed" });
    expect(subject.close).toHaveBeenCalledTimes(2);
    expect(subject.terminateProcess).toHaveBeenCalledOnce();
  });

  it("freezes and terminates the session when the controller transport fails asynchronously", async () => {
    const subject = fixture();
    const session = await subject.runtime.open(owner(), processConfiguration());
    subject.failController(new Error("protocol stream lost"));
    await vi.waitFor(() => expect(subject.runtime.snapshot(session.id)?.status).toBe("frozen"));
    expect(subject.close).toHaveBeenCalledOnce();
    expect(subject.terminateProcess).toHaveBeenCalledOnce();
  });
});
