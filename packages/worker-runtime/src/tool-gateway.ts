import {
  intersectPermissionProfiles,
  satisfiesPermissionRequirements,
  type PermissionProfileLayer,
  type WorkerDescriptor,
} from "@traceforge/orchestration-core";
import { CapabilityProviderRegistry } from "@traceforge/tool-resolver";
import type {
  ExecutionRisk,
  ExecutionToolGateway,
  ExecutionToolCatalog,
  ExecutionToolSpec,
  ToolExecutionResult,
  ToolExecutionContext,
  ToolInvocation,
  WorkerAssignment,
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
  prepare(binding: ToolInvocationBindingInput): Promise<ToolInvocationBinding>;
  complete(idempotencyKey: string): Promise<void>;
  release(idempotencyKey: string, reason: string): Promise<void>;
  hasOpenBindings(source: string, version: string): Promise<boolean>;
  closeAdmission(source: string, version: string, reason: string): Promise<void>;
  openAdmission(source: string, version: string): Promise<void>;
}

export interface ToolGatewayPolicy {
  allowedRisks: ExecutionRisk[];
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

  async catalog(worker: WorkerDescriptor, assignment: WorkerAssignment): Promise<ExecutionToolCatalog> {
    await this.discovery?.refreshDue();
    const names = this.policy.allowedTools ? new Set(this.policy.allowedTools) : undefined;
    const resolution = this.registry.resolve(assignment.work.requiredCapabilities, ({ provider: tool }) => {
      if ((names && !names.has(tool.name)) || !this.policy.allowedRisks.includes(tool.risk) || !hasCapabilities(tool.providedCapabilities, worker)) return false;
      const effective = intersectPermissionProfiles(this.policy.permissionLayers({ worker, assignment, tool }));
      return satisfiesPermissionRequirements(effective, tool.permissionRequirements);
    });
    const tools = resolution.providers
      .map(({ execute: _execute, ...spec }) => spec)
      .sort((left, right) => left.name.localeCompare(right.name));
    return { tools, requestedCapabilities: resolution.requestedCapabilities, unresolvedCapabilities: resolution.unresolvedCapabilities, registryRevision: resolution.registryRevision };
  }

  async execute(request: {
    worker: WorkerDescriptor;
    assignment: WorkerAssignment;
    invocation: ToolInvocation;
    idempotencyKey: string;
  }): Promise<ToolExecutionResult> {
    const recorded = await this.receipts.get(request.idempotencyKey);
    if (recorded) {
      await this.bindings?.complete(request.idempotencyKey);
      return recorded;
    }
    const tool = this.registry.get(request.invocation.tool)?.provider;
    const eligible = tool && (await this.catalog(request.worker, request.assignment)).tools.some((candidate) => candidate.name === tool.name);
    if (!tool || !eligible) throw new Error(`Tool ${request.invocation.tool} is unknown or outside worker policy`);
    const effectivePermissions = intersectPermissionProfiles(this.policy.permissionLayers({
      worker: request.worker,
      assignment: request.assignment,
      tool,
    }));
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
      const approval = await this.approvals.authorize({ worker: request.worker, assignment: request.assignment, tool, invocation: request.invocation });
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

    let result: ToolExecutionResult;
    try {
      result = await withTimeout(
        (signal) => {
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
      );
    } catch (error) {
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
    await this.receipts.put(request.idempotencyKey, result);
    await this.bindings?.complete(request.idempotencyKey);
    return result;
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
  for (const source of sources) registry.synchronize(source, adapters.filter((adapter) => adapter.source === source));
  return registry;
}

async function withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancellation = new AbortController();
  try {
    return await Promise.race([
      operation(cancellation.signal),
      new Promise<never>((_, reject) => { timer = setTimeout(() => {
        cancellation.abort();
        reject(new Error(`Tool timed out after ${timeoutMs}ms`));
      }, timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
