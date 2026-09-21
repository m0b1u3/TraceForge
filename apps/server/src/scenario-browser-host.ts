import { createHash } from "node:crypto";
import { z } from "zod";
import { BrowserActionSchema } from "@traceforge/shared/desktop-browser";
import type { DesktopBrowserSessions } from "./desktop-browser-sessions.js";
import { BrokeredBrowserRuntime, ExecutionNodeBrowserController, type BrowserArtifactPort,
  type BrowserProcessConfiguration, type BrowserControllerPort, type BrokeredBrowserRuntimeOptions } from "@traceforge/browser-runtime";
import { permissionProfileFingerprint, type ExecutionNode } from "@traceforge/execution-node";
import type { ScenarioToolHostContext, ScenarioPackageInstallation } from "@traceforge/scenario-sdk";
import type { ScenarioPackageCapabilityHandler, ToolExecutionContext } from "@traceforge/worker-runtime";
import type { ProcessExecutionCapacity, ProcessCapacityInput, ProcessCapacityLease } from "./process-execution-capacity.js";

/** Installation-owned ports, never accepted from a Scenario or renderer. prepare
 * must verify the installed release and selected isolation before returning a launch.
 * There is no default Chromium path or development/direct-network fallback. */
export interface ScenarioBrowserDeployment {
  chromiumProcess?: NonNullable<BrokeredBrowserRuntimeOptions["chromiumProcess"]>;
  prepare(context: ToolExecutionContext, signal: AbortSignal): Promise<BrowserProcessConfiguration>;
  artifacts: BrowserArtifactPort;
  persistArtifact?(kind: "download" | "observation", value: BrowserArtifactInput, index: (saved: { ref: string }) => ReturnType<ScenarioToolHostContext["artifacts"]["record"]>): Promise<{ ref: string }> | { ref: string };
  beforeDispatch?(context: ToolExecutionContext, processKey: string): void;
  recover?(): Promise<void>;
  readContent?(ref: string, owner: Pick<ToolExecutionContext, "caseId" | "runId">, artifactId: string): Buffer | undefined;
  release?(context: ToolExecutionContext, terminalConfirmed: boolean): Promise<void>;
}
export type BrowserArtifactInput = Parameters<BrowserArtifactPort["recordObservation"]>[0] | Parameters<BrowserArtifactPort["recordDownload"]>[0];
const inputSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("open"), authorizationAction: z.string().min(1).max(128), url: z.string().url().max(8192),
    durationMs: z.number().int().min(1000).max(900000).default(300000), screenshot: z.boolean().default(false) }).strict(),
  z.object({ operation: z.literal("observe"), authorizationAction: z.string().min(1).max(128), sessionId: z.string().min(1).max(256), pageId: z.string().max(256).optional() }).strict(),
  z.object({ operation: z.literal("act"), authorizationAction: z.string().min(1).max(128), sessionId: z.string().min(1).max(256), action: BrowserActionSchema }).strict(),
  z.object({ operation: z.literal("close"), authorizationAction: z.string().min(1).max(128), sessionId: z.string().min(1).max(256) }).strict(),
  z.object({ operation: z.literal("inspect"), authorizationAction: z.string().min(1).max(128),
    url: z.string().url().max(8192), screenshot: z.boolean().default(false) }).strict(),
  z.object({ operation: z.literal("read"), authorizationAction: z.string().min(1).max(128), artifactId: z.string().min(1).max(256),
    offset: z.number().int().min(0).max(4194304).default(0), length: z.number().int().min(1).max(65536).default(65536) }).strict(),
]);

/** Inspect closes its browser before returning; open retains a bounded, lease-owned
 * session in the host registry. RPC exposes opaque IDs, never executable handles
 * or authority to expand permissions or cross Run/Work ownership. */
export function createScenarioBrowserHandler(
  installation: Pick<ScenarioPackageInstallation, "id" | "version">,
  context: Pick<ScenarioToolHostContext, "authorization" | "artifacts">,
  node?: ExecutionNode,
  capacity?: Pick<ProcessExecutionCapacity, "acquire" | "assertOwnership">,
  deployment?: ScenarioBrowserDeployment,
  controllerFactory: (node: ExecutionNode) => BrowserControllerPort = node => new ExecutionNodeBrowserController({ executionNode: node }),
  sessions?: DesktopBrowserSessions,
): ScenarioPackageCapabilityHandler {
  return { capability: "traceforge.scenario.browser@1", actions: ["inspect", "read", "open", "observe", "act", "close"], async execute(raw, attribution, signal) {
    const input = inputSchema.parse(raw);
    if (!capacity || !deployment) throw new Error("Browser unavailable: reviewed local deployment and explicit isolation are required");
    const capacityInput: ProcessCapacityInput = { source: installation.id, version: installation.version, operation: `browser.${input.operation}`,
      kind: "work", parentInvocationKey: attribution.idempotencyKey,
      attribution: { ...attribution, actionId: `browser:${attribution.idempotencyKey}`, idempotencyKey: `browser:${attribution.idempotencyKey}` } };
    let retained = false;
    let runtime: BrokeredBrowserRuntime;
    let sessionId: string | undefined;
    let deadline = Infinity;
    const check = () => {
      if (!retained) { signal.throwIfAborted(); capacity.assertOwnership(capacityInput); }
      else {
        if (Date.now() >= deadline) throw new Error("Browser session duration exhausted");
        const leaseExpiresAt = sessions!.currentLease(attribution);
        const snapshot = runtime.snapshot(sessionId!)!;
        if (!["active", "manual_control"].includes(snapshot.status)) throw new Error("Browser session closed");
        runtime.renewLease(sessionId!, { ...snapshot.owner, leaseExpiresAt });
      }
      context.authorization.requireAction(attribution.scopeRef, attribution.caseId, input.authorizationAction);
    };
    check();
    if (input.operation === "observe" || input.operation === "act" || input.operation === "close") {
      if (!sessions) throw new Error("Browser sessions unavailable");
      const active = sessions.agent(input.sessionId, attribution, installation.id, installation.version);
      if (input.operation === "close") { await sessions.close(input.sessionId); return { output: { status: "closed" }, refs: [] }; }
      if (active.snapshot(input.sessionId)?.status === "manual_control") return { output: { status: "manual_control", instruction: "User controls this session; do not act or open a replacement." }, refs: [] };
      const output = input.operation === "act" ? await active.act(input.sessionId, input.action)
        : await active.observe(input.sessionId, { kind: "dom", pageId: input.pageId });
      return { output, refs: "artifactRef" in output ? [output.artifactRef] : [] };
    }
    if (input.operation === "read") {
      const artifact = context.artifacts.get({ packageId: installation.id, packageVersion: installation.version, caseId: attribution.caseId, artifactId: input.artifactId });
      if (!artifact || artifact.runId !== attribution.runId || !artifact.kind.startsWith("browser.")) throw new Error("Browser artifact unavailable for this invocation");
      const body = deployment.readContent?.(artifact.contentRef, attribution, artifact.id);
      if (!body || body.length > 4194304 || body.length !== artifact.byteSize || `sha256:${createHash("sha256").update(body).digest("hex")}` !== artifact.digest)
        throw new Error("Browser artifact content unavailable or corrupt");
      check();
      if (input.offset > body.length) throw new Error("Browser content offset exceeds size");
      const end = Math.min(body.length, input.offset + input.length);
      return { output: { artifactId: artifact.id, bodyBase64: body.subarray(input.offset, end).toString("base64"), byteSize: body.length,
        offset: input.offset, nextOffset: end < body.length ? end : null, digest: artifact.digest }, refs: [artifact.id, artifact.contentRef] };
    }
    if (!node) throw new Error("Browser unavailable: local execution is required");
    if (input.operation === "open" && !sessions) throw new Error("Browser sessions unavailable");
    const url = new URL(input.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Browser URL is invalid");
    context.authorization.authorizeResource(attribution.scopeRef, attribution.caseId, input.authorizationAction, "network.url", url.href);
    const process = await deployment.prepare(structuredClone(attribution), signal);
    try {
      check();
      // The child may not request stronger effective permissions than its caller.
      if (permissionProfileFingerprint(process.permissions) !== permissionProfileFingerprint(attribution.effectivePermissions)) throw new Error("Browser launch permissions must match the current invocation");
      if (process.isolation !== "chromium" && (!process.expectedSandboxBackend || !process.expectedBackendMeasurement)) throw new Error("Browser native backend identity is required");
      if (process.isolation === "chromium" && !deployment.chromiumProcess) throw new Error("Chromium-only browser deployment is unavailable");
      process.timeoutMs = Math.min(process.timeoutMs, input.operation === "open" ? input.durationMs : 30000);
      deadline = Date.now() + process.timeoutMs;
    } catch (error) { await deployment.release?.(attribution, true); throw error; }
    let permit: ProcessCapacityLease | undefined; let terminal = false; let dispatched = false;
    const controlledNode = new Proxy(node, { get(target, property) {
      if (property === "startProcess") return async (request: Parameters<ExecutionNode["startProcess"]>[0]) => {
        check(); permit = await capacity.acquire({ ...capacityInput, attribution: request.attribution }, signal, check);
        permit.beforeStart(request.requestId); deployment.beforeDispatch?.(attribution, request.attribution.idempotencyKey); dispatched = true;
        return target.startProcess(request);
      };
      if (property === "requestHttp") return async (request: Parameters<ExecutionNode["requestHttp"]>[0]) => { check(); return target.requestHttp(request); };
      if (property === "terminateProcess") return async (request: Parameters<ExecutionNode["terminateProcess"]>[0]) => {
        const result = await target.terminateProcess(request);
        terminal = result.state === "exited";
        if (!terminal) throw new Error("Browser process termination is unconfirmed");
        return result;
      };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } });
    const recordedArtifacts: Array<ReturnType<ScenarioToolHostContext["artifacts"]["record"]>> = [];
    const record = async (kind: "download" | "observation", value: Parameters<BrowserArtifactPort["recordObservation"]>[0] | Parameters<BrowserArtifactPort["recordDownload"]>[0]) => {
      check();
      const index = (saved: { ref: string }) => {
        check();
        const artifact = context.artifacts.record({ packageId: installation.id, packageVersion: installation.version, caseId: attribution.caseId, runId: attribution.runId,
        commandId: `browser:${createHash("sha256").update(JSON.stringify([value.sessionId, saved.ref, value.sha256])).digest("hex")}`,
        kind: `browser.${kind}`, summary: `Browser ${kind}`, contentRef: saved.ref, digest: `sha256:${value.sha256}`, byteSize: value.byteSize,
        metadata: { sessionId: value.sessionId, workId: attribution.workId, leaseId: attribution.leaseId } });
        recordedArtifacts.push(artifact); return artifact;
      };
      if (deployment.persistArtifact) return deployment.persistArtifact(kind, value, index);
      const saved = kind === "download" ? await deployment.artifacts.recordDownload(value as Parameters<BrowserArtifactPort["recordDownload"]>[0])
        : await deployment.artifacts.recordObservation(value as Parameters<BrowserArtifactPort["recordObservation"]>[0]);
      index(saved);
      return saved;
    };
    try {
    runtime = new BrokeredBrowserRuntime({ executionNode: controlledNode, controller: controllerFactory(controlledNode),
      ...(deployment.chromiumProcess ? { chromiumProcess: async (configuration, id) => {
        check();
        const processKey = `browser-process:${id}`;
        permit = await capacity.acquire({ ...capacityInput, attribution: { ...capacityInput.attribution,
          actionId: processKey, idempotencyKey: processKey } }, signal, check);
        permit.beforeStart(processKey); deployment.beforeDispatch?.(attribution, processKey); dispatched = true;
        const owned = await deployment.chromiumProcess!(configuration, id);
        return { ...owned, async terminate() { await owned.terminate(); terminal = true; } };
      } } : {}),
      authorization: { assertSessionCurrent: check, authorizeRequest: async request => {
        check(); const grant = context.authorization.authorizeResource(attribution.scopeRef, attribution.caseId, input.authorizationAction, "network.url", request.url);
        return { authorizationRef: grant.id, canonicalUrl: grant.canonicalValue, expiresAt: grant.expiresAt };
      } }, artifacts: { recordDownload: value => record("download", value), recordObservation: value => record("observation", value) },
      limits: { maximumRequestsPerSession: input.operation === "open" ? 1024 : 64, maximumConcurrentRequests: 8, maximumSessionMs: process.timeoutMs,
        maximumRequestTimeoutMs: 30000, maximumObservationsPerSession: input.operation === "open" ? 1000 : 3, maximumActionsPerSession: input.operation === "open" ? 1000 : 1 } });
    } catch (error) { await deployment.release?.(attribution, true); throw error; }
    const cancel = () => { if (sessionId) void runtime.freeze(sessionId, "Invocation canceled").catch(() => undefined); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const session = await runtime.open({ caseId: attribution.caseId, runId: attribution.runId, workId: attribution.workId,
        workerId: attribution.workerId, scopeRef: attribution.scopeRef, leaseId: attribution.leaseId, leaseExpiresAt: attribution.leaseExpiresAt,
        authorizationAction: input.authorizationAction }, process);
      sessionId = session.id; check();
      const initial = await runtime.observe(sessionId, { kind: "dom" });
      await runtime.act(sessionId, { id: `navigate:${sessionId}`, kind: "navigate", view: initial.view, url: url.href });
      check();
      const dom = await runtime.observe(sessionId, { kind: "dom" });
      const screenshot = input.screenshot ? await runtime.observe(sessionId, { kind: "screenshot" }) : null;
      check();
      const snapshot = runtime.snapshot(sessionId)!;
      const refs = [...new Set([dom.artifactRef, ...(screenshot ? [screenshot.artifactRef] : []),
        ...snapshot.records.flatMap(record => [record.receiptRef, record.artifactRef].filter((ref): ref is string => !!ref))])];
      if (input.operation === "open") {
        const id = sessionId;
        sessions!.add(id, { runtime, owner: structuredClone(attribution), packageId: installation.id, packageVersion: installation.version,
          check, read: ref => { const artifact = recordedArtifacts.find(a => a.contentRef === ref); return artifact && deployment.readContent?.(ref, attribution, artifact.id); },
          close: async () => {
            try { await runtime.close(id); }
            catch (error) { await deployment.release?.(attribution, false); throw error; }
            try { permit?.finish(!dispatched || terminal); } finally { await deployment.release?.(attribution, !dispatched || terminal); }
          } });
        retained = true;
      }
      return { output: { ...(retained ? { sessionId, expiresAt: snapshot.expiresAt } : {}), dom, screenshot, artifacts: recordedArtifacts, network: snapshot.records, validation: "observation_only" }, refs };
    } finally {
      signal.removeEventListener("abort", cancel);
      try { if (sessionId && !retained) await runtime.close(sessionId); }
      finally {
        if (!retained) { try { permit?.finish(!dispatched || terminal); }
        finally { await deployment.release?.(attribution, !dispatched || terminal); } }
      }
    }
  } };
}
