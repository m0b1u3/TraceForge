import { createHash } from "node:crypto";
import { z } from "zod";
import { BrokeredBrowserRuntime, ExecutionNodeBrowserController, type BrowserArtifactPort,
  type BrowserProcessConfiguration, type BrowserControllerPort } from "@traceforge/browser-runtime";
import { permissionProfileFingerprint, type ExecutionNode } from "@traceforge/execution-node";
import type { ScenarioToolHostContext, ScenarioPackageInstallation } from "@traceforge/scenario-sdk";
import type { ScenarioPackageCapabilityHandler, ToolExecutionContext } from "@traceforge/worker-runtime";
import type { ProcessExecutionCapacity, ProcessCapacityInput, ProcessCapacityLease } from "./process-execution-capacity.js";

/** Installation-owned ports, never accepted from a Scenario or renderer. prepare
 * must verify the installed release and native backend before returning a launch.
 * There is no default Chromium path or development/direct-network fallback. */
export interface ScenarioBrowserDeployment {
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
  z.object({ operation: z.literal("inspect"), authorizationAction: z.string().min(1).max(128),
    url: z.string().url().max(8192), screenshot: z.boolean().default(false) }).strict(),
  z.object({ operation: z.literal("read"), authorizationAction: z.string().min(1).max(128), artifactId: z.string().min(1).max(256),
    offset: z.number().int().min(0).max(4194304).default(0), length: z.number().int().min(1).max(65536).default(65536) }).strict(),
]);

/** One bounded invocation owns one fresh browser and closes it before returning.
 * No browser handles, executables, permissions or cross-Run sessions cross RPC. */
export function createScenarioBrowserHandler(
  installation: Pick<ScenarioPackageInstallation, "id" | "version">,
  context: Pick<ScenarioToolHostContext, "authorization" | "artifacts">,
  node?: ExecutionNode,
  capacity?: Pick<ProcessExecutionCapacity, "acquire" | "assertOwnership">,
  deployment?: ScenarioBrowserDeployment,
  controllerFactory: (node: ExecutionNode) => BrowserControllerPort = node => new ExecutionNodeBrowserController({ executionNode: node }),
): ScenarioPackageCapabilityHandler {
  return { capability: "traceforge.scenario.browser@1", actions: ["inspect", "read"], async execute(raw, attribution, signal) {
    const input = inputSchema.parse(raw);
    if (!capacity || !deployment) throw new Error("Browser unavailable: reviewed local deployment and native isolation are required");
    const capacityInput: ProcessCapacityInput = { source: installation.id, version: installation.version, operation: `browser.${input.operation}`,
      kind: "work", parentInvocationKey: attribution.idempotencyKey,
      attribution: { ...attribution, actionId: `browser:${attribution.idempotencyKey}`, idempotencyKey: `browser:${attribution.idempotencyKey}` } };
    const check = () => {
      signal.throwIfAborted(); capacity.assertOwnership(capacityInput);
      context.authorization.requireAction(attribution.scopeRef, attribution.caseId, input.authorizationAction);
    };
    check();
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
    const url = new URL(input.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Browser URL is invalid");
    context.authorization.authorizeResource(attribution.scopeRef, attribution.caseId, input.authorizationAction, "network.url", url.href);
    const process = await deployment.prepare(structuredClone(attribution), signal);
    try {
      check();
      // The child may not request stronger effective permissions than its caller.
      if (permissionProfileFingerprint(process.permissions) !== permissionProfileFingerprint(attribution.effectivePermissions)) throw new Error("Browser launch permissions must match the current invocation");
      if (!process.expectedSandboxBackend || !process.expectedBackendMeasurement) throw new Error("Browser native backend identity is required");
      process.timeoutMs = Math.min(process.timeoutMs, 30000);
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
    let runtime: BrokeredBrowserRuntime;
    try {
    runtime = new BrokeredBrowserRuntime({ executionNode: controlledNode, controller: controllerFactory(controlledNode),
      authorization: { assertSessionCurrent: check, authorizeRequest: async request => {
        check(); const grant = context.authorization.authorizeResource(attribution.scopeRef, attribution.caseId, input.authorizationAction, "network.url", request.url);
        return { authorizationRef: grant.id, canonicalUrl: grant.canonicalValue, expiresAt: grant.expiresAt };
      } }, artifacts: { recordDownload: value => record("download", value), recordObservation: value => record("observation", value) },
      limits: { maximumRequestsPerSession: 64, maximumConcurrentRequests: 8, maximumSessionMs: 30000,
        maximumRequestTimeoutMs: 15000, maximumObservationsPerSession: 3, maximumActionsPerSession: 1 } });
    } catch (error) { await deployment.release?.(attribution, true); throw error; }
    let sessionId: string | undefined;
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
      return { output: { dom, screenshot, artifacts: recordedArtifacts, network: snapshot.records, validation: "observation_only" }, refs };
    } finally {
      signal.removeEventListener("abort", cancel);
      try { if (sessionId) await runtime.close(sessionId); }
      finally {
        try { permit?.finish(!dispatched || terminal); }
        finally { await deployment.release?.(attribution, !dispatched || terminal); }
      }
    }
  } };
}
