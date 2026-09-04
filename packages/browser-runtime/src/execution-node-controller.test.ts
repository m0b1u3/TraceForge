import { describe, expect, it, vi } from "vitest";
import type {
  ExecutionNode,
  ProcessDescriptor,
  ProcessEvent,
  ReadProcessEventsRequest,
  WriteProcessInputRequest,
} from "@traceforge/execution-node";
import {
  BROWSER_CONTROLLER_PROTOCOL,
  ExecutionNodeBrowserController,
  LengthPrefixedJsonDecoder,
  encodeLengthPrefixedJson,
} from "./execution-node-controller.js";
import type {
  BrowserControllerIdentity,
  BrowserControllerProof,
  BrowserResponseDirective,
  InterceptedBrowserRequest,
} from "./index.js";

const identity: BrowserControllerIdentity = {
  protocol: BROWSER_CONTROLLER_PROTOCOL,
  controllerVersion: "1.0.0",
  controllerSha256: "a".repeat(64),
  browserVersion: "Chromium 140.0.0",
  browserSha256: "b".repeat(64),
};
const proof: BrowserControllerProof = {
  controlTransport: "pipe",
  requestInterception: "before_network",
  browserDirectNetwork: "os_denied",
  serviceWorkers: "disabled",
  downloads: "intercepted",
  webSockets: "intercepted_or_blocked",
  identity,
};
const request: InterceptedBrowserRequest = {
  id: "browser_request_1",
  url: "https://authorized.example/",
  method: "GET",
  headers: { Accept: "text/html" },
  kind: "document",
  initiator: "navigation",
  frameId: "frame_1",
  navigationId: "navigation_1",
  redirectFromRequestId: null,
  responseLimitBytes: 4096,
  timeoutMs: 1000,
};

class FakeControllerNode {
  descriptor: ProcessDescriptor = {
    id: "process_1",
    nodeId: "node_1",
    pid: 42,
    state: "running",
    attribution: {
      caseId: "case_1", runId: "run_1", workId: "work_1", workerId: "worker_1", scopeRef: "scope_1",
      leaseId: "lease_1", leaseExpiresAt: "2100-01-01T00:00:00.000Z", actionId: "start", idempotencyKey: "start",
    },
    executable: "/opt/traceforge/browser-controller",
    arguments: [],
    workingDirectory: "/opt/traceforge",
    terminal: null,
    enforcement: {
      sandboxBackend: "linux-native", sandboxed: true, filesystemPolicyApplied: true,
      permissionProfileFingerprint: "a".repeat(64), resourceLimitsApplied: true,
      resourceLimitsFingerprint: "b".repeat(64), network: "deny",
    },
    startedAt: "2026-09-04T00:00:00.000Z", updatedAt: "2026-09-04T00:00:00.000Z", exitedAt: null,
    exitCode: null, exitSignal: null, resourceLimitExceeded: null, capturedOutputBytes: 0, omittedOutputBytes: 0, lastEventSequence: 0,
  };
  readonly writes: unknown[] = [];
  readonly requestResults: unknown[] = [];
  lostEvents = false;
  private sequence = 0;
  private events: ProcessEvent[] = [];
  private waiter: (() => void) | undefined;
  private interactionGeneration = 1;
  private readonly decoder = new LengthPrefixedJsonDecoder(1024 * 1024, 2 * 1024 * 1024);

  constructor(readyProof: BrowserControllerProof = proof) {
    this.emit({ protocol: BROWSER_CONTROLLER_PROTOCOL, type: "ready", proof: readyProof });
  }

  asNode(): ExecutionNode {
    return {
      waitProcessEvents: (input: ReadProcessEventsRequest) => this.wait(input),
      writeProcessInput: (input: WriteProcessInputRequest) => this.write(input),
    } as unknown as ExecutionNode;
  }

  failProcess(): void {
    this.descriptor = { ...this.descriptor, state: "failed", exitCode: 1, exitedAt: "2026-09-04T00:01:00.000Z" };
    this.waiter?.();
    this.waiter = undefined;
  }

  emitInvalid(value: unknown): void {
    this.emit(value);
  }

  private async wait(input: ReadProcessEventsRequest) {
    if (!this.events.some((event) => event.sequence > input.afterSequence) && this.descriptor.state === "running") {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5);
        this.waiter = () => { clearTimeout(timer); resolve(); };
      });
      this.waiter = undefined;
    }
    const events = this.events.filter((event) => event.sequence > input.afterSequence);
    return { process: this.descriptor, events, nextSequence: events.at(-1)?.sequence ?? input.afterSequence, lostEvents: this.lostEvents };
  }

  private async write(input: WriteProcessInputRequest): Promise<ProcessDescriptor> {
    for (const frame of this.decoder.push(Buffer.from(input.dataBase64, "base64"))) {
      this.writes.push(frame);
      const value = frame as { type: string; id: string; command?: string; input?: Record<string, unknown> };
      if (value.type === "command" && value.command === "activate") {
        const response = encodeLengthPrefixedJson({
          protocol: BROWSER_CONTROLLER_PROTOCOL, type: "response", id: value.id, ok: true, result: { active: true },
        }, 1024 * 1024);
        const browserRequest = encodeLengthPrefixedJson({
          protocol: BROWSER_CONTROLLER_PROTOCOL, type: "request", id: "wire_request_1", request,
        }, 1024 * 1024);
        this.emitBytes(Buffer.concat([response, browserRequest]));
      } else if (value.type === "command" && value.command === "shutdown") {
        this.emit({ protocol: BROWSER_CONTROLLER_PROTOCOL, type: "response", id: value.id, ok: true, result: { closed: true } });
      } else if (value.type === "command" && (value.command === "observe" || value.command === "manual_observe")) {
        const body = Buffer.from("{}");
        this.emit({ protocol: BROWSER_CONTROLLER_PROTOCOL, type: "response", id: value.id, ok: true, result: {
          kind: "dom", view: { generation: this.interactionGeneration, pageId: "page_1", documentId: "document_1" },
          mimeType: "application/vnd.traceforge.browser-dom+json", bodyBase64: body.toString("base64"), byteSize: body.length,
          sha256: "c".repeat(64), summary: { nodeCount: 0, truncated: false,
            change: { baseSha256: null, added: 0, removed: 0, changed: 0 } },
        } });
      } else if (value.type === "command" && (value.command === "act" || value.command === "manual_act")) {
        const action = value.command === "manual_act" ? value.input?.action as Record<string, unknown> : value.input;
        this.emit({ protocol: BROWSER_CONTROLLER_PROTOCOL, type: "response", id: value.id, ok: true, result: {
          id: action?.id, view: { generation: this.interactionGeneration, pageId: "page_1", documentId: "document_1" },
        } });
      } else if (value.type === "command" && value.command === "begin_takeover") {
        this.interactionGeneration += 1;
        this.emit({ protocol: BROWSER_CONTROLLER_PROTOCOL, type: "response", id: value.id, ok: true, result: {
          takeoverId: "takeover_1", generation: this.interactionGeneration, state: "manual_control", pages: [],
        } });
      } else if (value.type === "command" && value.command === "resume_takeover") {
        this.interactionGeneration += 1;
        this.emit({ protocol: BROWSER_CONTROLLER_PROTOCOL, type: "response", id: value.id, ok: true, result: {
          takeoverId: value.input?.takeoverId, generation: this.interactionGeneration, state: "agent_control", pages: [],
        } });
      } else if (value.type === "request_result") {
        this.requestResults.push(frame);
      }
    }
    return this.descriptor;
  }

  private emit(value: unknown): void {
    this.emitBytes(encodeLengthPrefixedJson(value, 1024 * 1024));
  }

  private emitBytes(data: Buffer): void {
    const sequence = ++this.sequence;
    this.events.push({ type: "process.output", processId: this.descriptor.id, sequence,
      at: "2026-09-04T00:00:01.000Z", stream: "stdout", dataBase64: data.toString("base64"), bytes: data.length });
    this.descriptor = { ...this.descriptor, lastEventSequence: sequence };
    this.waiter?.();
    this.waiter = undefined;
  }
}

function controller(node: FakeControllerNode) {
  return new ExecutionNodeBrowserController({
    executionNode: node.asNode(),
    handshakeTimeoutMs: 100,
    commandTimeoutMs: 100,
    waitIntervalMs: 5,
    createId: (() => { let value = 0; return () => String(++value); })(),
  });
}

async function eventually(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    try { assertion(); return; } catch { await new Promise((resolve) => setTimeout(resolve, 5)); }
  }
  assertion();
}

describe("Execution Node Browser Controller", () => {
  it("handshakes before activation, handles a request in the activation batch and returns a framed directive", async () => {
    const node = new FakeControllerNode();
    const connection = await controller(node).attach({
      sessionId: "session_1", process: node.descriptor, access: { processId: "process_1", adoptionToken: "adopt_1" }, expectedIdentity: identity,
    });
    const intercept = vi.fn(async (): Promise<BrowserResponseDirective> => ({
      action: "fulfill", requestId: request.id, status: 200, headers: [], bodyBase64: "", receiptRef: "receipt_1", artifactRef: null,
    }));
    const failed = vi.fn();
    await connection.start(intercept, failed);
    await eventually(() => expect(node.requestResults).toHaveLength(1));

    expect(connection.proof).toEqual(proof);
    expect(intercept).toHaveBeenCalledWith(request);
    expect(node.requestResults[0]).toMatchObject({ type: "request_result", id: "wire_request_1", ok: true,
      directive: { action: "fulfill", receiptRef: "receipt_1" } });
    expect(failed).not.toHaveBeenCalled();
    await connection.close("done");
  });

  it("rejects a self-reported identity that does not match reviewed launch material", async () => {
    const different = { ...identity, browserSha256: "c".repeat(64) };
    const node = new FakeControllerNode({ ...proof, identity: different });
    await expect(controller(node).attach({
      sessionId: "session_1", process: node.descriptor, access: { processId: "process_1", adoptionToken: "adopt_1" }, expectedIdentity: identity,
    })).rejects.toThrow(/identity/);
  });

  it("reports process failure after activation so the Browser Runtime can freeze the session", async () => {
    const node = new FakeControllerNode();
    const connection = await controller(node).attach({
      sessionId: "session_1", process: node.descriptor, access: { processId: "process_1", adoptionToken: "adopt_1" }, expectedIdentity: identity,
    });
    const failure = new Promise<Error>((resolve) => {
      void connection.start(async () => ({ action: "block", requestId: request.id, reason: "policy_denied" }), resolve);
    });
    await eventually(() => expect(node.requestResults).toHaveLength(1));
    node.failProcess();
    expect((await failure).message).toMatch(/process failed/);
  });

  it("carries page observation, stable-reference actions and takeover generations through Execution Node stdin/stdout", async () => {
    const node = new FakeControllerNode();
    const connection = await controller(node).attach({
      sessionId: "session_1", process: node.descriptor, access: { processId: "process_1", adoptionToken: "adopt_1" }, expectedIdentity: identity,
    });
    await connection.start(async () => ({ action: "block", requestId: request.id, reason: "policy_denied" }), () => undefined);
    const observation = await connection.observe({ kind: "dom" });
    expect(observation).toMatchObject({ kind: "dom", view: { generation: 1, documentId: "document_1" } });
    const action = await connection.act({ id: "action_1", kind: "navigate",
      view: { generation: 1, pageId: "page_1", documentId: "document_1" }, url: "https://authorized.example/" });
    expect(action).toMatchObject({ id: "action_1", view: { generation: 1 } });
    const handoff = await connection.beginTakeover();
    expect(handoff).toMatchObject({ takeoverId: "takeover_1", generation: 2, state: "manual_control" });
    await expect(connection.observeManual(handoff.takeoverId, { kind: "dom" })).resolves.toMatchObject({
      view: { generation: 2 },
    });
    await expect(connection.actManual(handoff.takeoverId, { id: "manual_action", kind: "navigate",
      view: { generation: 2, pageId: "page_1", documentId: "document_1" }, url: "https://authorized.example/" }))
      .resolves.toMatchObject({ id: "manual_action", view: { generation: 2 } });
    await expect(connection.resumeTakeover(handoff.takeoverId)).resolves.toMatchObject({ generation: 3, state: "agent_control" });
    expect(node.writes.filter((value) => (value as { type?: string }).type === "command").map((value) =>
      (value as { command?: string }).command)).toEqual(expect.arrayContaining([
      "activate", "observe", "act", "begin_takeover", "manual_observe", "manual_act", "resume_takeover",
    ]));
    await connection.close("done");
  });

  it("does not write a late interception result after the controller generation fails", async () => {
    const node = new FakeControllerNode();
    const connection = await controller(node).attach({
      sessionId: "session_1", process: node.descriptor, access: { processId: "process_1", adoptionToken: "adopt_1" }, expectedIdentity: identity,
    });
    let release!: (value: BrowserResponseDirective) => void;
    const deferred = new Promise<BrowserResponseDirective>((resolve) => { release = resolve; });
    const failure = new Promise<Error>((resolve) => { void connection.start(() => deferred, resolve); });
    await eventually(() => expect(node.writes.some((value) => (value as { command?: string }).command === "activate")).toBe(true));
    node.failProcess();
    expect((await failure).message).toMatch(/process failed/);
    release({ action: "block", requestId: request.id, reason: "policy_denied" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(node.requestResults).toHaveLength(0);
  });

  it("fails closed on lost protocol bytes and invalid frames", async () => {
    const lost = new FakeControllerNode();
    lost.lostEvents = true;
    await expect(controller(lost).attach({
      sessionId: "session_1", process: lost.descriptor, access: { processId: "process_1", adoptionToken: "adopt_1" }, expectedIdentity: identity,
    })).rejects.toThrow(/lost protocol bytes/);

    const invalid = new FakeControllerNode();
    const connection = await controller(invalid).attach({
      sessionId: "session_1", process: invalid.descriptor, access: { processId: "process_1", adoptionToken: "adopt_1" }, expectedIdentity: identity,
    });
    const failure = new Promise<Error>((resolve) => {
      void connection.start(async () => ({ action: "block", requestId: request.id, reason: "policy_denied" }), resolve);
    });
    await eventually(() => expect(invalid.requestResults).toHaveLength(1));
    invalid.emitInvalid({ protocol: BROWSER_CONTROLLER_PROTOCOL, type: "unknown" });
    expect((await failure).message).toMatch(/unsupported protocol frame/);
  });

  it("bounds fragmented frames and rejects oversized declarations", () => {
    const frame = encodeLengthPrefixedJson({ ok: true }, 1024);
    const decoder = new LengthPrefixedJsonDecoder(1024, 2048);
    expect(decoder.push(frame.subarray(0, 3))).toEqual([]);
    expect(decoder.push(frame.subarray(3))).toEqual([{ ok: true }]);
    const oversized = Buffer.alloc(4);
    oversized.writeUInt32BE(1025);
    expect(() => decoder.push(oversized)).toThrow(/length/);
  });
});
