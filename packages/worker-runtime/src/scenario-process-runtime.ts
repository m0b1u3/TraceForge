import { createHash, randomUUID } from "node:crypto";
import type { ExecutionAttribution, ExecutionNode, ExecutionResourceLimits, ProcessDescriptor } from "@traceforge/execution-node";
import { canonicalJson, type EffectivePermissionProfile } from "@traceforge/orchestration-core";
import type { ExecutionToolAdapter } from "./tool-gateway.js";
import type { ExecutionToolDiscoverySource } from "./tool-discovery.js";
import type { ToolExecutionContext } from "./model.js";
import { waitForCancellation } from "./cancellation.js";
import type { ToolProviderFairScheduler } from "./tool-provider-scheduler.js";
import type {
  ProviderCapabilityHost,
  ProviderCapabilityInvocation,
  ProviderCapabilityReceipt,
} from "./provider-capability-broker.js";
import {
  ToolProviderProcessClient,
  type ToolProviderProcessAttestation,
  type ToolProviderProcessOptions,
  type ToolProviderProcessStatus,
} from "./tool-provider-rpc.js";
import { ExecutionNodeToolProviderClient, type ExecutionNodeToolProviderLifecycleEvent } from "./tool-provider-execution-node.js";

/** Scenario processes use the bounded Tool Provider transport with a stricter package profile. */
export const SCENARIO_PROCESS_PROTOCOL = "traceforge-scenario-process-rpc" as const;
export const SCENARIO_PROCESS_PROTOCOL_VERSION = 1 as const;

export interface ScenarioProcessPackageIdentity {
  id: string;
  version: string;
}

export interface ScenarioProcessManifest extends ScenarioProcessPackageIdentity {
  protocol: typeof SCENARIO_PROCESS_PROTOCOL;
  protocolVersion: typeof SCENARIO_PROCESS_PROTOCOL_VERSION;
  source: string;
  entrypoint: string;
  providedCapabilities: string[];
  hostCapabilities: string[];
}

/** Explicit development-only launch. A configured attestation is not an OS proof. */
export interface ScenarioDevelopmentProcessLaunch {
  executable: string;
  arguments?: string[];
  workingDirectory: string;
  environment?: Record<string, string>;
  attestation: ToolProviderProcessAttestation;
}

/** Production launch material. Enforcement evidence is returned by Execution Node after the real spawn. */
export interface ScenarioExecutionNodeProcessLaunch {
  executable: string;
  arguments?: string[];
  workingDirectory: string;
  environment?: Record<string, string>;
  attribution: ExecutionAttribution;
  permissions: EffectivePermissionProfile;
  resources: ExecutionResourceLimits;
  expectedSandboxBackend?: string;
  processTimeoutMs?: number;
  outputLimitBytes?: number;
}

export type ScenarioProcessLaunch = ScenarioDevelopmentProcessLaunch | ScenarioExecutionNodeProcessLaunch;

export type ScenarioProcessSupervisionState = "reserved" | "started" | "ready" | "exited" | "failed" | "interrupted" | "revoked" | "retired";
export interface ScenarioProcessSupervisionSnapshot extends ScenarioProcessPackageIdentity {
  source: string;
  lastGeneration: number;
  maximumStarts: number;
  state: ScenarioProcessSupervisionState;
  revokedReason: string | null;
}
export interface ScenarioProcessLaunchProof {
  nodeId: string;
  processId: string;
  pid: number;
  sandboxBackend: string;
  permissionProfileFingerprint: string;
  resourceLimitsFingerprint: string;
  network: "deny" | "brokered" | "direct";
}

/** Immutable identity persisted before a Host capability can have an external effect. */
export interface ScenarioCapabilityClaim {
  schemaVersion: 1;
  package: ScenarioProcessPackageIdentity;
  generation: number;
  parentRequestId: string;
  capability: string;
  action: string;
  idempotencyKey: string;
  inputFingerprint: string;
  attribution: {
    caseId: string;
    runId: string;
    workId: string;
    workerId: string;
    scopeRef: string;
    leaseId: string;
  };
  startedAt: string;
}

/** Durable trusted-host port. Implementations must make reserve/receipt writes atomic. */
export interface ScenarioProcessSupervisionStore {
  recoverInterrupted(): number;
  snapshot(identity: ScenarioProcessManifest): ScenarioProcessSupervisionSnapshot | undefined;
  reserveGeneration(identity: ScenarioProcessManifest, generation: number, maximumStarts: number, launchFingerprint: string): void;
  recordLifecycle(identity: ScenarioProcessManifest, generation: number, state: Exclude<ScenarioProcessSupervisionState, "reserved" | "interrupted" | "revoked">,
    detail: { proof?: ScenarioProcessLaunchProof; error?: string; exitCode?: number | null; exitSignal?: string | null }): void;
  revoke(identity: ScenarioProcessManifest, reason: string): void;
  getCapabilityReceipt(identity: ScenarioProcessPackageIdentity, idempotencyKey: string):
    { fingerprint: string; status: "pending" | "retry_allowed" } | { fingerprint: string; status: "succeeded"; receipt: ProviderCapabilityReceipt } | undefined;
  countCapabilityReceipts(identity: ScenarioProcessPackageIdentity): number;
  claimCapabilityReceipt(identity: ScenarioProcessPackageIdentity, claim: ScenarioCapabilityClaim): boolean;
  settleCapabilityReceipt(identity: ScenarioProcessPackageIdentity, fingerprint: string, receipt: ProviderCapabilityReceipt): void;
}

export interface ScenarioPackageCapabilityResult {
  output: unknown;
  refs: string[];
}

export interface ScenarioPackageCapabilityHandler {
  capability: string;
  actions: string[];
  execute(input: unknown, context: ToolExecutionContext, signal: AbortSignal): Promise<ScenarioPackageCapabilityResult>;
}

export interface ScenarioPackageCapabilityBrokerLimits {
  maximumRequestBytes: number;
  maximumResponseBytes: number;
  maximumConcurrent: number;
  maximumReceipts: number;
  timeoutMs: number;
}

const defaultBrokerLimits: ScenarioPackageCapabilityBrokerLimits = {
  maximumRequestBytes: 256 * 1024,
  maximumResponseBytes: 4 * 1024 * 1024,
  maximumConcurrent: 16,
  maximumReceipts: 4096,
  timeoutMs: 15_000,
};

interface ActiveGeneration { generation: number; controller: AbortController }
interface RecordedReceipt { fingerprint: string; receipt: ProviderCapabilityReceipt }
interface InFlightReceipt { fingerprint: string; promise: Promise<ProviderCapabilityReceipt> }

/**
 * Host-side capability gate for one exact Scenario Package version. The child
 * never supplies Case/Run/Work ownership: the transport copies it from the
 * active parent tool call before this broker is entered.
 */
export class ScenarioPackageCapabilityBroker implements ProviderCapabilityHost {
  private readonly handlers = new Map<string, ScenarioPackageCapabilityHandler>();
  private readonly declared: Set<string>;
  private readonly limits: ScenarioPackageCapabilityBrokerLimits;
  private readonly receipts = new Map<string, RecordedReceipt>();
  private readonly inFlight = new Map<string, InFlightReceipt>();
  private readonly active = new Set<AbortController>();
  private generation: ActiveGeneration | null = null;
  private revokedReason: string | null = null;

  constructor(
    readonly packageIdentity: ScenarioProcessPackageIdentity,
    declaredCapabilities: readonly string[],
    handlers: readonly ScenarioPackageCapabilityHandler[],
    limits: Partial<ScenarioPackageCapabilityBrokerLimits> = {},
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly assertAvailable: () => void = () => undefined,
    private readonly durableStore?: Pick<ScenarioProcessSupervisionStore,"getCapabilityReceipt"|"countCapabilityReceipts"|"claimCapabilityReceipt"|"settleCapabilityReceipt">,
  ) {
    required(packageIdentity.id, "Scenario Package id");
    required(packageIdentity.version, "Scenario Package version");
    this.declared = new Set(declaredCapabilities.map((value) => required(value, "declared host capability")));
    if (this.declared.size !== declaredCapabilities.length) throw new Error("Duplicate Scenario Package host capability");
    this.limits = { ...defaultBrokerLimits, ...limits };
    for (const [key, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Scenario capability ${key} must be a positive integer`);
    }
    for (const handler of handlers) {
      const capability = required(handler.capability, "Scenario capability handler");
      if (!this.declared.has(capability)) throw new Error(`Scenario capability handler ${capability} was not declared by the Package`);
      if (this.handlers.has(capability)) throw new Error(`Duplicate Scenario capability handler ${capability}`);
      const actions = handler.actions.map((action) => required(action, "Scenario capability action"));
      if (!actions.length || new Set(actions).size !== actions.length) throw new Error(`Invalid actions for Scenario capability ${capability}`);
      this.handlers.set(capability, { ...handler, actions });
    }
    const missing = [...this.declared].filter((capability) => !this.handlers.has(capability));
    if (missing.length) throw new Error(`Scenario Package host capabilities have no Handler: ${missing.sort().join(", ")}`);
  }

  activate(generation: number): void {
    if (this.revokedReason) throw new Error(`Scenario Package capability grant is revoked: ${this.revokedReason}`);
    if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("Invalid Scenario process generation");
    if (this.generation?.generation === generation) return;
    this.generation?.controller.abort(new Error("Scenario process generation replaced"));
    this.generation = { generation, controller: new AbortController() };
  }

  revoke(reason: string): void {
    this.revokedReason = required(reason, "Scenario Package capability revocation reason");
    this.generation?.controller.abort(new Error(this.revokedReason));
    this.generation = null;
    for (const controller of this.active) controller.abort(new Error(this.revokedReason));
  }

  async invoke(input: ProviderCapabilityInvocation): Promise<ProviderCapabilityReceipt> {
    this.assertAvailable();
    const startedAt = this.now();
    if (this.revokedReason) throw new Error(`Scenario Package capability grant is revoked: ${this.revokedReason}`);
    if (input.provider.id !== this.packageIdentity.id || input.provider.version !== this.packageIdentity.version) {
      throw new Error("Scenario Package capability caller identity mismatch");
    }
    for (const [label, value] of [["parent request", input.parentRequestId], ["capability", input.capability],
      ["action", input.action], ["idempotency key", input.idempotencyKey]] as const) bounded(value, `Scenario Package ${label}`);
    if (!this.generation || input.provider.generation !== this.generation.generation) {
      throw new Error("Scenario Package capability caller generation is not active");
    }
    if (input.depth !== 1) throw new Error("Scenario Package capability calls cannot be nested");
    if (Date.parse(input.attribution.leaseExpiresAt) <= Date.parse(startedAt)) throw new Error("Scenario Package capability Work lease expired");
    const handler = this.handlers.get(input.capability);
    if (!this.declared.has(input.capability) || !handler) throw new Error(`Scenario Package capability ${input.capability} is not granted`);
    if (!handler.actions.includes(input.action)) throw new Error(`Scenario Package capability action ${input.action} is not granted`);
    const requestBytes = encodedBytes(input.input);
    if (requestBytes > this.limits.maximumRequestBytes) throw new Error("Scenario Package capability request exceeds its capacity");
    const fingerprint = sha256(canonicalJson({
      package: this.packageIdentity,
      capability: input.capability, action: input.action, input: input.input ?? null,
      owner: { caseId: input.attribution.caseId, runId: input.attribution.runId, workId: input.attribution.workId,
        workerId: input.attribution.workerId, leaseId: input.attribution.leaseId },
    }));
    const receiptKey = input.idempotencyKey;
    const recorded = this.receipts.get(receiptKey);
    if (recorded) {
      if (recorded.fingerprint !== fingerprint) throw new Error("Scenario capability idempotency key was reused with different input");
      return { ...structuredClone(recorded.receipt), replayed: true };
    }
    const durable = this.durableStore?.getCapabilityReceipt(this.packageIdentity, receiptKey);
    const retryReleased = durable?.status === "retry_allowed";
    if (durable) {
      if (durable.fingerprint !== fingerprint) {
        throw new Error("Scenario capability idempotency key was reused with different input");
      }
      if (durable.status === "pending") throw new Error("Scenario capability outcome is unresolved; reconciliation is required");
      if (durable.status === "succeeded") {
        if (durable.receipt.inputFingerprint !== fingerprint) throw new Error("Scenario capability receipt fingerprint mismatch");
        this.receipts.set(receiptKey, { fingerprint, receipt: structuredClone(durable.receipt) });
        return { ...structuredClone(durable.receipt), replayed: true };
      }
    }
    const inFlight = this.inFlight.get(receiptKey);
    if (inFlight) {
      if (inFlight.fingerprint !== fingerprint) throw new Error("Scenario capability idempotency key was reused with different input");
      return { ...structuredClone(await inFlight.promise), replayed: true };
    }
    if (!retryReleased && Math.max(this.receipts.size, this.durableStore?.countCapabilityReceipts(this.packageIdentity) ?? 0) >= this.limits.maximumReceipts) {
      throw new Error("Scenario Package capability receipt capacity exceeded");
    }
    const claim: ScenarioCapabilityClaim = { schemaVersion: 1, package: this.packageIdentity,
      generation: input.provider.generation, parentRequestId: input.parentRequestId, capability: input.capability,
      action: input.action, idempotencyKey: receiptKey, inputFingerprint: fingerprint,
      attribution: { caseId: input.attribution.caseId, runId: input.attribution.runId, workId: input.attribution.workId,
        workerId: input.attribution.workerId, scopeRef: input.attribution.scopeRef, leaseId: input.attribution.leaseId }, startedAt };
    if (this.durableStore && !this.durableStore.claimCapabilityReceipt(this.packageIdentity, claim)) {
      const raced = this.durableStore.getCapabilityReceipt(this.packageIdentity, receiptKey);
      if (!raced || raced.fingerprint !== fingerprint) throw new Error("Scenario capability idempotency claim conflict");
      if (raced.status !== "succeeded") throw new Error("Scenario capability outcome is unresolved; reconciliation is required");
      this.receipts.set(receiptKey,{fingerprint,receipt:structuredClone(raced.receipt)});
      return { ...structuredClone(raced.receipt), replayed:true };
    }
    const promise = this.execute(input, handler, fingerprint, receiptKey, requestBytes, startedAt);
    this.inFlight.set(receiptKey, { fingerprint, promise });
    try { return await promise; }
    finally { this.inFlight.delete(receiptKey); }
  }

  private async execute(input: ProviderCapabilityInvocation, handler: ScenarioPackageCapabilityHandler,
    fingerprint: string, receiptKey: string, requestBytes: number, startedAt: string): Promise<ProviderCapabilityReceipt> {
    if (this.active.size >= this.limits.maximumConcurrent) throw new Error("Scenario Package capability concurrency limit exceeded");
    const generation = this.generation!;
    const controller = new AbortController();
    const abort = () => controller.abort(generation.controller.signal.reason ?? new Error("Scenario process generation ended"));
    generation.controller.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("Scenario Package capability deadline exceeded")), this.limits.timeoutMs);
    this.active.add(controller);
    try {
      const result = await waitForCancellation(
        () => handler.execute(input.input, snapshotContext(input.attribution), controller.signal),
        controller.signal,
      );
      this.assertAvailable();
      if (!Array.isArray(result.refs) || result.refs.some((ref) => typeof ref !== "string" || !ref.trim())) {
        throw new Error("Scenario Package capability returned invalid Evidence references");
      }
      const responseBytes = encodedBytes(result.output);
      if (responseBytes > this.limits.maximumResponseBytes) throw new Error("Scenario Package capability response exceeds its capacity");
      const receipt: ProviderCapabilityReceipt = {
        id: randomUUID(), provider: { ...input.provider }, parentRequestId: input.parentRequestId,
        capability: input.capability, action: input.action, idempotencyKey: input.idempotencyKey,
        inputFingerprint: fingerprint, attribution: withoutPermissions(input.attribution), status: "succeeded",
        authorizationRef: `scenario-package:${this.packageIdentity.id}@${this.packageIdentity.version}:generation:${input.provider.generation}`,
        output: structuredClone(result.output), refs: [...result.refs], requestBytes, responseBytes, retryable: false,
        startedAt, completedAt: this.now(),
      };
      this.durableStore?.settleCapabilityReceipt(this.packageIdentity, fingerprint, receipt);
      this.receipts.set(receiptKey, { fingerprint, receipt: structuredClone(receipt) });
      return receipt;
    } finally {
      clearTimeout(timer);
      this.active.delete(controller);
      generation.controller.signal.removeEventListener("abort", abort);
    }
  }
}

export interface ScenarioProcessRuntimeOptions {
  manifest: ScenarioProcessManifest;
  launch: ScenarioProcessLaunch;
  capabilityHandlers: ScenarioPackageCapabilityHandler[];
  capabilityLimits?: Partial<ScenarioPackageCapabilityBrokerLimits>;
  transport?: Omit<ToolProviderProcessOptions, "executable" | "arguments" | "workingDirectory" | "environment" | "attestation" | "capabilityHost">;
  maximumRestarts?: number;
  /** Shares the Foundation's global/per-Run/per-Work execution admission. */
  scheduler?: ToolProviderFairScheduler;
  /** Rechecks current Package trust at discovery, execution and reverse-capability boundaries. */
  assertAvailable?: () => void;
  /** Required for production Scenario Process launches. */
  executionNode?: ExecutionNode;
  /** Required by the Foundation composition root so generations and receipts survive host restart. */
  supervision?: ScenarioProcessSupervisionStore;
  /** Durable shared process admission; required by the production Foundation. */
  processCapacity?: {
    acquire(generation: number, attribution: ExecutionAttribution): Promise<{ beforeStart(requestId: string): void; finish(terminalObserved: boolean): void }>;
  };
}

/** A discoverable tool source backed by one identity-checked Scenario child process. */
export class ScenarioProcessRuntime implements ExecutionToolDiscoverySource {
  readonly source: string;
  private readonly client: ToolProviderProcessClient | ExecutionNodeToolProviderClient;
  private readonly broker: ScenarioPackageCapabilityBroker;
  private readonly maximumRestarts: number;
  private revokedReason: string | null = null;

  constructor(private readonly options: ScenarioProcessRuntimeOptions) {
    const manifest = validateScenarioProcessManifest(options.manifest);
    this.source = manifest.source;
    this.maximumRestarts = options.maximumRestarts ?? 3;
    if (!Number.isSafeInteger(this.maximumRestarts) || this.maximumRestarts < 0 || this.maximumRestarts > 100) {
      throw new Error("Invalid Scenario process restart limit");
    }
    this.broker = new ScenarioPackageCapabilityBroker(manifest, manifest.hostCapabilities, options.capabilityHandlers,
      options.capabilityLimits, undefined, options.assertAvailable, options.supervision);
    if (isExecutionNodeLaunch(options.launch)) {
      if (!options.executionNode) throw new Error("Production Scenario Process requires Execution Node");
      if (!options.supervision) throw new Error("Production Scenario Process requires durable supervision");
      if (!options.processCapacity) throw new Error("Production Scenario Process requires durable process capacity");
      const previous = options.supervision.snapshot(manifest);
      if (previous?.revokedReason) throw new Error(`Scenario Process is revoked: ${previous.revokedReason}`);
      const launchFingerprint = sha256(canonicalJson({ manifest: { id: manifest.id, version: manifest.version, source: manifest.source,
        entrypoint: manifest.entrypoint }, executable: options.launch.executable, arguments: options.launch.arguments ?? [],
        workingDirectory: options.launch.workingDirectory, environment: options.launch.environment ?? {},
        attribution: options.launch.attribution, permissions: options.launch.permissions, resources: options.launch.resources }));
      const capacityLeases = new Map<number,{ beforeStart(requestId:string):void; finish(terminalObserved:boolean):void }>();
      const serviceAttribution=structuredClone(options.launch.attribution);
      this.client = new ExecutionNodeToolProviderClient({
        node: options.executionNode, executable: options.launch.executable, arguments: options.launch.arguments,
        workingDirectory: options.launch.workingDirectory, environment: options.launch.environment ?? {},
        attribution: options.launch.attribution, permissions: options.launch.permissions, resources: options.launch.resources,
        expectedSandboxBackend: options.launch.expectedSandboxBackend, processTimeoutMs: options.launch.processTimeoutMs,
        outputLimitBytes: options.launch.outputLimitBytes, requestTimeoutMs: options.transport?.requestTimeoutMs,
        maximumFrameBytes: options.transport?.maximumFrameBytes, maximumInFlightRequests: options.transport?.maximumInFlightRequests,
        maximumStderrBytes: options.transport?.maximumStderrBytes, expectedProviderId: manifest.id,
        expectedProviderVersion: manifest.version, capabilityHost: this.broker, initialGeneration: previous?.lastGeneration ?? 0,
        attributionForGeneration: (generation, base) => ({ ...base,
          idempotencyKey: `${base.idempotencyKey}:generation:${generation}`,
          actionId: `${base.actionId}:generation:${generation}` }),
        beforeProcessStart: async (requestId, generation) => {
          const lease=await options.processCapacity?.acquire(generation,{
            ...structuredClone(serviceAttribution),idempotencyKey:`${serviceAttribution.idempotencyKey}:generation:${generation}`,
            actionId:`${serviceAttribution.actionId}:generation:${generation}`});
          try {
            options.supervision!.reserveGeneration(manifest, generation, this.maximumRestarts + 1, launchFingerprint);
            lease?.beforeStart(requestId);if(lease)capacityLeases.set(generation,lease);
          } catch(error) { lease?.finish(false);throw error; }
        },
        onProcessLifecycle: (event) => {
          try { recordLifecycle(options.supervision!, manifest, event); }
          finally { if(event.state==="failed" || event.state==="exited"){
            capacityLeases.get(event.generation)?.finish(event.state==="exited");capacityLeases.delete(event.generation);
          } }
        },
      });
    } else {
      if (options.supervision) throw new Error("Configured attestations cannot be written to trusted Scenario Process supervision");
      this.client = new ToolProviderProcessClient({
        ...options.transport,
        executable: options.launch.executable, arguments: options.launch.arguments, workingDirectory: options.launch.workingDirectory,
        environment: options.launch.environment ?? {}, attestation: options.launch.attestation, capabilityHost: this.broker,
      });
    }
  }

  async discover(signal?: AbortSignal): Promise<ExecutionToolAdapter[]> {
    this.options.assertAvailable?.();
    if (this.revokedReason) throw new Error(`Scenario Process is revoked: ${this.revokedReason}`);
    const specs = await this.client.listTools(signal);
    const status = this.client.status();
    const provider = status.provider;
    if (!provider || provider.profile !== SCENARIO_PROCESS_PROTOCOL
      || provider.providerId !== this.options.manifest.id || provider.providerVersion !== this.options.manifest.version) {
      await this.client.close();
      throw new Error("Scenario Process handshake profile or Package identity mismatch");
    }
    if (status.generation > this.maximumRestarts + 1) {
      await this.client.close();
      throw new Error("Scenario Process restart budget exhausted");
    }
    this.broker.activate(status.generation);
    this.options.assertAvailable?.();
    const allowed = new Set(this.options.manifest.providedCapabilities);
    return specs.map((spec) => {
      if (spec.source !== this.source || spec.version !== this.options.manifest.version) {
        throw new Error(`Scenario Process returned tool ${spec.name} for an unexpected Package source or version`);
      }
      const undeclared = [...spec.providedCapabilities, ...spec.dependencyCapabilities].filter((capability) => !allowed.has(capability));
      if (undeclared.length) throw new Error(`Scenario Process tool ${spec.name} uses undeclared capabilities: ${[...new Set(undeclared)].join(", ")}`);
      return { ...spec, execute: async (input, context) => {
        this.options.assertAvailable?.();
        const lease = await this.options.scheduler?.acquire({ providerId: this.options.manifest.id,
          providerVersion: this.options.manifest.version, toolName: spec.name, caseId: context.caseId,
          runId: context.runId, workId: context.workId }, context.signal);
        try { return await this.client.callTool(spec.name, input, context); }
        finally { lease?.release(); }
      } };
    });
  }

  async restart(): Promise<void> {
    if (this.revokedReason) throw new Error(`Scenario Process is revoked: ${this.revokedReason}`);
    await this.client.restart();
    const status = this.client.status();
    if (status.generation > this.maximumRestarts + 1) {
      await this.client.close();
      throw new Error("Scenario Process restart budget exhausted");
    }
    this.broker.activate(status.generation);
  }

  async revoke(reason: string): Promise<void> {
    if (this.revokedReason) return;
    this.revokedReason = required(reason, "Scenario Process revocation reason");
    this.options.supervision?.revoke(this.options.manifest, this.revokedReason);
    this.broker.revoke(this.revokedReason);
    await this.client.close();
  }

  close(): Promise<void> { return this.client.close(); }
  status(): ToolProviderProcessStatus & { protocol: typeof SCENARIO_PROCESS_PROTOCOL; protocolVersion: 1; revokedReason: string | null } {
    return { ...this.client.status(), protocol: SCENARIO_PROCESS_PROTOCOL,
      protocolVersion: SCENARIO_PROCESS_PROTOCOL_VERSION, revokedReason: this.revokedReason };
  }
  diagnostics(): Record<string, unknown> { return { scenarioProcess: this.status(), package: { id: this.options.manifest.id, version: this.options.manifest.version } }; }
}

export function validateScenarioProcessManifest(value: ScenarioProcessManifest): ScenarioProcessManifest {
  if (!value || value.protocol !== SCENARIO_PROCESS_PROTOCOL || value.protocolVersion !== SCENARIO_PROCESS_PROTOCOL_VERSION) {
    throw new Error("Scenario Process protocol is incompatible");
  }
  for (const [label, text] of [["id", value.id], ["version", value.version], ["source", value.source],
    ["entrypoint", value.entrypoint]] as const) required(text, `Scenario Process ${label}`);
  for (const values of [value.providedCapabilities, value.hostCapabilities]) {
    if (!Array.isArray(values) || values.some((entry) => typeof entry !== "string" || !entry.trim()) || new Set(values).size !== values.length) {
      throw new Error("Scenario Process capabilities must be unique non-empty identifiers");
    }
  }
  return value;
}

function required(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function bounded(value: string, label: string): string {
  const normalized = required(value, label);
  if (Buffer.byteLength(normalized) > 1024) throw new Error(`${label} exceeds its capacity`);
  return normalized;
}

function encodedBytes(value: unknown): number {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("undefined is not JSON");
    return Buffer.byteLength(encoded);
  }
  catch { throw new Error("Scenario Package capability value must be JSON serializable"); }
}

function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function snapshotContext(context: ToolExecutionContext): ToolExecutionContext {
  const { signal: _signal, ...copy } = context;
  return { ...structuredClone(copy) };
}

function withoutPermissions(context: ToolExecutionContext): Omit<ToolExecutionContext, "effectivePermissions"> {
  const { effectivePermissions: _permissions, signal: _signal, ...copy } = context;
  return structuredClone(copy);
}

function isExecutionNodeLaunch(value: ScenarioProcessLaunch): value is ScenarioExecutionNodeProcessLaunch {
  return "attribution" in value && "permissions" in value && "resources" in value;
}

function recordLifecycle(store: ScenarioProcessSupervisionStore, manifest: ScenarioProcessManifest,
  event: ExecutionNodeToolProviderLifecycleEvent): void {
  if (event.state === "started" || event.state === "ready") {
    store.recordLifecycle(manifest, event.generation, event.state, { proof: launchProof(event.process) });
    return;
  }
  if (event.state === "exited") {
    store.recordLifecycle(manifest, event.generation, "exited", { proof: launchProof(event.process),
      exitCode: event.process.exitCode, exitSignal: event.process.exitSignal });
    return;
  }
  store.recordLifecycle(manifest, event.generation, "failed", {
    ...(event.process ? { proof: launchProof(event.process) } : {}), error: event.error,
  });
}

function launchProof(process: ProcessDescriptor): ScenarioProcessLaunchProof {
  return {
    nodeId: process.nodeId, processId: process.id, pid: process.pid,
    sandboxBackend: process.enforcement.sandboxBackend,
    permissionProfileFingerprint: process.enforcement.permissionProfileFingerprint,
    resourceLimitsFingerprint: process.enforcement.resourceLimitsFingerprint,
    network: process.enforcement.network,
  };
}
