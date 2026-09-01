import { createHash } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { ExecutionNode } from "@traceforge/execution-node";
import type { EffectivePermissionProfile } from "@traceforge/orchestration-core";
import {
  ExecutionNodeToolProviderClient,
  ToolProviderSchedulingError,
  ToolProviderRecoverySupervisor,
  type ExecutionToolAdapter,
  type ExecutionToolDiscoverySource,
  type ProviderCapabilityHost,
  type ToolExecutionContext,
  type ToolExecutionResult,
  type ToolProviderRecoverySnapshot,
  type ToolProviderRecoveryStatePort,
  type ToolProviderDiagnosticWriter,
  type ToolProviderFairScheduler,
} from "@traceforge/worker-runtime";
import {
  resolveToolProviderEntrypoint,
  type ToolProviderInstallation,
} from "./tool-provider-control-plane.js";
import type { ManagedExecutionCapacity } from "./managed-execution-capacity.js";

export interface ManagedToolProviderRecoveryOptions {
  state: ToolProviderRecoveryStatePort;
  baseDelayMs?: number;
  maximumDelayMs?: number;
  failureBudget?: number;
  failureWindowMs?: number;
  stabilityWindowMs?: number;
  jitterRatio?: number;
  now?: () => Date;
  random?: () => number;
  onQuarantined?: (snapshot: ToolProviderRecoverySnapshot) => void;
  diagnostics?: ToolProviderDiagnosticWriter;
  scheduler?: ToolProviderFairScheduler;
  capacity?: ManagedExecutionCapacity;
}

export function createManagedToolProviderSourceFactory(
  node: ExecutionNode,
  workRootValue: string,
  capabilityHost?: ProviderCapabilityHost,
  recoveryOptions?: ManagedToolProviderRecoveryOptions,
): (installation: ToolProviderInstallation) => ExecutionToolDiscoverySource {
  if(recoveryOptions?.capacity && recoveryOptions.scheduler!==recoveryOptions.capacity.scheduler)throw new Error("Managed capacity requires its owning scheduler");
  if (!isAbsolute(workRootValue)) throw new Error("Managed Tool Provider work root must be absolute");
  mkdirSync(workRootValue, { recursive: true, mode: 0o700 });
  const workRoot = realpathSync(workRootValue);
  return (installation) => managedSource(node, workRoot, installation, capabilityHost, recoveryOptions);
}

function managedSource(
  node: ExecutionNode,
  workRoot: string,
  installation: ToolProviderInstallation,
  capabilityHost?: ProviderCapabilityHost,
  recoveryOptions?: ManagedToolProviderRecoveryOptions,
): ExecutionToolDiscoverySource {
  const { manifest } = installation;
  let recoverySnapshot: ToolProviderRecoverySnapshot | undefined;
  let notifiedQuarantineRevision = -1;
  const publishRecovery = (snapshot: ToolProviderRecoverySnapshot) => {
    recoverySnapshot = snapshot;
    if (snapshot.status === "quarantined" && snapshot.revision !== notifiedQuarantineRevision) {
      notifiedQuarantineRevision = snapshot.revision;
      recoveryOptions?.onQuarantined?.(structuredClone(snapshot));
    }
    return snapshot;
  };
  const recovery = recoveryOptions
    ? ToolProviderRecoverySupervisor.open({
      identity: { providerId: manifest.providerId, version: manifest.version },
      state: recoveryOptions.state,
      baseDelayMs: recoveryOptions.baseDelayMs ?? 1_000,
      maximumDelayMs: recoveryOptions.maximumDelayMs ?? 60_000,
      failureBudget: recoveryOptions.failureBudget ?? 5,
      failureWindowMs: recoveryOptions.failureWindowMs ?? 5 * 60_000,
      stabilityWindowMs: recoveryOptions.stabilityWindowMs ?? 60_000,
      jitterRatio: recoveryOptions.jitterRatio,
      now: recoveryOptions.now,
      random: recoveryOptions.random,
    }).then((supervisor) => {
      publishRecovery(supervisor.snapshot());
      return supervisor;
    })
    : undefined;
  return {
    source: manifest.source,
    async discover() {
      return manifest.tools.map((tool): ExecutionToolAdapter => ({
        ...tool,
        execute: (input, context) => executeWithRecovery(
          recovery,
          publishRecovery,
          () => executeScheduledManagedTool(
            recoveryOptions?.scheduler, recoveryOptions?.capacity, node, workRoot, installation, capabilityHost,
            recoveryOptions?.diagnostics, tool.name, tool.timeoutMs, input, context,
          ),
        ),
      }));
    },
    diagnostics() {
      const scheduling = recoveryOptions?.scheduler;
      const schedulingSnapshot = scheduling?.snapshot();
      return {
        managed: true,
        providerId: manifest.providerId,
        version: manifest.version,
        executionOwnership: "per-invocation",
        providerCapabilityHost: capabilityHost ? "enabled" : "disabled",
        scheduling: scheduling && schedulingSnapshot
          ? { status: "enabled", active: schedulingSnapshot.active, retained: schedulingSnapshot.retained, occupied: schedulingSnapshot.occupied, queued: schedulingSnapshot.queued, limits: { ...scheduling.limits } }
          : { status: "disabled" },
        recovery: recoveryOptions ? recoverySnapshot ?? { status: "initializing" } : { status: "disabled" },
      };
    },
  };
}

async function executeScheduledManagedTool(
  scheduler: ToolProviderFairScheduler | undefined,
  capacity: ManagedExecutionCapacity | undefined,
  node: ExecutionNode,
  workRoot: string,
  installation: ToolProviderInstallation,
  capabilityHost: ProviderCapabilityHost | undefined,
  diagnostics: ToolProviderDiagnosticWriter | undefined,
  toolName: string,
  timeoutMs: number,
  input: unknown,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const identity = {
    providerId: installation.manifest.providerId,
    providerVersion: installation.manifest.version,
    toolName,
    caseId: context.caseId,
    runId: context.runId,
    workId: context.workId,
  };
  const lease = await scheduler?.acquire(identity, context.signal);
  let reserved=false, terminalObserved=false;
  try {
    context.signal?.throwIfAborted();
    if(capacity){capacityOperation(()=>capacity.reserve(identity,installation.manifest.source,context));reserved=true;}
    return await executeManagedTool(
      node, workRoot, installation, capabilityHost, diagnostics, toolName, timeoutMs, input, context,
      capacity ? (requestId)=>capacityOperation(()=>capacity.beforeStart(context.idempotencyKey,requestId)) : undefined,
      ()=>{terminalObserved=true;},
    );
  } catch (error) {
    if (context.signal?.aborted) throw new ToolProviderSchedulingError("cancelled");
    throw error;
  } finally {
    try {if(reserved)capacityOperation(()=>capacity!.finish(context.idempotencyKey,terminalObserved));}
    finally {lease?.release();}
  }
}

function capacityOperation(operation:()=>void):void {
  try {operation();} catch(cause) {
    // Host storage/admission failures are not evidence that a Provider is unhealthy.
    throw Object.assign(new Error("Managed execution capacity is fenced",{cause}),{countsTowardProviderRecovery:false});
  }
}

async function executeWithRecovery(
  recovery: Promise<ToolProviderRecoverySupervisor> | undefined,
  publish: (snapshot: ToolProviderRecoverySnapshot) => ToolProviderRecoverySnapshot,
  execute: () => Promise<ToolExecutionResult>,
): Promise<ToolExecutionResult> {
  if (!recovery) return execute();
  const supervisor = await recovery;
  const current = publish(supervisor.snapshot());
  if (current.status === "quarantined") return recoveryUnavailable(current);
  if (current.status === "backoff" || current.status === "recovering") {
    let result: ToolExecutionResult | undefined;
    const attempt = await supervisor.runRecovery(async () => { result = await execute(); });
    publish(attempt.snapshot);
    if (attempt.recovered && result) return result;
    return recoveryUnavailable(attempt.snapshot);
  }
  try {
    const result = await execute();
    publish(await supervisor.observeHealthy());
    return result;
  } catch (error) {
    if (error && typeof error === "object" && "countsTowardProviderRecovery" in error
      && error.countsTowardProviderRecovery === false) throw error;
    publish(await supervisor.recordFailure(error));
    throw error;
  }
}

function recoveryUnavailable(snapshot: ToolProviderRecoverySnapshot): ToolExecutionResult {
  const failure = snapshot.failures.at(-1);
  const detail = snapshot.status === "quarantined"
    ? snapshot.quarantineReason ?? failure?.message ?? "Provider is quarantined"
    : snapshot.nextAttemptAt
      ? `recovery backoff until ${snapshot.nextAttemptAt}`
      : failure?.message ?? `Provider recovery is ${snapshot.status}`;
  return {
    status: "failed",
    summary: `Tool Provider unavailable: ${detail}`,
    raw: "",
    refs: [],
    retryable: snapshot.status !== "quarantined",
    metadata: { providerRecovery: structuredClone(snapshot) },
  };
}

async function executeManagedTool(
  node: ExecutionNode,
  workRoot: string,
  installation: ToolProviderInstallation,
  capabilityHost: ProviderCapabilityHost | undefined,
  diagnostics: ToolProviderDiagnosticWriter | undefined,
  toolName: string,
  timeoutMs: number,
  input: unknown,
  context: ToolExecutionContext,
  beforeProcessStart?: (requestId:string)=>void,
  terminalObserved?: ()=>void,
): Promise<ToolExecutionResult> {
  const { manifest } = installation;
  const scratch = invocationScratch(workRoot, context.runId, context.workId, context.idempotencyKey);
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const entrypoint = resolveToolProviderEntrypoint(manifest, installation.packageRoot);
  const permissions = providerPermissions(installation, scratch);
  const client = new ExecutionNodeToolProviderClient({
    beforeProcessStart,
    node,
    executable: entrypoint.executable,
    arguments: manifest.entrypoint.arguments,
    workingDirectory: entrypoint.workingDirectory,
    environment: {},
    attribution: {
      caseId: context.caseId,
      runId: context.runId,
      workId: context.workId,
      workerId: context.workerId,
      scopeRef: context.scopeRef,
      leaseId: context.leaseId,
      leaseExpiresAt: context.leaseExpiresAt,
      actionId: context.idempotencyKey,
      idempotencyKey: context.idempotencyKey,
    },
    permissions,
    resources: {
      cpuTimeMs: manifest.resources.cpuTimeMs,
      memoryBytes: manifest.resources.memoryBytes,
      maximumProcesses: manifest.resources.maximumProcesses,
      writeBytes: manifest.resources.maximumWriteBytes,
    },
    processTimeoutMs: timeoutMs + 5_000,
    requestTimeoutMs: timeoutMs,
    expectedProviderId: manifest.providerId,
    expectedProviderVersion: manifest.version,
    capabilityHost,
    diagnosticWriter: diagnostics,
  });
  const cancel = () => { void client.close().catch(() => undefined); }; // finally reports unconfirmed cleanup to Gateway
  if (context.signal?.aborted) {
    await client.close();
    throw new ToolProviderSchedulingError("cancelled");
  }
  context.signal?.addEventListener("abort", cancel, { once: true });
  try {
    return await client.callTool(toolName, input, context);
  } finally {
    context.signal?.removeEventListener("abort", cancel);
    await client.close();
    terminalObserved?.();
  }
}

function providerPermissions(
  installation: ToolProviderInstallation,
  scratch: string,
): EffectivePermissionProfile {
  const { manifest, packageRoot } = installation;
  return {
    version: 1,
    platform: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux",
    filesystem: {
      read: [
        { path: packageRoot, scope: "tree" },
        ...(manifest.permissions.filesystem === "scoped_write" ? [{ path: scratch, scope: "tree" } as const] : []),
      ],
      write: manifest.permissions.filesystem === "scoped_write" ? [{ path: scratch, scope: "tree" }] : [],
      deny: [],
    },
    network: manifest.permissions.network,
    process: { access: "sandboxed", interactive: false, background: false },
    secrets: manifest.permissions.secrets === "handles_only" ? "handles_only" : "deny",
    sources: ["tool-provider-manifest", `provider:${manifest.providerId}@${manifest.version}`],
  };
}

function invocationScratch(root: string, runId: string, workId: string, idempotencyKey: string): string {
  const identity = createHash("sha256").update(`${runId}\0${workId}\0${idempotencyKey}`).digest("hex");
  return join(root, identity.slice(0, 2), identity);
}
