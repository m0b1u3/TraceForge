import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { permissionProfileFingerprint, resourceLimitsFingerprint, type ExecutionNode, type ProcessDescriptor, type StartProcessRequest } from "@traceforge/execution-node";
import type { BrowserControllerConnection, BrowserControllerPort, BrowserResponseDirective, InterceptedBrowserRequest } from "@traceforge/browser-runtime";
import { parseScenarioPackageDescriptor, type ScenarioToolHostContext } from "@traceforge/scenario-sdk";
import { ScenarioProcessRuntime, type ToolExecutionContext } from "@traceforge/worker-runtime";
import { createScenarioBrowserHandler, type ScenarioBrowserDeployment } from "./scenario-browser-host.js";
import { createDb, getSqliteClient } from "./db/client.js";
import { SqliteBrowserArtifactContent } from "./browser-artifact-content.js";
import { SqliteScenarioArtifactStore } from "./scenario-runtime-state.js";

const owner: ToolExecutionContext = { caseId: "case", runId: "run", workId: "work", workerId: "worker", scopeRef: "scope", leaseId: "lease",
  leaseExpiresAt: "2099-01-01T00:00:00.000Z", idempotencyKey: "first-invocation", effectivePermissions: { version: 1, platform: "linux",
    filesystem: { read: [], write: [], deny: [] }, network: "brokered", process: { access: "sandboxed", interactive: false, background: false }, secrets: "handles_only", sources: ["fixture"] } };
const identity = { protocol: "traceforge.browser-controller.v1" as const, controllerVersion: "1", controllerSha256: "a".repeat(64), browserVersion: "1", browserSha256: "b".repeat(64) };
const input = { operation: "inspect", authorizationAction: "request.observe", url: "https://first.example/", screenshot: true };
function fixture() {
  let current = true; let descriptor: ProcessDescriptor; let intercept: (value: InterceptedBrowserRequest) => Promise<BrowserResponseDirective>;
  const finish = vi.fn(), beforeStart = vi.fn();
  const capacity = { assertOwnership: vi.fn(() => { if (!current) throw new Error("Ownership revoked"); }), acquire: vi.fn(async () => ({ finish, beforeStart })) };
  const startProcess = vi.fn(async (request: StartProcessRequest) => {
    descriptor = { id: "process", nodeId: "node", pid: 1, state: "running", attribution: request.attribution,
      executable: request.executable, arguments: request.arguments, workingDirectory: request.workingDirectory, terminal: null,
      enforcement: { sandboxBackend: "fixture-native", backendMeasurement: "c".repeat(64), sandboxed: true, filesystemPolicyApplied: true,
        permissionProfileFingerprint: permissionProfileFingerprint(request.permissions), resourceLimitsApplied: true,
        resourceLimitsFingerprint: resourceLimitsFingerprint(request.resources), network: "deny" },
      startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), exitedAt: null, exitCode: null, exitSignal: null,
      resourceLimitExceeded: null, capturedOutputBytes: 0, omittedOutputBytes: 0, lastEventSequence: 1 };
    return { process: descriptor, adoptionToken: "fixture-adoption", replayed: false };
  });
  const requestHttp = vi.fn<ExecutionNode["requestHttp"]>(async request => ({ status: 200, headers: [], bodyBase64: "", responseBytes: 0, bodyTruncated: false, replayed: false,
    receipt: { id: "receipt", nodeId: "node", requestId: request.requestId, attribution: request.attribution, authorizationRef: "grant",
      authorizationAction: request.authorizationAction, url: request.url, method: request.method, status: 200, requestBytes: 0, responseBytes: 0,
      responseBodyTruncated: false, permissionProfileFingerprint: permissionProfileFingerprint(request.permissions), redirectFollowed: false,
      startedAt: new Date().toISOString(), completedAt: new Date().toISOString() } }));
  const terminateProcess = vi.fn(async () => ({ ...descriptor, state: "exited" as const }));
  const node = { startProcess, requestHttp, terminateProcess } as unknown as ExecutionNode;
  const view = { generation: 1, pageId: "page", documentId: "document" };
  const connection = { proof: { controlTransport: "pipe", requestInterception: "before_network", browserDirectNetwork: "os_denied", serviceWorkers: "disabled", downloads: "intercepted", webSockets: "intercepted_or_blocked", identity },
    start: async handler => { intercept = handler; }, close: vi.fn(),
    observe: async request => {
      const change = request.kind === "dom" ? { baseSha256: null, added: 0, removed: 0, changed: 0 } : null;
      const bytes = request.kind === "dom" ? Buffer.from(JSON.stringify({ format: 1, view, nodes: [], change, sensitiveValues: "omitted" })) : Buffer.from([137,80,78,71,13,10,26,10]);
      return { kind: request.kind, view, mimeType: request.kind === "dom" ? "application/vnd.traceforge.browser-dom+json" : "image/png",
        bodyBase64: bytes.toString("base64"), byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), summary: { nodeCount: 0, truncated: false, change } };
    }, act: async action => {
      await intercept({ id: "request", url: input.url, method: "GET", headers: {}, kind: "document", initiator: "navigation", frameId: "frame",
        navigationId: "navigation", redirectFromRequestId: null, responseLimitBytes: 4096, timeoutMs: 1000 });
      return { id: action.id, view };
    },
  } as BrowserControllerConnection;
  const controller: BrowserControllerPort = { attach: async () => connection };
  const artifacts = { recordObservation: vi.fn(async value => ({ ref: `artifact:${value.sha256}` })), recordDownload: vi.fn(async () => ({ ref: "artifact:download" })) } satisfies ScenarioBrowserDeployment["artifacts"];
  const deployment: ScenarioBrowserDeployment = { artifacts, prepare: async context => ({ controlTransport: "pipe", controllerIdentity: identity,
    expectedSandboxBackend: "fixture-native", expectedBackendMeasurement: "c".repeat(64), executable: "/fixture/controller", arguments: [], workingDirectory: "/fixture",
    permissions: context.effectivePermissions, resources: { cpuTimeMs: 10000, memoryBytes: 1024 * 1024, maximumProcesses: 8, writeBytes: 1024 }, timeoutMs: 30000, outputLimitBytes: 4096 }) };
  const grant = { id: "grant", caseId: "case", scenarioKind: "fixture", scopePayload: {}, expiresAt: owner.leaseExpiresAt };
  const context = { authorization: { requireAction: () => grant, authorizeResource: (_scope, _case, _action, _kind, url) => {
    if (!url.startsWith("https://first.example/")) throw new Error("Outside scope"); return { ...grant, canonicalValue: url };
  } }, artifacts: { record: vi.fn(value => ({ ...value, id: "artifact-record", createdAt: new Date().toISOString() })), get: () => undefined, list: () => [] } } satisfies Pick<ScenarioToolHostContext, "authorization" | "artifacts">;
  const handler = createScenarioBrowserHandler({ id: "fixture", version: "1" }, context, node, capacity, deployment, () => controller);
  return { handler, context, node, capacity, deployment, controller, startProcess, requestHttp, terminateProcess, finish, artifacts, revoke: () => { current = false; } };
}
describe("Scenario Browser host assembly", () => {
  it("keeps host authorization unchanged while narrowing the child scratch writes", async () => {
    const f = fixture(), original = f.deployment.prepare;
    const invocation = structuredClone(owner);
    invocation.effectivePermissions.filesystem.write = [{ path: "/scratch", scope: "tree" }, { path: "/evidence", scope: "tree" }];
    f.deployment.prepare = async (...args) => ({ ...await original(...args), workingDirectory: "/scratch/first", restrictWritesToWorkingDirectory: true });
    await f.handler.execute(input, invocation, new AbortController().signal);
    expect(f.startProcess.mock.calls[0]![0].permissions.filesystem.write).toEqual([{ path: "/scratch/first", scope: "tree" }]);
    expect(f.requestHttp.mock.calls[0]![0].permissions).toEqual(invocation.effectivePermissions);
    expect(f.terminateProcess).toHaveBeenCalledTimes(1);
  });
  it("does not release another preparation and cleans its own controller-construction failure", async () => {
    const f = fixture(), original = f.deployment.prepare, release = vi.fn(async () => {});
    f.deployment.release = release; f.deployment.prepare = async () => { throw new Error("already prepared"); };
    await expect(f.handler.execute(input, owner, new AbortController().signal)).rejects.toThrow("already prepared");
    expect(release).not.toHaveBeenCalled();
    f.deployment.prepare = original;
    const handler = createScenarioBrowserHandler({ id: "fixture", version: "1" }, f.context, f.node, f.capacity, f.deployment, () => { throw new Error("controller unavailable"); });
    await expect(handler.execute(input, owner, new AbortController().signal)).rejects.toThrow("controller unavailable");
    expect(release).toHaveBeenCalledWith(owner, true); expect(f.startProcess).not.toHaveBeenCalled();
  });
  it("retains actual SQLite content/index and reads bounded evidence without another browser launch", async () => {
    const f = fixture(), sqlite = getSqliteClient(createDb(":memory:"));
    try {
      const beforeDispatch = vi.fn(); f.deployment.beforeDispatch = beforeDispatch;
      const store = new SqliteBrowserArtifactContent(sqlite), context = { ...f.context, artifacts: new SqliteScenarioArtifactStore(sqlite) };
      f.deployment.persistArtifact = store.persistArtifact.bind(store); f.deployment.readContent = store.readBound.bind(store);
      const handler = createScenarioBrowserHandler({ id: "fixture", version: "1" }, context, f.node, f.capacity, f.deployment, () => f.controller);
      const result = await handler.execute(input, owner, new AbortController().signal);
      const artifact = (result.output as any).artifacts[0];
      expect(artifact.contentRef).toMatch(/^browser-content:/);
      const read = { operation: "read", authorizationAction: "request.observe", artifactId: artifact.id, length: 4 };
      const chunk = await handler.execute(read, owner, new AbortController().signal);
      expect(Buffer.from((chunk.output as any).bodyBase64, "base64").length).toBe(4);
      expect((chunk.output as any).nextOffset).toBe(4);
      await expect(handler.execute(read, { ...owner, runId: "other" }, new AbortController().signal)).rejects.toThrow("unavailable");
      const otherPackage = createScenarioBrowserHandler({ id: "other", version: "1" }, context, f.node, f.capacity, f.deployment);
      await expect(otherPackage.execute(read, owner, new AbortController().signal)).rejects.toThrow("unavailable");
      const forged = context.artifacts.record({ ...artifact, packageId: "other", commandId: "forged-index" });
      await expect(otherPackage.execute({ ...read, artifactId: forged.id }, owner, new AbortController().signal)).rejects.toThrow("unavailable");
      await expect(handler.execute({ ...read, offset: 4194304 }, owner, new AbortController().signal)).rejects.toThrow("offset");
      expect(f.startProcess).toHaveBeenCalledTimes(1);
      expect(beforeDispatch).toHaveBeenCalledWith(owner, f.startProcess.mock.calls[0][0].attribution.idempotencyKey);
    } finally { sqlite.close(); }
  });
  it("fails closed without deployment and does not start any process", async () => {
    const f = fixture(); const handler = createScenarioBrowserHandler({ id: "fixture", version: "1" }, f.context, f.node, f.capacity);
    await expect(handler.execute(input, owner, new AbortController().signal)).rejects.toThrow("Browser unavailable");
    expect(f.startProcess).not.toHaveBeenCalled();
  });
  it("connects the actual Scenario process to Browser Runtime, broker receipts and artifacts, then closes", async () => {
    const f = fixture(), root = resolve("scenarios/web-blackbox");
    const descriptor = parseScenarioPackageDescriptor(JSON.parse(readFileSync(resolve(root, "scenario.json"), "utf8")));
    const runtime = new ScenarioProcessRuntime({ manifest: descriptor.runtime!, launch: { executable: process.execPath, arguments: [resolve(root, "runtime/main.mjs")], workingDirectory: root,
      attestation: { sandboxed: false, backend: "test-only", network: "deny" } }, capabilityHandlers: [f.handler,
        ...descriptor.runtime!.hostCapabilities.filter(capability => capability !== f.handler.capability).map(capability => ({ capability, actions: ["unused"], async execute(): Promise<never> { throw new Error("Unused fixture capability"); } }))], transport: { allowUnsandboxedDevelopment: true } });
    try {
      const tool = (await runtime.discover()).find(tool => tool.name === "web.browser.inspect")!;
      const result = await tool.execute({ url: input.url, screenshot: true }, owner);
      expect(JSON.parse(result.raw).validation).toBe("observation_only"); expect(result.refs).toContain("network-receipt:receipt");
      expect(f.startProcess.mock.calls[0][0].permissions.network).toBe("deny");
      expect(f.requestHttp.mock.calls[0][0].permissions.network).toBe("brokered");
      expect(f.artifacts.recordObservation).toHaveBeenCalledTimes(3); expect(f.context.artifacts.record).toHaveBeenCalledTimes(3);
      expect(f.terminateProcess).toHaveBeenCalled(); expect(f.finish).toHaveBeenCalledWith(true);
    } finally { await runtime.close(); }
  });
  it("rejects cross-scope input and executable injection before launch", async () => {
    const f = fixture();
    await expect(f.handler.execute({ ...input, url: "https://second.example/" }, owner, new AbortController().signal)).rejects.toThrow("Outside scope");
    await expect(f.handler.execute({ ...input, executable: "/bad" }, owner, new AbortController().signal)).rejects.toThrow();
    expect(f.startProcess).not.toHaveBeenCalled();
  });
  it("cleans up on revoked ownership and does not send further HTTP", async () => {
    const f = fixture(); f.artifacts.recordObservation.mockImplementationOnce(async value => { f.revoke(); return { ref: `artifact:${value.sha256}` }; });
    await expect(f.handler.execute(input, owner, new AbortController().signal)).rejects.toThrow("Ownership revoked");
    expect(f.requestHttp).not.toHaveBeenCalled(); expect(f.terminateProcess).toHaveBeenCalled(); expect(f.finish).toHaveBeenCalledWith(true);
  });
  it("does not start after cancellation or accept stronger launch permissions", async () => {
    const f = fixture(), abort = new AbortController(); abort.abort();
    await expect(f.handler.execute(input, owner, abort.signal)).rejects.toThrow();
    const prepare = f.deployment.prepare;
    f.deployment.prepare = async (context, signal) => ({ ...await prepare(context, signal), permissions: { ...context.effectivePermissions, network: "direct" } });
    await expect(f.handler.execute(input, owner, new AbortController().signal)).rejects.toThrow("permissions must match");
    expect(f.startProcess).not.toHaveBeenCalled();
  });
  it("retains unknown occupancy and rejects success when cleanup is not confirmed", async () => {
    const f = fixture(); f.terminateProcess.mockRejectedValue(new Error("termination unconfirmed"));
    await expect(f.handler.execute(input, owner, new AbortController().signal)).rejects.toThrow("termination unconfirmed");
    expect(f.finish).toHaveBeenCalledWith(false);
    const second = fixture(); second.terminateProcess.mockImplementation(async () => ({ state: "failed" }) as never);
    await expect(second.handler.execute(input, owner, new AbortController().signal)).rejects.toThrow("unconfirmed");
    expect(second.finish).toHaveBeenCalledWith(false);
  });
});
