import { describe, expect, it } from "vitest";
import type { ScenarioWorkItem, WorkerDescriptor, ScenarioRunState } from "@traceforge/orchestration-core";
import { BoundedOutputDistiller } from "./distiller.js";
import type {
  ExecutionToolGateway,
  WorkerAssignment,
  WorkerCheckpointDocument,
  WorkerCheckpointStore,
  WorkerControlPlaneClient,
  WorkerDecision,
  WorkerModel,
  WorkerObserver,
  WorkerOutputDraft,
} from "./model.js";
import { LoopGuardObserver } from "./observer.js";
import { ToolInvocationRecoveryRequiredError } from "./tool-gateway.js";
import { LeaseLostError, WorkerHost, type WorkerLifecycleEvent } from "./runtime.js";
import { executionToolContractFingerprint } from "./tool-provider-contract.js";

const worker: WorkerDescriptor = {
  id: "worker_1",
  roles: ["researcher"],
  capabilities: ["evidence.read"],
  maxConcurrentWork: 1,
  status: "online",
  heartbeatAt: "2026-08-24T08:00:00.000Z",
};

function work(): ScenarioWorkItem {
  return {
    id: "work_1", runId: "run_1", phaseId: "mapping", kind: "research", title: "Collect facts",
    objective: "Collect attributable observations", priority: 50, status: "running", allowedWorkerRoles: ["researcher"],
    requiredCapabilities: [], hypothesisIds: [], evidenceRefs: [], workerId: "worker_1", leaseId: "lease_1",
    leaseExpiresAt: "2026-08-24T09:00:00.000Z", attempt: 1, maxAttempts: 3, idempotencyKey: "effect_1",
    latestCheckpoint: null, resumeFromCheckpoint: false, pendingApproval: null, approvalHistory: [], grantedActionKeys: [],
    resultSummary: null, error: null, createdAt: "2026-08-24T08:00:00.000Z",
    startedAt: "2026-08-24T08:00:01.000Z", finishedAt: null,
  };
}

function assignment(): WorkerAssignment {
  return {
    runId: "run_1", leaseId: "lease_1", leaseExpiresAt: "2026-08-24T09:00:00.000Z", runRevision: 3,
    runContext: { caseId: "case_1", goal: "Assess scope", scopeRef: "scope_1", activePhaseId: "mapping", directives: [] },
    work: work(),
  };
}

class MemoryCheckpoints implements WorkerCheckpointStore {
  document?: WorkerCheckpointDocument;
  async save(document: WorkerCheckpointDocument) { this.document = structuredClone(document); return "checkpoint://work.json"; }
  async load() { if (!this.document) throw new Error("missing checkpoint"); return structuredClone(this.document); }
}

class FakeControl implements WorkerControlPlaneClient {
  completed?: { summary: string; outputs: WorkerOutputDraft[] };
  blocked?: string;
  failed?: string;
  approval?: { approvalId: string; actionKey: string };
  checkpoints = 0;
  constructor(public current = assignment()) {}
  async register() {}
  async heartbeat() {}
  async assignments() { return [this.current]; }
  async refresh() { return this.current; }
  async renew(value: WorkerAssignment) { return this.bump(value); }
  async checkpoint(value: WorkerAssignment, input: { payloadRef: string; checkpointId: string }) {
    this.checkpoints += 1;
    const next = this.bump(value);
    next.work.latestCheckpoint = {
      id: input.checkpointId, workId: value.work.id, leaseId: value.leaseId,
      progressSummary: "saved", payloadRef: input.payloadRef, createdAt: "2026-08-24T08:00:00.000Z",
    };
    this.current = next;
    return next;
  }
  async complete(_value: WorkerAssignment, _commandId: string, summary: string, outputs: WorkerOutputDraft[]) { this.completed = { summary, outputs }; }
  async requestApproval(_value: WorkerAssignment, input: Parameters<WorkerControlPlaneClient["requestApproval"]>[1]) { this.approval = input; }
  async fail(_value: WorkerAssignment, _commandId: string, reason: string) { this.failed = reason; }
  async block(_value: WorkerAssignment, _commandId: string, reason: string) { this.blocked = reason; }
  private bump(value: WorkerAssignment) { return { ...value, work: { ...value.work }, runRevision: value.runRevision + 1 }; }
}

class SequenceModel implements WorkerModel {
  constructor(private readonly decisions: WorkerDecision[]) {}
  async decide() { const decision = this.decisions.shift(); if (!decision) throw new Error("no decision"); return decision; }
}

const continueObserver: WorkerObserver = { async review() { return { action: "continue" }; } };
const resolvedCatalog = (tools: Awaited<ReturnType<ExecutionToolGateway["catalog"]>>["tools"]) => ({
  tools, requestedCapabilities: [], unresolvedCapabilities: [], registryRevision: 1,
});

describe("WorkerHost", () => {
  it("cancels uncooperative inference and ignores its late action", async () => {
    const control = new FakeControl(); let release!: (value: WorkerDecision) => void; let started!: () => void;
    const ready = new Promise<void>((r) => { started = r; }); let observed: AbortSignal | undefined;
    const runtime = new WorkerHost(worker, control, { decide(_request, signal) { observed = signal; started(); return new Promise((resolve) => { release = resolve; }); } },
      { async catalog() { return resolvedCatalog([]); }, async execute() { throw new Error("must not dispatch"); } }, continueObserver, new MemoryCheckpoints(), new BoundedOutputDistiller());
    const execution = runtime.execute(assignment()); await ready; runtime.cancelAll("operator stopped");
    expect((await execution).outcome).toBe("lease_lost"); expect(observed?.aborted).toBe(true);
    release({ type: "complete", summary: "late", outputs: [] }); await new Promise((r) => setTimeout(r, 0));
    expect(control.completed).toBeUndefined(); expect(control.failed).toBeUndefined(); expect(control.checkpoints).toBe(0);
  });
  it("only revokes the matching Run and lease when applying control-plane ownership changes", async () => {
    const control = new FakeControl(); let signal: AbortSignal | undefined, started!: () => void;
    const ready = new Promise<void>((r) => { started = r; });
    const runtime = new WorkerHost(worker, control, { async decide(_request, value) { signal = value; started(); return new Promise(() => {}); } },
      { async catalog() { return resolvedCatalog([]); }, async execute() { throw new Error("must not dispatch"); } }, continueObserver, new MemoryCheckpoints(), new BoundedOutputDistiller());
    const execution = runtime.execute(assignment()); await ready;
    runtime.reconcileRun({ id: "other_run", status: "cancelled", workItems: [] } as unknown as ScenarioRunState); expect(signal!.aborted).toBe(false);
    runtime.reconcileRun({ id: "run_1", status: "running", workItems: [work()] } as unknown as ScenarioRunState); expect(signal!.aborted).toBe(false);
    runtime.reconcileRun({ id: "run_1", status: "running", workItems: [{ ...work(), leaseId: "replacement" }] } as unknown as ScenarioRunState);
    expect((await execution).outcome).toBe("lease_lost"); expect(signal!.aborted).toBe(true);
  });
  it.each(["lost", "expired", "unresponsive"])("interrupts inference when ownership is %s", async (mode) => {
    const control = new FakeControl(); let reads = 0;
    control.refresh = async () => {
      if (++reads === 1) return control.current;
      if (mode === "lost") throw new LeaseLostError("ownership changed");
      if (mode === "unresponsive") return new Promise(() => {});
      return { ...control.current, leaseExpiresAt: "2020-01-01" };
    };
    const runtime = new WorkerHost(worker, control, { async decide() { return new Promise(() => {}); } },
      { async catalog() { return resolvedCatalog([]); }, async execute() { throw new Error("must not dispatch"); } }, continueObserver, new MemoryCheckpoints(), new BoundedOutputDistiller(), { ownershipPollMs: 10 });
    expect((await runtime.execute(assignment())).outcome).toBe("lease_lost"); expect(control.completed).toBeUndefined();
  });
  it("does not dispatch after cancellation during pending checkpoint persistence", async () => {
    const control = new FakeControl(), checkpoints = new MemoryCheckpoints(); let dispatches = 0;
    const runtime = new WorkerHost(worker, control, new SequenceModel([{ type: "invoke_tool", invocation: { id: "first", tool: "read", input: {}, rationale: "Observe" } }]),
      { async catalog() { return resolvedCatalog([pendingTool]); }, async execute() { dispatches++; throw new Error("must not dispatch"); } }, continueObserver, checkpoints, new BoundedOutputDistiller());
    checkpoints.save = async () => { runtime.cancelAll(); return "checkpoint://pending.json"; };
    expect((await runtime.execute(assignment())).outcome).toBe("lease_lost"); expect(dispatches).toBe(0); expect(control.checkpoints).toBe(0);
  });
  const pendingTool = { name: "read", source: "neutral", version: "1", priority: 1, description: "Observe",
    inputSchema: {}, providedCapabilities: ["evidence.read"], dependencyCapabilities: [], permissionRequirements: {},
    risk: "read_only" as const, timeoutMs: 1000 };
  function suspended() {
    const current = assignment();
    current.work.latestCheckpoint = { id: "pending", workId: current.work.id, leaseId: "old-lease",
      progressSummary: "pending", payloadRef: "checkpoint://pending.json", createdAt: worker.heartbeatAt };
    const checkpoints = new MemoryCheckpoints();
    checkpoints.document = { version: 2, workerId: worker.id, runId: current.runId, workId: current.work.id,
      caseId: current.runContext.caseId, workKey: current.work.idempotencyKey, leaseId: "old-lease",
      turn: 0, transcript: [], steering: [], completedInvocationIds: [], consecutiveFailures: 0, savedAt: worker.heartbeatAt,
      pendingInvocation: { turn: 1, invocation: { id: "exact", tool: "read", input: { value: "original" }, rationale: "Observe" },
        risk: pendingTool.risk, contractFingerprint: executionToolContractFingerprint(pendingTool) } };
    return { current, checkpoints, control: new FakeControl(current) };
  }

  it("recovers the confirmed result before any catalog or model call, even without the provider", async () => {
    const { current, checkpoints, control } = suspended(); const order: string[] = [];
    const runtime = new WorkerHost(worker, control, { async decide(request) {
      order.push("model"); expect(request.transcript.some((entry) => entry.refs.includes("evidence"))).toBe(true);
      return { type: "complete", summary: "Done", outputs: [] };
    } }, { async recover(request) {
      order.push("recover"); expect(request.idempotencyKey).toBe("effect_1:exact");
      expect(request.invocation.input).toEqual({ value: "original" });
      return { status: "recorded", result: { status: "succeeded", summary: "Saved", raw: "saved", refs: ["evidence"], retryable: false } };
    }, async catalog() { order.push("catalog"); return resolvedCatalog([]); }, async execute() { throw new Error("must not dispatch"); } },
    continueObserver, checkpoints, new BoundedOutputDistiller());
    expect((await runtime.execute(current)).outcome).toBe("completed");
    expect(order).toEqual(["recover", "catalog", "model"]);
    expect(checkpoints.document).toMatchObject({ turn: 1, pendingInvocation: null, completedInvocationIds: ["exact"] });
  });

  it("executes only the saved input when durable ownership proves it never started", async () => {
    const { current, checkpoints, control } = suspended(); let executions = 0;
    const runtime = new WorkerHost(worker, control, new SequenceModel([{ type: "complete", summary: "Done", outputs: [] }]), {
      async recover() { return { status: "not_started" }; }, async catalog() { return resolvedCatalog([pendingTool]); },
      async execute(request) { executions++; expect(request.invocation.input).toEqual({ value: "original" });
        return { status: "succeeded", summary: "Done", raw: "", refs: [], retryable: false }; },
    }, continueObserver, checkpoints, new BoundedOutputDistiller());
    expect((await runtime.execute(current)).outcome).toBe("completed"); expect(executions).toBe(1);
  });

  it.each(["missing-recovery", "uncertain", "changed-contract", "exhausted-budget"])("fails closed on %s without asking the model", async (failure) => {
    const { current, checkpoints, control } = suspended(); let modelCalls = 0; let executions = 0;
    if (failure === "exhausted-budget") checkpoints.document!.consecutiveFailures = 3;
    const runtime = new WorkerHost(worker, control, { async decide() { modelCalls++; throw new Error("unexpected model"); } }, {
      recover: failure === "missing-recovery" ? undefined : async () => {
        if (failure === "uncertain") throw new ToolInvocationRecoveryRequiredError("Uncertain effect");
        return { status: "not_started" };
      }, async catalog() { return resolvedCatalog([{ ...pendingTool, version: "2" }]); },
      async execute() { executions++; throw new Error("unexpected execution"); },
    }, continueObserver, checkpoints, new BoundedOutputDistiller());
    expect((await runtime.execute(current)).outcome).toBe("blocked"); expect(modelCalls).toBe(0); expect(executions).toBe(0);
  });

  it("does not dispatch if the pre-action checkpoint cannot be committed", async () => {
    const control = new FakeControl(); let executions = 0;
    control.checkpoint = async () => { throw new Error("storage unavailable"); };
    const runtime = new WorkerHost(worker, control, new SequenceModel([
      { type: "invoke_tool", invocation: { id: "exact", tool: "read", input: {}, rationale: "Observe" } },
    ]), { async catalog() { return resolvedCatalog([pendingTool]); }, async execute() { executions++; throw new Error("unexpected"); } },
    continueObserver, new MemoryCheckpoints(), new BoundedOutputDistiller());
    expect((await runtime.execute(assignment())).outcome).toBe("failed"); expect(executions).toBe(0);
  });
  it.each(["catalog", "execute"])("blocks Work when uncertainty is reported during %s", async (phase) => {
    const control = new FakeControl();
    const runtime = new WorkerHost(worker, control, new SequenceModel([
      { type: "invoke_tool", invocation: { id: "call", tool: "read", input: {}, rationale: "Observe" } },
    ]), {
      async catalog() {
        if (phase === "catalog") throw new ToolInvocationRecoveryRequiredError("Execution outcome must be reconciled");
        return resolvedCatalog([{ name: "read", source: "neutral", version: "1.0.0", priority: 1,
        description: "Observe", inputSchema: {}, providedCapabilities: ["evidence.read"], dependencyCapabilities: [], permissionRequirements: {}, risk: "read_only", timeoutMs: 1000 }]); },
      async execute() { throw new ToolInvocationRecoveryRequiredError("Execution outcome must be reconciled"); },
    }, continueObserver, new MemoryCheckpoints(), new BoundedOutputDistiller(), {}, () => "2026-08-24T08:00:10.000Z");
    expect(await runtime.execute(assignment())).toMatchObject({ outcome: "blocked", reason: "Execution outcome must be reconciled" });
    expect(control.blocked).toBe("Execution outcome must be reconciled");
    expect(control.failed).toBeUndefined();
    expect(control.completed).toBeUndefined();
  });
  it("executes a tool, checkpoints the distilled result, and completes work", async () => {
    const control = new FakeControl();
    const checkpoints = new MemoryCheckpoints();
    const gateway: ExecutionToolGateway = {
      async catalog() { return resolvedCatalog([{ name: "read", source: "test", version: "1.0.0", priority: 100, description: "Read data", inputSchema: {}, providedCapabilities: ["evidence.read"], dependencyCapabilities: [], permissionRequirements: {}, risk: "read_only", timeoutMs: 1_000 }]); },
      async execute() { return { status: "succeeded", summary: "Observation captured", raw: "raw observation", refs: ["evidence_1"], retryable: false }; },
    };
    const lifecycle: WorkerLifecycleEvent[] = [];
    const runtime = new WorkerHost(worker, control, new SequenceModel([
      { type: "invoke_tool", invocation: { id: "call_1", tool: "read", input: {}, rationale: "Collect evidence" } },
      { type: "complete", summary: "Work complete", outputs: [{ id: "output_1", kind: "evidence", summary: "Evidence", refs: ["evidence_1"] }] },
    ]), gateway, continueObserver, checkpoints, new BoundedOutputDistiller(), { onLifecycleEvent: (event) => lifecycle.push(event) }, () => "2026-08-24T08:00:10.000Z");

    const result = await runtime.execute(assignment());
    expect(result.outcome).toBe("completed");
    expect(control.checkpoints).toBe(2);
    expect(control.completed?.outputs[0].refs).toEqual(["evidence_1"]);
    expect(checkpoints.document?.completedInvocationIds).toEqual(["call_1"]);
    expect(checkpoints.document?.transcript.some((entry) => entry.summary.includes("raw-sha256="))).toBe(true);
    const turnId = "worker:worker_1:run:run_1:work:work_1:lease:lease_1:attempt:1:turn:1";
    expect(lifecycle.filter((event) => event.type === "tool_started" || event.type === "tool_completed")
      .map((event) => [event.type, event.turnId])).toEqual([["tool_started", turnId], ["tool_completed", turnId]]);
    expect(lifecycle.filter((event) => event.type === "turn_progress").map((event) => event.phase)).toEqual([
      "actionRequested", "checkpointed", "toolExecuted", "observationApplied", "checkpointed",
    ]);
    expect(lifecycle.find((event) => event.type === "turn_completed")).toMatchObject({ outcome: "continue" });
  });

  it("refreshes independent Run Observer directives into Worker steering before every decision", async () => {
    const current = assignment();
    current.runContext.directives = [{
      id: "directive_1", kind: "steer", targetWorkId: current.work.id,
      instruction: "Reassess the graph delta before another action.", rationale: "No information gain",
      issuedBy: "observer", createdAt: "2026-08-24T08:00:05.000Z",
    }];
    const control = new FakeControl(current);
    let steering: string[] = [];
    const model: WorkerModel = {
      async decide(request) {
        steering = request.steering;
        return { type: "complete", summary: "Corrected", outputs: [{ id: "output_1", kind: "coverage_assessment", summary: "Reviewed", refs: ["scope_1"] }] };
      },
    };
    const runtime = new WorkerHost(
      worker, control, model,
      { async catalog() { return resolvedCatalog([]); }, async execute() { throw new Error("not used"); } },
      continueObserver, new MemoryCheckpoints(), new BoundedOutputDistiller(), {}, () => "2026-08-24T08:00:10.000Z",
    );
    await runtime.execute(current);
    expect(steering).toContain("Reassess the graph delta before another action.");
  });

  it("lets the observer suppress repeated identical actions", async () => {
    let executions = 0;
    const control = new FakeControl();
    const gateway: ExecutionToolGateway = {
      async catalog() { return resolvedCatalog([{ name: "read", source: "test", version: "1.0.0", priority: 100, description: "Read", inputSchema: {}, providedCapabilities: ["evidence.read"], dependencyCapabilities: [], permissionRequirements: {}, risk: "read_only", timeoutMs: 1_000 }]); },
      async execute() { executions += 1; return { status: "succeeded", summary: "done", raw: "done", refs: [], retryable: false }; },
    };
    const duplicate = { type: "invoke_tool" as const, invocation: { id: "call_2", tool: "read", input: { key: "same" }, rationale: "repeat" } };
    const runtime = new WorkerHost(worker, control, new SequenceModel([
      { ...duplicate, invocation: { ...duplicate.invocation, id: "call_1" } }, duplicate,
      { type: "complete", summary: "Stopped repeating", outputs: [{ id: "output_1", kind: "coverage_assessment", summary: "No additional evidence", refs: ["scope_1"] }] },
    ]), gateway, new LoopGuardObserver({ steerAfterRepeats: 2, stopAfterRepeats: 4 }), new MemoryCheckpoints(), new BoundedOutputDistiller());
    const result = await runtime.execute(assignment());
    expect(result.outcome).toBe("completed");
    expect(executions).toBe(1);
    expect(control.checkpoints).toBe(3);
  });

  it("stops locally without writing failure after losing a lease", async () => {
    const control = new FakeControl();
    control.checkpoint = async () => { throw new LeaseLostError("revision changed"); };
    const runtime = new WorkerHost(worker, control, new SequenceModel([
      { type: "invoke_tool", invocation: { id: "call_1", tool: "read", input: {}, rationale: "read" } },
    ]), {
      async catalog() { return resolvedCatalog([{ name: "read", source: "test", version: "1.0.0", priority: 100, description: "Read", inputSchema: {}, providedCapabilities: ["evidence.read"], dependencyCapabilities: [], permissionRequirements: {}, risk: "read_only", timeoutMs: 1_000 }]); },
      async execute() { return { status: "succeeded", summary: "done", raw: "done", refs: [], retryable: false }; },
    }, continueObserver, new MemoryCheckpoints(), new BoundedOutputDistiller());
    const result = await runtime.execute(assignment());
    expect(result.outcome).toBe("lease_lost");
    expect(control.failed).toBeUndefined();
  });

  it("terminates the active Turn when tool execution fails unexpectedly", async () => {
    const lifecycle: WorkerLifecycleEvent[] = [];
    const control = new FakeControl();
    const runtime = new WorkerHost(worker, control, new SequenceModel([
      { type: "invoke_tool", invocation: { id: "call_1", tool: "read", input: {}, rationale: "read" } },
    ]), {
      async catalog() { return resolvedCatalog([{ name: "read", source: "test", version: "1.0.0", priority: 100, description: "Read", inputSchema: {}, providedCapabilities: ["evidence.read"], dependencyCapabilities: [], permissionRequirements: {}, risk: "read_only", timeoutMs: 1_000 }]); },
      async execute() { throw new Error("adapter disconnected"); },
    }, continueObserver, new MemoryCheckpoints(), new BoundedOutputDistiller(), { onLifecycleEvent: (event) => lifecycle.push(event) });

    await expect(runtime.execute(assignment())).resolves.toMatchObject({ outcome: "failed" });
    expect(control.failed).toBe("adapter disconnected");
    expect(lifecycle.at(-1)).toMatchObject({ type: "turn_completed", status: "failed", error: "adapter disconnected" });
  });

  it("rejects model outputs that cite references absent from the evidence context", async () => {
    const control = new FakeControl();
    const runtime = new WorkerHost(worker, control, new SequenceModel([
      { type: "complete", summary: "Unsupported", outputs: [{ id: "output_1", kind: "evidence", summary: "Claim", refs: ["invented_ref"] }] },
      { type: "complete", summary: "Grounded", outputs: [{ id: "output_2", kind: "scope_snapshot", summary: "Authorized scope", refs: ["scope_1"] }] },
    ]), { async catalog() { return resolvedCatalog([]); }, async execute() { throw new Error("not used"); } }, continueObserver, new MemoryCheckpoints(), new BoundedOutputDistiller());
    const result = await runtime.execute(assignment());
    expect(result.outcome).toBe("completed");
    expect(control.checkpoints).toBe(1);
    expect(control.completed?.outputs[0].refs).toEqual(["scope_1"]);
  });

  it("checkpoints and releases execution when a tool requires approval", async () => {
    const control = new FakeControl();
    const checkpoints = new MemoryCheckpoints();
    const runtime = new WorkerHost(worker, control, new SequenceModel([
      { type: "invoke_tool", invocation: { id: "call_1", tool: "privileged", input: { operation: "bounded" }, rationale: "Validate the hypothesis" } },
    ]), {
      async catalog() { return resolvedCatalog([{ name: "privileged", source: "test", version: "1.0.0", priority: 100, description: "Privileged", inputSchema: {}, providedCapabilities: ["host.privileged"], dependencyCapabilities: [], permissionRequirements: {}, risk: "privileged", timeoutMs: 1_000 }]); },
      async execute() { return { status: "approval_required", summary: "Approval required", raw: "", refs: [], retryable: true, approvalRef: "approval_1" }; },
    }, continueObserver, checkpoints, new BoundedOutputDistiller());
    const result = await runtime.execute(assignment());
    expect(result.outcome).toBe("waiting_approval");
    expect(control.approval).toMatchObject({ approvalId: "approval_1", actionKey: "effect_1:call_1" });
    expect(checkpoints.document?.completedInvocationIds).toEqual([]);
  });

  it("blocks a resumed Work when its durable checkpoint cannot be restored", async () => {
    const current = assignment();
    current.work.resumeFromCheckpoint = true;
    current.work.latestCheckpoint = {
      id: "checkpoint_missing", workId: current.work.id, leaseId: "previous_lease",
      progressSummary: "Saved before interruption", payloadRef: "checkpoint://missing.json",
      createdAt: "2026-08-24T08:00:00.000Z",
    };
    const control = new FakeControl(current);
    const runtime = new WorkerHost(
      worker, control, new SequenceModel([]),
      { async catalog() { return resolvedCatalog([]); }, async execute() { throw new Error("not used"); } },
      continueObserver, new MemoryCheckpoints(), new BoundedOutputDistiller(), {},
      () => "2026-08-24T08:00:10.000Z",
    );
    const result = await runtime.execute(current);
    expect(result.outcome).toBe("blocked");
    expect(control.blocked).toMatch(/Checkpoint recovery failed.*missing checkpoint/);
    expect(control.failed).toBeUndefined();
  });
});
