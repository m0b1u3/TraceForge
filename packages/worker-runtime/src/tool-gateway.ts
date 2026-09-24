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
import { snapshotToolSpec } from "./tool-discovery-state.js";
import {parallelTool,parallelToolName,parallelInvocations,parallelResult} from "./parallel-tools.js";

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
  prepareParallel?(parentKey:string,children:ToolInvocationBindingInput[]):Promise<void>;
  recoverInvocation?(input: ToolInvocationReceiptIdentity): Promise<ToolInvocationRecovery>;
  validateCheckpoint?(assignment: WorkerAssignment, checkpoint: WorkerCheckpointDocument): void;
  prepare(binding: ToolInvocationBindingInput): Promise<ToolInvocationBinding>;
  complete(idempotencyKey: string): Promise<void>;
  release(idempotencyKey: string, reason: string): Promise<void>;
  hasOpenBindings(source: string, version: string): Promise<boolean>;
  closeAdmission(source: string, version: string, reason: string): Promise<void>;
  openAdmission(source: string, version: string): Promise<void>;
  assertReceiptIdentity(input: ToolInvocationReceiptIdentity): Promise<void>;
  beginExecution(idempotencyKey: string, leaseId: string, workerId: string, parallelParent?:string): Promise<void>;
  markUncertain(idempotencyKey: string, reason: string): Promise<void>;
  assertWorkReady(attribution: ToolInvocationBindingInput["attribution"],parallelParent?:string): Promise<void>;
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
  /** Host may require extra confirmation; never removes the high-risk gate. */
  requiresApproval?(input: { assignment: WorkerAssignment; tool: ExecutionToolSpec }): boolean;
  /** Immutable host policy revision consulted for this invocation. */
  approvalPolicyRef?(): string;
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
    if(request.invocation.tool===parallelToolName){
      const calls=parallelInvocations(request.invocation.input,request.invocation.id);
      const results:ToolExecutionResult[]=[];
      for(const call of calls){
        const key=`${request.assignment.work.idempotencyKey}:${call.id}`,saved=await this.receipts.get(key);
        if(!saved)break;
        await this.bindings.assertReceiptIdentity({idempotencyKey:key,invocationId:call.id,toolName:call.tool,inputFingerprint:toolInvocationInputFingerprint(call.tool,call.input),attribution:identity.attribution});
        results.push(saved);
      }
      if(results.length===calls.length){
        await this.bindings.assertReceiptIdentity(identity);
        const combined=parallelResult(calls,results);
        await this.receipts.put(request.idempotencyKey,combined);await this.bindings.complete(request.idempotencyKey);
        return {status:"recorded",result:combined};
      }
    }
    const recovered = await this.bindings.recoverInvocation(identity);
    if (recovered.status === "recorded") await this.bindings.complete(request.idempotencyKey);
    return recovered;
  }

  async catalog(worker: WorkerDescriptor, assignment: WorkerAssignment, signal?: AbortSignal,parallelParent?:string): Promise<ExecutionToolCatalog> {
    signal?.throwIfAborted();
    await this.bindings?.assertWorkReady({ caseId: assignment.runContext.caseId, runId: assignment.runId, workId: assignment.work.id },parallelParent);
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
      .map(snapshotToolSpec)
      .sort((left, right) => left.name.localeCompare(right.name));
    if(this.bindings?.prepareParallel&&tools.some(t=>t.risk==="read_only"))tools.push(parallelTool);
    return { tools, requestedCapabilities: resolution.requestedCapabilities, unresolvedCapabilities: resolution.unresolvedCapabilities, registryRevision: resolution.registryRevision };
  }

  async execute(request: Parameters<ExecutionToolGateway["execute"]>[0]): Promise<ToolExecutionResult> {
    return this.executeInternal(request);
  }
  private async executeInternal(request:Parameters<ExecutionToolGateway["execute"]>[0],parallelParent?:string):Promise<ToolExecutionResult> {
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
    const catalog = await this.catalog(request.worker, request.assignment, request.signal,parallelParent);
    const batch=request.invocation.tool===parallelToolName;
    const children=batch?parallelInvocations(request.invocation.input,request.invocation.id):[];
    if(batch&&children.some(c=>!catalog.tools.some(t=>t.name===c.tool&&t.risk==="read_only")))throw new Error("Parallel calls must be authorized read-only tools");
    if(batch&&children.some(c=>this.policy.requiresApproval?.({assignment:request.assignment,tool:catalog.tools.find(t=>t.name===c.tool)!})))throw new Error("Tools requiring individual approval must be invoked separately");
    const tool:ExecutionToolAdapter|undefined = batch?{...parallelTool,execute:async(_input,context)=>{
      const settled=await Promise.allSettled(children.map(invocation=>this.executeInternal({...request,invocation,
        idempotencyKey:`${request.assignment.work.idempotencyKey}:${invocation.id}`,expectedContractFingerprint:executionToolContractFingerprint(catalog.tools.find(t=>t.name===invocation.tool)!),signal:context.signal,
        onProgress:progress=>request.onProgress?.({...progress,text:`${invocation.tool}: ${progress.text??progress.phase}`})},request.idempotencyKey)));
      const failed=settled.find(r=>r.status==="rejected");if(failed?.status==="rejected")throw failed.reason;
      if(settled.some(r=>r.status==="fulfilled"&&r.value.status==="approval_required"))throw new ToolInvocationRecoveryRequiredError("Parallel approval policy changed; reconcile pending reads individually");
      return parallelResult(children,settled.map(r=>(r as PromiseFulfilledResult<ToolExecutionResult>).value));
    }}:this.registry.get(request.invocation.tool)?.provider;
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
    const approvalPolicyRef = this.policy.approvalPolicyRef?.();
    let approvalReason: string | undefined;
    if ((tool.risk === "privileged" || tool.risk === "destructive" || this.policy.requiresApproval?.({ assignment: request.assignment, tool })) && !hasDurableGrant) {
      const approval = await waitForCancellation(() => this.approvals.authorize({ worker: request.worker, assignment: request.assignment, tool, invocation: request.invocation }), request.signal);
      request.signal?.throwIfAborted();
      if (approval.decision === "approved") approvalReason = approval.reason;
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
    if(batch)await this.bindings!.prepareParallel!(request.idempotencyKey,children.map(invocation=>{
      const spec=catalog.tools.find(t=>t.name===invocation.tool)!;
      return {idempotencyKey:`${request.assignment.work.idempotencyKey}:${invocation.id}`,invocationId:invocation.id,
        tool:{name:spec.name,source:spec.source,version:spec.version,contractFingerprint:executionToolContractFingerprint(spec)},
        inputFingerprint:toolInvocationInputFingerprint(spec.name,invocation.input),attribution:{caseId:request.assignment.runContext.caseId,runId:request.assignment.runId,workId:request.assignment.work.id}};
    }));
    await this.bindings?.beginExecution(request.idempotencyKey, request.assignment.leaseId, request.worker.id,parallelParent);
    let result: ToolExecutionResult;
    try {
      result = await withTimeout(
        (signal) => {
          this.assertAuthorized({worker:request.worker,assignment:request.assignment,tool});
          signal.throwIfAborted();
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
          let progressOpen = true;
          Object.defineProperty(context, "onProgress", { value: (progress: { phase: "dispatched" | "output" | "command"; text?: string }) => {
            if (progressOpen && !signal.aborted) request.onProgress?.(progress);
          }, enumerable: false });
          context.onProgress?.({ phase: "dispatched" });
          return tool.execute(request.invocation.input, context).finally(() => { progressOpen = false; });
        },
        tool.timeoutMs,
        request.signal,
      );
    } catch (error) {
      const confirmedNotStarted = executionOutcome(error) === "not_started";
      if (this.bindings && !confirmedNotStarted) {
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
    result = {
      ...result,
      metadata: { ...result.metadata, effectivePermissions, ...(approvalPolicyRef ? { approvalPolicyRef } : {}), ...(approvalReason ? { approvalReason } : {}) },
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

function executionOutcome(error: unknown): "not_started" | undefined {
  return error && typeof error === "object" && "executionOutcome" in error && error.executionOutcome === "not_started"
    ? "not_started" : undefined;
}

export function createExecutionToolRegistry(
  adapters: ExecutionToolAdapter[],
): CapabilityProviderRegistry<ExecutionToolAdapter> {
  const registry = new CapabilityProviderRegistry<ExecutionToolAdapter>();
  for (const adapter of adapters) {
    if (!Number.isSafeInteger(adapter.timeoutMs)||adapter.timeoutMs < 0) throw new Error(`Execution tool ${adapter.name} requires a nonnegative timeout`);
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
    if(timeoutMs>0)timer = setTimeout(() => cancellation.abort(new ToolExecutionTimeoutError(`Tool timed out after ${timeoutMs}ms`)), timeoutMs);
    return await waitForCancellation(() => operation(cancellation.signal), cancellation.signal);
  } finally {
    if (timer) clearTimeout(timer);
    parent?.removeEventListener("abort", abort);
  }
}
