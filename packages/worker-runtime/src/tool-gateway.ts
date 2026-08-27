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
    if (recorded) return recorded;
    const tool = this.registry.get(request.invocation.tool)?.provider;
    const eligible = tool && (await this.catalog(request.worker, request.assignment)).tools.some((candidate) => candidate.name === tool.name);
    if (!tool || !eligible) throw new Error(`Tool ${request.invocation.tool} is unknown or outside worker policy`);
    const effectivePermissions = intersectPermissionProfiles(this.policy.permissionLayers({
      worker: request.worker,
      assignment: request.assignment,
      tool,
    }));

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
        if (approval.decision === "rejected") await this.receipts.put(request.idempotencyKey, result);
        return result;
      }
    }

    let result: ToolExecutionResult;
    try {
      result = await withTimeout(
        () => tool.execute(request.invocation.input, {
          workerId: request.worker.id,
          runId: request.assignment.runId,
          workId: request.assignment.work.id,
          caseId: request.assignment.runContext.caseId,
          scopeRef: request.assignment.runContext.scopeRef,
          leaseId: request.assignment.leaseId,
          leaseExpiresAt: request.assignment.leaseExpiresAt,
          idempotencyKey: request.idempotencyKey,
          effectivePermissions,
        }),
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

async function withTimeout<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Tool timed out after ${timeoutMs}ms`)), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
