import {
  intersectPermissionProfiles,
  satisfiesPermissionRequirements,
  type PermissionProfileLayer,
  type WorkerDescriptor,
} from "@traceforge/orchestration-core";
import { CapabilityProviderRegistry } from "@traceforge/tool-resolver";
import { waitForCancellation } from "./cancellation.js";
import type {
  ExecutionRisk,
  ExecutionToolGateway,
  ExecutionToolCatalog,
  ExecutionToolSpec,
  ToolExecutionResult,
  ToolExecutionContext,
  ToolInvocation,
  WorkerAssignment,
  WorkerCheckpointDocument,
  ToolInvocationRecovery,
} from "./model.js";
import type { ExecutionToolDiscoveryRuntime } from "./tool-discovery.js";
import { executionToolContractFingerprint, toolInvocationInputFingerprint } from "./tool-provider-contract.js";

export interface ExecutionToolAdapter extends ExecutionToolSpec {
  execute(input: unknown, context: ToolExecutionContext): Promise<ToolExecutionResult>;
}

export interface ToolApprovalController {
  authorize(input: {
    worker: WorkerDescriptor;
    assignment: WorkerAssignment;
    tool: ExecutionToolSpec;
    invocation: ToolInvocation;
  }): Promise<{ decision: "approved" | "rejected" | "pending"; approvalRef?: string; reason?: string }>;
}

export interface ToolReceiptStore {
  get(idempotencyKey: string): Promise<ToolExecutionResult | undefined>;
  put(idempotencyKey: string, result: ToolExecutionResult): Promise<void>;
}

export type ToolInvocationBindingStatus = "prepared" | "completed" | "released";

export interface ToolInvocationBindingInput {
  idempotencyKey: string;
  invocationId: string;
  tool: { name: string; source: string; version: string; contractFingerprint: string };
  inputFingerprint: string;
  attribution: { caseId: string; runId: string; workId: string };
}

export interface ToolInvocationBinding extends ToolInvocationBindingInput {
  schemaVersion: 1;
  status: ToolInvocationBindingStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ToolInvocationBindingStore {
  recoverInvocation?(input: ToolInvocationReceiptIdentity): Promise<ToolInvocationRecovery>;
  validateCheckpoint?(assignment: WorkerAssignment, checkpoint: WorkerCheckpointDocument): void;
  prepare(binding: ToolInvocationBindingInput): Promise<ToolInvocationBinding>;
  complete(idempotencyKey: string): Promise<void>;
  release(idempotencyKey: string, reason: string): Promise<void>;
  hasOpenBindings(source: string, version: string): Promise<boolean>;
  closeAdmission(source: string, version: string, reason: string): Promise<void>;
  openAdmission(source: string, version: string): Promise<void>;
  assertReceiptIdentity(input: ToolInvocationReceiptIdentity): Promise<void>;
  beginExecution(idempotencyKey: string, leaseId: string, workerId: string): Promise<void>;
  markUncertain(idempotencyKey: string, reason: string): Promise<void>;
  assertWorkReady(attribution: ToolInvocationBindingInput["attribution"]): Promise<void>;
}

export interface ToolInvocationReceiptIdentity {
  idempotencyKey: string;
  invocationId: string;
  toolName: string;
  inputFingerprint: string;
  attribution: { caseId: string; runId: string; workId: string };
}

export class ToolInvocationRecoveryRequiredError extends Error {
  constructor(message: string) { super(message); this.name = "ToolInvocationRecoveryRequiredError"; }
}

class ToolExecutionTimeoutError extends Error {}

export interface ToolGatewayPolicy {
  allowedRisks: ExecutionRisk[];
  /** Current host authorization, checked again immediately before dispatch; throws to fail closed. */
  assertAuthorized?(input:{worker:WorkerDescriptor;assignment:WorkerAssignment;tool:ExecutionToolSpec}):void;
  allowedTools?: string[];
  permissionLayers(input: {
    worker: WorkerDescriptor;
    assignment: WorkerAssignment;
    tool: ExecutionToolSpec;
  }): PermissionProfileLayer[];
}

function hasCapabilities(required: string[], worker: WorkerDescriptor): boolean {
  const available = new Set(worker.capabilities);
  return required.every((capability) => available.has(capability));
}

export class PolicyExecutionToolGateway implements ExecutionToolGateway {
  constructor(
    private readonly registry: CapabilityProviderRegistry<ExecutionToolAdapter>,
    private readonly approvals: ToolApprovalController,
    private readonly receipts: ToolReceiptStore,
    private readonly policy: ToolGatewayPolicy,
    private readonly discovery?: ExecutionToolDiscoveryRuntime,
    private readonly bindings?: ToolInvocationBindingStore,
  ) {}

  async validateCheckpoint(assignment: WorkerAssignment, checkpoint: WorkerCheckpointDocument): Promise<void> {
    this.bindings?.validateCheckpoint?.(assignment, checkpoint);
  }

  async recover(request: Parameters<ExecutionToolGateway["execute"]>[0]): Promise<ToolInvocationRecovery> {
    if (!this.bindings?.recoverInvocation) throw new ToolInvocationRecoveryRequiredError("Durable invocation recovery is unavailable");
    const identity: ToolInvocationReceiptIdentity = {
      idempotencyKey: request.idempotencyKey, invocationId: request.invocation.id, toolName: request.invocation.tool,
      inputFingerprint: toolInvocationInputFingerprint(request.invocation.tool, request.invocation.input),
      attribution: { caseId: request.assignment.runContext.caseId, runId: request.assignment.runId, workId: request.assignment.work.id },
    };
    const result = await this.receipts.get(request.idempotencyKey);
    if (result) {
      await this.bindings.assertReceiptIdentity(identity);
      await this.bindings.complete(request.idempotencyKey);
      return { status: "recorded", result };
    }
    const recovered = await this.bindings.recoverInvocation(identity);
    if (recovered.status === "recorded") await this.bindings.complete(request.idempotencyKey);
    return recovered;
  }

  async catalog(worker: WorkerDescriptor, assignment: WorkerAssignment, signal?: AbortSignal): Promise<ExecutionToolCatalog> {
    signal?.throwIfAborted();
    await this.bindings?.assertWorkReady({ caseId: assignment.runContext.caseId, runId: assignment.runId, workId: assignment.work.id });
    await waitForCancellation(async () => this.discovery?.refreshDue(), signal);
    signal?.throwIfAborted();
    const names = this.policy.allowedTools ? new Set(this.policy.allowedTools) : undefined;
    const resolution = this.registry.resolve(assignment.work.requiredCapabilities, ({ provider: tool }) => {
      this.assertAuthorized({worker,assignment,tool});
      if ((names && !names.has(tool.name)) || !this.policy.allowedRisks.includes(tool.risk) || !hasCapabilities(tool.providedCapabilities, worker)) return false;
      const effective = intersectPermissionProfiles(this.policy.permissionLayers({ worker, assignment, tool }));
      return satisfiesPermissionRequirements(effective, tool.permissionRequirements);
    });
    const tools = resolution.providers
      .map(({ execute: _execute, ...spec }) => spec)
      .sort((left, right) => left.name.localeCompare(right.name));
    return { tools, requestedCapabilities: resolution.requestedCapabilities, unresolvedCapabilities: resolution.unresolvedCapabilities, registryRevision: resolution.registryRevision };
  }

  async execute(request: Parameters<ExecutionToolGateway["execute"]>[0]): Promise<ToolExecutionResult> {
    request.signal?.throwIfAborted();
    const recorded = await this.receipts.get(request.idempotencyKey);
    if (recorded) {
      await this.bindings?.assertReceiptIdentity({
        idempotencyKey: request.idempotencyKey, invocationId: request.invocation.id, toolName: request.invocation.tool,
        inputFingerprint: toolInvocationInputFingerprint(request.invocation.tool, request.invocation.input),
        attribution: { caseId: request.assignment.runContext.caseId, runId: request.assignment.runId, workId: request.assignment.work.id },
      });
      await this.bindings?.complete(request.idempotencyKey);
      return recorded;
    }
    const catalog = await this.catalog(request.worker, request.assignment, request.signal);
    const tool = this.registry.get(request.invocation.tool)?.provider;
    const eligible = tool && catalog.tools.some((candidate) => candidate.name === tool.name
      && executionToolContractFingerprint(candidate) === executionToolContractFingerprint(tool));
    if (!tool || !eligible) throw new Error(`Tool ${request.invocation.tool} is unknown or outside worker policy`);
    if (request.expectedContractFingerprint && executionToolContractFingerprint(tool) !== request.expectedContractFingerprint) {
      throw new ToolInvocationRecoveryRequiredError("Tool contract changed after invocation checkpoint was committed");
    }
    const effectivePermissions = intersectPermissionProfiles(this.policy.permissionLayers({
      worker: request.worker,
      assignment: request.assignment,
      tool,
    }));
    request.signal?.throwIfAborted();
    await this.bindings?.prepare({
      idempotencyKey: request.idempotencyKey,
      invocationId: request.invocation.id,
      tool: {
        name: tool.name,
        source: tool.source,
        version: tool.version,
        contractFingerprint: executionToolContractFingerprint(tool),
      },
      inputFingerprint: toolInvocationInputFingerprint(tool.name, request.invocation.input),
      attribution: {
        caseId: request.assignment.runContext.caseId,
        runId: request.assignment.runId,
        workId: request.assignment.work.id,
      },
    });

    const hasDurableGrant = request.assignment.work.grantedActionKeys.includes(request.idempotencyKey);
    if ((tool.risk === "privileged" || tool.risk === "destructive") && !hasDurableGrant) {
      const approval = await waitForCancellation(() => this.approvals.authorize({ worker: request.worker, assignment: request.assignment, tool, invocation: request.invocation }), request.signal);
      request.signal?.throwIfAborted();
      if (approval.decision !== "approved") {
        const result: ToolExecutionResult = {
          status: approval.decision === "pending" ? "approval_required" : "failed",
          summary: approval.reason ?? `Tool ${tool.name} was not approved`,
          raw: "",
          refs: [],
          retryable: approval.decision === "pending",
          approvalRef: approval.approvalRef,
          metadata: { effectivePermissions },
        };
        if (approval.decision === "rejected") {
          await this.receipts.put(request.idempotencyKey, result);
          await this.bindings?.complete(request.idempotencyKey);
        }
        return result;
      }
    }

    request.signal?.throwIfAborted();
    this.assertAuthorized({worker:request.worker,assignment:request.assignment,tool});
    await this.bindings?.beginExecution(request.idempotencyKey, request.assignment.leaseId, request.worker.id);
    let result: ToolExecutionResult;
    try {
      result = await withTimeout(
        (signal) => {
          this.assertAuthorized({worker:request.worker,assignment:request.assignment,tool});
          const context: ToolExecutionContext = {
          workerId: request.worker.id,
          runId: request.assignment.runId,
          workId: request.assignment.work.id,
          caseId: request.assignment.runContext.caseId,
          scopeRef: request.assignment.runContext.scopeRef,
          leaseId: request.assignment.leaseId,
          leaseExpiresAt: request.assignment.leaseExpiresAt,
          idempotencyKey: request.idempotencyKey,
          effectivePermissions,
          };
          Object.defineProperty(context, "signal", { value: signal, enumerable: false });
          return tool.execute(request.invocation.input, context);
        },
        tool.timeoutMs,
        request.signal,
      );
    } catch (error) {
      if (this.bindings) {
        const reason = error instanceof ToolExecutionTimeoutError
          ? `Tool ${tool.name} timed out; execution outcome requires reconciliation`
          : `Tool ${tool.name} threw before confirming a terminal result; execution outcome requires reconciliation: ${error instanceof Error ? error.message : "unknown failure"}`;
        return this.requireRecovery(request.idempotencyKey, reason);
      }
      const message = error instanceof Error ? error.message : "Unknown execution tool failure";
      const explicitlyRetryable = Boolean(error && typeof error === "object" && "retryable" in error && error.retryable === true);
      result = {
        status: "failed",
        summary: `Tool ${tool.name} failed: ${message}`,
        raw: "",
        refs: [],
        retryable: explicitlyRetryable || /(?:timed out|timeout|temporar|network|fetch|ECONN|EAI_AGAIN)/i.test(message),
        metadata: { errorType: error instanceof Error ? error.name : "UnknownError" },
      };
    }
    if (result.status === "succeeded") this.registry.recordSuccess(tool.name);
    else if (result.retryable) this.registry.recordFailure(tool.name, result.summary);
    result = {
      ...result,
      metadata: { ...result.metadata, effectivePermissions },
    };
    try { await this.receipts.put(request.idempotencyKey, result); }
    catch (error) {
      if (!this.bindings) throw error;
      const reason = `Tool execution returned but its receipt could not be confirmed: ${error instanceof Error ? error.message : "persistence failure"}`;
      return this.requireRecovery(request.idempotencyKey, reason);
    }
    await this.bindings?.complete(request.idempotencyKey);
    return result;
  }

  private assertAuthorized(input:Parameters<NonNullable<ToolGatewayPolicy["assertAuthorized"]>>[0]):void {
    const result:unknown=this.policy.assertAuthorized?.(input);
    if(result!==undefined){void Promise.resolve(result).catch(()=>{});throw new Error("Host authorization must be synchronous");}
  }

  private async requireRecovery(idempotencyKey: string, reason: string): Promise<never> {
    try { await this.bindings?.markUncertain(idempotencyKey, reason); }
    catch (error) { reason += `; uncertainty audit also failed: ${error instanceof Error ? error.message : "persistence failure"}`; }
    throw new ToolInvocationRecoveryRequiredError(reason);
  }
}

export function createExecutionToolRegistry(
  adapters: ExecutionToolAdapter[],
  unavailableAfterFailures = 3,
): CapabilityProviderRegistry<ExecutionToolAdapter> {
  const registry = new CapabilityProviderRegistry<ExecutionToolAdapter>(unavailableAfterFailures);
  for (const adapter of adapters) {
    if (adapter.timeoutMs < 1) throw new Error(`Execution tool ${adapter.name} requires a positive timeout`);
  }
  const sources = [...new Set(adapters.map((adapter) => adapter.source))];
  for (const source of sources) registry.synchronize(source, adapters.filter((adapter) => adapter.source === source)
    .map((adapter) => ({ ...adapter, execute: adapter.execute.bind(adapter) })));
  return registry;
}

async function withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number, parent?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancellation = new AbortController();
  const abort = () => cancellation.abort(parent?.reason ?? new DOMException("Tool cancelled", "AbortError"));
  parent?.addEventListener("abort", abort, { once: true });
  if (parent?.aborted) abort();
  try {
    timer = setTimeout(() => cancellation.abort(new ToolExecutionTimeoutError(`Tool timed out after ${timeoutMs}ms`)), timeoutMs);
    return await waitForCancellation(() => operation(cancellation.signal), cancellation.signal);
  } finally {
    if (timer) clearTimeout(timer);
    parent?.removeEventListener("abort", abort);
  }
}
