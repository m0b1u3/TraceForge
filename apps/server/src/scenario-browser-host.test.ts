import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { permissionProfileFingerprint, resourceLimitsFingerprint, type ExecutionNode, type ProcessDescriptor, type StartProcessRequest } from "@traceforge/execution-node";
import type { BrowserControllerConnection, BrowserControllerPort, BrowserResponseDirective, InterceptedBrowserRequest } from "@traceforge/browser-runtime";
import { parseScenarioPackageDescriptor, type ScenarioToolHostContext } from "@traceforge/scenario-sdk";
import { ScenarioProcessRuntime, PolicyExecutionToolGateway, createExecutionToolRegistry, type ToolExecutionContext } from "@traceforge/worker-runtime";
import { RunToolPolicy } from "./run-tool-policy.js";
import { assignment } from "../../../packages/worker-runtime/src/test-fixtures.js";
import type { SqliteScenarioAuthorizationService } from "./scenario-authorization.js";
import { createScenarioBrowserHandler, type ScenarioBrowserDeployment } from "./scenario-browser-host.js";
import { createDb, getSqliteClient } from "./db/client.js";
import { SqliteBrowserArtifactContent } from "./browser-artifact-content.js";
import { SqliteScenarioArtifactStore } from "./scenario-runtime-state.js";
import { DesktopBrowserSessions } from "./desktop-browser-sessions.js";
import { ChromiumPipeTransport, ChromiumCdpAdapter, sha256File } from "@traceforge/browser-runtime";

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
  connection.beginTakeover = async () => { view.generation++; return { takeoverId: "manual", generation: view.generation, state: "manual_control", pages: [{ ...view }] }; };
  connection.resumeTakeover = async () => { view.generation++; return { takeoverId: "manual", generation: view.generation, state: "agent_control", pages: [{ ...view }] }; };
  connection.observeManual = async (_id, request) => connection.observe(request);
  connection.actManual = async (_id, action) => connection.act(action);
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
  it("keeps a retained cleanup lease retryable after controller close fails", async () => {
    const f = fixture(), sqlite = getSqliteClient(createDb(":memory:")), sessions = new DesktopBrowserSessions(sqlite);
    sqlite.prepare(`INSERT INTO scenario_event_streams VALUES ('run','case','fixture',1,NULL,NULL,NULL,'running','phase',1,'now','now')`).run();
    sqlite.prepare(`INSERT INTO scenario_work_leases VALUES ('run','work','worker','lease',?,'now')`).run(owner.leaseExpiresAt);
    const store = new SqliteBrowserArtifactContent(sqlite), context = { ...f.context, artifacts: new SqliteScenarioArtifactStore(sqlite) };
    f.deployment.persistArtifact = store.persistArtifact.bind(store); f.deployment.readContent = store.readBound.bind(store);
    const release = vi.fn(async () => {}); f.deployment.release = release;
    const connection = await f.controller.attach({} as any);
    vi.mocked(connection.close).mockRejectedValueOnce(new Error("controller close uncertain"));
    const handler = createScenarioBrowserHandler({ id: "fixture", version: "1" }, context, f.node, f.capacity, f.deployment, () => f.controller, sessions);
    try {
      const opened = await handler.execute({ ...input, operation: "open" }, owner, new AbortController().signal);
      const id = (opened.output as any).sessionId;
      await expect(sessions.close(id)).rejects.toThrow("controller close uncertain");
      expect(f.finish).not.toHaveBeenCalled(); expect(release).toHaveBeenLastCalledWith(expect.anything(), false);
      expect(sessions.list("case", "run")[0].status).toBe("cleanup_unknown");
      await sessions.close(id); expect(f.finish).toHaveBeenCalledExactlyOnceWith(true);
      expect(release).toHaveBeenLastCalledWith(expect.anything(), true); expect(sessions.list("case", "run")).toEqual([]);
    } finally { await sessions.shutdown(); sqlite.close(); }
  });
  it("keeps capacity ownership and broker receipts for explicit Chromium-only deployment", async () => {
    const f = fixture(), original = f.deployment.prepare;
    f.deployment.prepare = async (...args) => ({ ...await original(...args), isolation: "chromium" });
    const terminate = vi.fn(async () => undefined);
    f.deployment.chromiumProcess = async () => {
      const connection = await f.controller.attach({} as any);
      connection.proof.browserDirectNetwork = "application_intercepted";
      return { processId: "owned:fixture", connection, terminate };
    };
    const result = await f.handler.execute(input, owner, new AbortController().signal);
    expect(f.startProcess).not.toHaveBeenCalled(); expect(f.terminateProcess).not.toHaveBeenCalled();
    expect(f.capacity.acquire).toHaveBeenCalledOnce(); expect(f.requestHttp).toHaveBeenCalledOnce();
    expect(terminate).toHaveBeenCalledOnce(); expect(f.finish).toHaveBeenCalledWith(true);
    expect((result.output as any).network[0].receiptRef).toBeTruthy();
  });
  it.skipIf(!process.env.TRACEFORGE_REAL_CHROMIUM_PATH)("retains actual Chromium page state across host calls and human takeover (simulated execution proof)", async () => {
    const f = fixture(), sqlite = getSqliteClient(createDb(":memory:")), sessions = new DesktopBrowserSessions(sqlite);
    const directory = await mkdtemp(resolve(tmpdir(), "traceforge-browser-handoff-"));
    const browserExecutable = process.env.TRACEFORGE_REAL_CHROMIUM_PATH!;
    const measured = { ...identity, browserVersion: process.env.TRACEFORGE_REAL_CHROMIUM_PRODUCT!, browserSha256: await sha256File(browserExecutable) };
    let adapter: ChromiumCdpAdapter | undefined;
    sqlite.prepare(`INSERT INTO scenario_event_streams VALUES ('run','case','fixture',1,NULL,NULL,NULL,'running','phase',1,'now','now')`).run();
    sqlite.prepare(`INSERT INTO scenario_work_leases VALUES ('run','work','worker','lease',?,'now')`).run(owner.leaseExpiresAt);
    const store = new SqliteBrowserArtifactContent(sqlite), context = { ...f.context, artifacts: new SqliteScenarioArtifactStore(sqlite) };
    f.deployment.persistArtifact = store.persistArtifact.bind(store); f.deployment.readContent = store.readBound.bind(store);
    const prepare = f.deployment.prepare;
    f.deployment.prepare = async (...args) => ({ ...await prepare(...args), controllerIdentity: measured, timeoutMs: 60000 });
    const http = f.requestHttp.getMockImplementation()!;
    f.requestHttp.mockImplementation(async request => {
      const result = await http(request);
      const body = Buffer.from('<!doctype html><html><body><input aria-label="Fixture input"><button onclick="sessionStorage.setItem(\'state\',\'retained\');document.getElementById(\'result\').textContent=\'State retained\'">Apply</button><p id="result">Ready</p></body></html>');
      return { ...result, headers: [{ name: "content-type", value: "text/html" }], bodyBase64: body.toString("base64"), responseBytes: body.length,
        receipt: { ...result.receipt, responseBytes: body.length } };
    });
    const controller: BrowserControllerPort = { attach: async () => {
      const cdp = await ChromiumPipeTransport.launch({ browserExecutable, workingDirectory: directory, userDataDirectory: resolve(directory, "profile"), expectedIdentity: measured });
      adapter = new ChromiumCdpAdapter({ cdp, identity: measured }); await adapter.initialize();
      return { proof: adapter.proof, start: (intercept, failed) => adapter!.activate(intercept, failed), close: () => adapter!.close(),
        observe: request => adapter!.observe(request), act: action => adapter!.act(action), beginTakeover: () => adapter!.beginTakeover(),
        resumeTakeover: id => adapter!.resumeTakeover(id), observeManual: (id, request) => adapter!.observeManual(id, request), actManual: (id, action) => adapter!.actManual(id, action) };
    } };
    const handler = createScenarioBrowserHandler({ id: "fixture", version: "1" }, context, f.node, f.capacity, f.deployment, () => controller, sessions);
    try {
      const opened = await handler.execute({ ...input, operation: "open", screenshot: false }, owner, new AbortController().signal);
      const sessionId = (opened.output as any).sessionId;
      const takeover = await sessions.command("case", "run", { operation: "takeover", sessionId, commandId: "takeover" }) as any;
      let observed: any;
      for (let n = 0; n < 30; n++) {
        observed = await sessions.command("case", "run", { operation: "observe", sessionId, commandId: `read:${n}`, takeoverId: takeover.takeoverId });
        if (observed.document.nodes.some((node: any) => node.name === "Apply")) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const button = observed.document.nodes.find((node: any) => node.name === "Apply"); expect(button?.element).toBeDefined();
      await sessions.command("case", "run", { operation: "act", sessionId, commandId: "apply", takeoverId: takeover.takeoverId,
        action: { id: "apply", kind: "click", element: button.element } });
      await sessions.command("case", "run", { operation: "resume", sessionId, commandId: "resume", takeoverId: takeover.takeoverId });
      const next = await handler.execute({ operation: "observe", sessionId, authorizationAction: input.authorizationAction }, { ...owner, idempotencyKey: "next" }, new AbortController().signal);
      const artifact = context.artifacts.list({ packageId: "fixture", packageVersion: "1", caseId: "case", runId: "run", limit: 100 }).find(a => a.contentRef === (next.output as any).artifactRef)!;
      const body = store.readBound(artifact.contentRef, owner, artifact.id)!;
      expect(body.toString()).toContain("State retained"); expect(f.startProcess).toHaveBeenCalledTimes(1);
      await handler.execute({ operation: "close", sessionId, authorizationAction: input.authorizationAction }, owner, new AbortController().signal);
      expect(f.finish).toHaveBeenCalledWith(true);
    } finally { await sessions.shutdown(); await adapter?.close(); sqlite.close(); await rm(directory, { recursive: true, force: true }); }
  }, 60000);
  it("retains one browser across calls, desktop takeover and return, then closes on ownership loss", async () => {
    const f = fixture(), sqlite = getSqliteClient(createDb(":memory:")), sessions = new DesktopBrowserSessions(sqlite);
    sqlite.prepare(`INSERT INTO scenario_event_streams VALUES ('run','case','fixture',1,NULL,NULL,NULL,'running','phase',1,'now','now')`).run();
    sqlite.prepare(`INSERT INTO scenario_work_leases VALUES ('run','work','worker','lease',?,'now')`).run(owner.leaseExpiresAt);
    const store = new SqliteBrowserArtifactContent(sqlite), context = { ...f.context, artifacts: new SqliteScenarioArtifactStore(sqlite) };
    f.deployment.persistArtifact = store.persistArtifact.bind(store); f.deployment.readContent = store.readBound.bind(store);
    const handler = createScenarioBrowserHandler({ id: "fixture", version: "1" }, context, f.node, f.capacity, f.deployment, () => f.controller, sessions);
    try {
      const result = await handler.execute({ ...input, operation: "open" }, owner, new AbortController().signal);
      const sessionId = (result.output as any).sessionId;
      expect(f.terminateProcess).not.toHaveBeenCalled();
      expect(sessions.list("case", "run")).toHaveLength(1);
      const takeover = { operation: "takeover" as const, sessionId, commandId: "takeover" };
      await sessions.command("case", "run", takeover);
      await sessions.command("case", "run", takeover);
      expect(sessions.list("case", "run")[0].status).toBe("manual_control");
      expect(sessions.manualControlPending("run", "work")).toBe(true);
      const manual = await sessions.command("case", "run", { operation: "observe", sessionId, commandId: "read", takeoverId: "manual" }) as any;
      expect(manual.document.sensitiveValues).toBe("omitted");
      const waiting = await handler.execute({ operation: "observe", sessionId, authorizationAction: input.authorizationAction }, { ...owner, idempotencyKey: "second" }, new AbortController().signal);
      expect((waiting.output as any).status).toBe("manual_control");
      await expect(sessions.command("other", "run", { ...takeover, commandId: "bad" })).rejects.toThrow("unavailable");
      await expect(sessions.command("case", "run", { operation: "resume", sessionId, commandId: "stale", takeoverId: "wrong" })).rejects.toThrow();
      await sessions.command("case", "run", { operation: "resume", sessionId, commandId: "resume", takeoverId: "manual" });
      expect(sessions.manualControlPending("run", "work")).toBe(false);
      const next = await handler.execute({ operation: "observe", sessionId, authorizationAction: input.authorizationAction }, { ...owner, idempotencyKey: "third" }, new AbortController().signal);
      expect((next.output as any).view.generation).toBe(3);
      expect(f.startProcess).toHaveBeenCalledTimes(1);
      expect(sqlite.prepare("SELECT state FROM desktop_browser_commands WHERE command_id='resume'").get()).toEqual({ state: "completed" });
      sqlite.prepare("DELETE FROM scenario_work_leases WHERE run_id='run'").run();
      await expect(handler.execute({ operation: "observe", sessionId, authorizationAction: input.authorizationAction }, owner, new AbortController().signal)).rejects.toThrow("revoked");
      await sessions.shutdown(); expect(f.terminateProcess).toHaveBeenCalledTimes(1); expect(f.finish).toHaveBeenCalledWith(true);
    } finally { await sessions.shutdown(); sqlite.close(); }
  });
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
      const policy = new RunToolPolicy(descriptor.definition, f.context.authorization as unknown as SqliteScenarioAuthorizationService, undefined, "linux", undefined, () => true);
      const current = assignment(); current.worker.id = owner.workerId; current.worker.capabilities = [...tool.providedCapabilities];
      current.assignment.runId = owner.runId; current.assignment.leaseId = owner.leaseId; current.assignment.leaseExpiresAt = owner.leaseExpiresAt;
      current.assignment.runContext.caseId = owner.caseId; current.assignment.runContext.scopeRef = owner.scopeRef;
      current.assignment.work.id = owner.workId; current.assignment.work.requiredCapabilities = [...tool.providedCapabilities];
      const gateway = new PolicyExecutionToolGateway(createExecutionToolRegistry([tool]), { async authorize() { return { decision: "approved" }; } },
        { async get() { return undefined; }, async put() {} }, { allowedRisks: ["bounded_write"], permissionLayers: ({ assignment, tool }) => policy.layers(assignment, tool) });
      expect((await gateway.catalog(current.worker, current.assignment)).tools.map(item => item.name)).toContain(tool.name);
      const result = await gateway.execute({ ...current, invocation: { id: "browser-through-policy", tool: tool.name, input: { url: input.url, screenshot: true }, rationale: "Observe authorized page" }, idempotencyKey: "browser-through-policy" });
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
