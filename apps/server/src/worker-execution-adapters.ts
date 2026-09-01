import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { ToolInvocationRecoveryRequiredError, validateToolProviderResult, toolInvocationInputFingerprint } from "@traceforge/worker-runtime";
import { z } from "zod";
import { reserveToolReceipt } from "./db/execution-storage.js";
import type { ExecutionNode, ProcessAccess } from "@traceforge/execution-node";
import type {
  ExecutionToolAdapter,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolInvocationBinding,
  ToolInvocationBindingInput,
  ToolInvocationBindingStore,
  ToolReceiptStore,
  ToolInvocationReceiptIdentity,
  ToolInvocationRecovery,
  WorkerAssignment,
  WorkerCheckpointDocument,
} from "@traceforge/worker-runtime";

export class SqliteToolReceiptStore implements ToolReceiptStore {
  constructor(private readonly sqlite: Database.Database, private readonly now: () => string = () => new Date().toISOString()) {}

  async get(idempotencyKey: string): Promise<ToolExecutionResult | undefined> {
    const row = readExecutionRow<{ result_json: string }>(this.sqlite, "receipt", idempotencyKey);
    return row ? validateToolProviderResult(JSON.parse(row.result_json)) : undefined;
  }

  async put(idempotencyKey: string, result: ToolExecutionResult): Promise<void> {
    validateToolProviderResult(result);
    this.sqlite.prepare(
      "INSERT INTO worker_tool_receipts (idempotency_key, result_json, created_at) VALUES (?, ?, ?)",
    ).run(idempotencyKey, JSON.stringify(result), this.now());
  }
}

export class SqliteToolInvocationBindingStore implements ToolInvocationBindingStore {
  private readonly ownerId = randomUUID();
  constructor(private readonly sqlite: Database.Database, private readonly now: () => string = () => new Date().toISOString()) {}

  async prepare(input: ToolInvocationBindingInput): Promise<ToolInvocationBinding> {
    return this.sqlite.transaction(() => {
      const existing = this.get(input.idempotencyKey);
      if (existing) {
        if (!sameBinding(existing, input)) throw new Error(`Tool invocation binding conflict for ${input.idempotencyKey}`);
        if (existing.status !== "prepared") throw new Error(`Tool invocation binding ${input.idempotencyKey} is already ${existing.status} without a durable receipt`);
        return existing;
      }
      const fence = this.admission(input.tool.source, input.tool.version);
      if (fence?.status === "closed") {
        throw new Error(`Tool invocation admission is closed for ${input.tool.source}@${input.tool.version}: ${fence.reason ?? "version transition"}`);
      }
      const at = this.now();
      this.sqlite.prepare(`
        INSERT INTO tool_invocation_bindings
          (idempotency_key, invocation_id, tool_name, tool_source, tool_version, contract_fingerprint,
           input_fingerprint, case_id, run_id, work_id, status, release_reason, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', NULL, ?, ?)
      `).run(
        required(input.idempotencyKey, "idempotency key"), required(input.invocationId, "invocation id"),
        required(input.tool.name, "tool name"), required(input.tool.source, "tool source"), required(input.tool.version, "tool version"),
        sha256(input.tool.contractFingerprint, "contract fingerprint"), sha256(input.inputFingerprint, "input fingerprint"),
        required(input.attribution.caseId, "case id"), required(input.attribution.runId, "run id"),
        required(input.attribution.workId, "work id"), at, at,
      );
      this.sqlite.prepare(`INSERT INTO tool_invocation_executions
        (idempotency_key, owner_id, status, updated_at) VALUES (?, ?, 'prepared', ?)`)
        .run(input.idempotencyKey, this.ownerId, at);
      return this.get(input.idempotencyKey)!;
    })();
  }

  async complete(idempotencyKey: string): Promise<void> {
    this.sqlite.transaction(() => {
      const execution = this.execution(idempotencyKey);
      if (execution && execution.status !== "prepared" && !this.hasReceipt(idempotencyKey)) {
        throw new ToolInvocationRecoveryRequiredError("Cannot complete an executing invocation without a durable receipt");
      }
      const at = this.now();
      this.sqlite.prepare(`UPDATE tool_invocation_bindings SET status = 'completed', release_reason = NULL, updated_at = ?
        WHERE idempotency_key = ? AND status != 'completed'`).run(at, idempotencyKey);
      this.sqlite.prepare(`UPDATE tool_invocation_executions SET status = 'completed', reason = NULL, updated_at = ?
        WHERE idempotency_key = ? AND status != 'completed'`).run(at, idempotencyKey);
    })();
  }

  async assertReceiptIdentity(input: ToolInvocationReceiptIdentity): Promise<void> {
    this.assertIdentity(input);
  }

  private assertIdentity(input: ToolInvocationReceiptIdentity): void {
    const binding = this.get(input.idempotencyKey);
    if (!binding || binding.invocationId !== input.invocationId || binding.tool.name !== input.toolName
      || binding.inputFingerprint !== input.inputFingerprint
      || binding.attribution.caseId !== input.attribution.caseId || binding.attribution.runId !== input.attribution.runId
      || binding.attribution.workId !== input.attribution.workId) throw new Error("Tool receipt identity does not match its invocation binding");
  }

  async recoverInvocation(input: ToolInvocationReceiptIdentity): Promise<ToolInvocationRecovery> {
    return this.inspectRecovery(input);
  }

  inspectRecovery(input: ToolInvocationReceiptIdentity): ToolInvocationRecovery {
    const binding = this.get(input.idempotencyKey);
    if (!binding) {
      if (this.execution(input.idempotencyKey) || this.hasReceipt(input.idempotencyKey)
        || this.sqlite.prepare("SELECT 1 FROM execution_storage_entries WHERE kind = 'receipt' AND entry_key = ?").get(input.idempotencyKey)) {
        throw new ToolInvocationRecoveryRequiredError("Invocation history exists without its durable binding");
      }
      return { status: "not_started" };
    }
    this.assertIdentity(input);
    const receipt = readExecutionRow<{ result_json: string }>(this.sqlite, "receipt", input.idempotencyKey);
    if (receipt) return { status: "recorded", result: validateToolProviderResult(JSON.parse(receipt.result_json)) };
    const execution = this.execution(input.idempotencyKey);
    if (binding.status === "prepared" && execution?.status === "prepared") return { status: "not_started" };
    const auditRef = this.noEffectAudit(input.idempotencyKey);
    if (auditRef) return { status: "no_effect", auditRef };
    throw new ToolInvocationRecoveryRequiredError("Pending invocation has no confirmed outcome; reconciliation is required");
  }

  /** Every ledger entry must be represented before the model may choose a new action. */
  validateCheckpoint(assignment: WorkerAssignment, checkpoint: WorkerCheckpointDocument): void {
    const rows = this.sqlite.prepare(`SELECT idempotency_key FROM tool_invocation_bindings
      WHERE run_id = ? AND work_id = ? LIMIT 10001`).all(assignment.runId, assignment.work.id) as Array<{ idempotency_key: string }>;
    if (rows.length > 10000) throw new ToolInvocationRecoveryRequiredError("Work invocation history exceeds continuation limit");
    const completed = new Set(checkpoint.completedInvocationIds);
    const found = new Set<string>();
    for (const row of rows) {
      const binding = this.get(row.idempotency_key)!;
      if (binding.attribution.caseId !== assignment.runContext.caseId
        || binding.idempotencyKey !== `${assignment.work.idempotencyKey}:${binding.invocationId}`) {
        throw new ToolInvocationRecoveryRequiredError("Checkpoint invocation ownership mismatch");
      }
      if (completed.has(binding.invocationId)) {
        if (!this.hasReceipt(binding.idempotencyKey) && !this.noEffectAudit(binding.idempotencyKey)) {
          throw new ToolInvocationRecoveryRequiredError("Checkpoint claims a completed invocation without a confirmed outcome");
        }
        found.add(binding.invocationId);
      } else if (checkpoint.pendingInvocation?.invocation.id !== binding.invocationId) {
        throw new ToolInvocationRecoveryRequiredError("Invocation ledger contains an action absent from the checkpoint");
      } else {
        const pending = checkpoint.pendingInvocation;
        this.assertIdentity({ idempotencyKey: binding.idempotencyKey, invocationId: pending.invocation.id,
          toolName: pending.invocation.tool, inputFingerprint: toolInvocationInputFingerprint(pending.invocation.tool, pending.invocation.input),
          attribution: binding.attribution });
        if (pending.contractFingerprint !== binding.tool.contractFingerprint) throw new ToolInvocationRecoveryRequiredError("Pending invocation contract mismatch");
      }
    }
    if (found.size !== completed.size) throw new ToolInvocationRecoveryRequiredError("Checkpoint completed invocation has no durable binding");
  }

  private noEffectAudit(key: string): string | undefined {
    const row = this.sqlite.prepare(`SELECT a.command_id FROM tool_invocation_reconciliation_audits a
      JOIN tool_invocation_bindings b USING(idempotency_key) JOIN tool_invocation_executions e USING(idempotency_key)
      WHERE a.idempotency_key = ? AND a.outcome = 'resolved' AND a.requested_resolution = 'confirmed_no_effect'
      AND b.status = 'released' AND e.status = 'completed'
      AND NOT EXISTS (SELECT 1 FROM worker_tool_receipts r WHERE r.idempotency_key = a.idempotency_key)
      ORDER BY a.command_id LIMIT 1`).get(key) as { command_id: string } | undefined;
    return row ? `invocation-reconciliation:${row.command_id}` : undefined;
  }

  async beginExecution(idempotencyKey: string, leaseId: string, workerId: string): Promise<void> {
    this.sqlite.transaction(() => {
      const binding = this.get(idempotencyKey);
      if (!binding || binding.status !== "prepared") throw new ToolInvocationRecoveryRequiredError("Invocation is not prepared for execution");
      if (this.admission(binding.tool.source, binding.tool.version)?.status === "closed") {
        throw new ToolInvocationRecoveryRequiredError("Invocation admission closed before execution ownership could be acquired");
      }
      this.assertWorkReadyNow(binding.attribution);
      const lease = this.sqlite.prepare(`SELECT 1 FROM scenario_work_leases l
        JOIN scenario_event_streams r ON r.run_id = l.run_id
        WHERE l.run_id = ? AND l.work_id = ? AND l.lease_id = ? AND l.worker_id = ?
        AND l.lease_expires_at > ? AND r.case_id = ? AND r.status = 'running'`)
        .get(binding.attribution.runId, binding.attribution.workId, leaseId, workerId, this.now(), binding.attribution.caseId);
      if (!lease) throw new ToolInvocationRecoveryRequiredError("Invocation execution requires a current Work lease and running Run");
      reserveToolReceipt(this.sqlite, idempotencyKey);
      const result = this.sqlite.prepare(`UPDATE tool_invocation_executions SET status = 'executing', owner_id = ?, lease_id = ?, updated_at = ?
        WHERE idempotency_key = ? AND status = 'prepared'`).run(this.ownerId, leaseId, this.now(), idempotencyKey);
      if (result.changes !== 1) throw new ToolInvocationRecoveryRequiredError("Invocation execution ownership could not be acquired");
    })();
  }

  async assertWorkReady(attribution: ToolInvocationBindingInput["attribution"]): Promise<void> {
    this.assertWorkReadyNow(attribution);
  }

  private assertWorkReadyNow(attribution: ToolInvocationBindingInput["attribution"]): void {
    const unresolved = this.sqlite.prepare(`SELECT b.idempotency_key FROM tool_invocation_bindings b
      LEFT JOIN tool_invocation_executions e ON e.idempotency_key = b.idempotency_key
      WHERE b.case_id = ? AND b.run_id = ? AND b.work_id = ?
      AND (e.status IN ('executing', 'uncertain') OR (e.idempotency_key IS NULL AND b.status != 'completed'))`)
      .all(attribution.caseId, attribution.runId, attribution.workId) as Array<{ idempotency_key: string }>;
    if (unresolved.some((entry) => !this.hasReceipt(entry.idempotency_key))) {
      throw new ToolInvocationRecoveryRequiredError("Work has an executing or uncertain invocation; reconcile it before executing another action");
    }
  }

  async markUncertain(idempotencyKey: string, reason: string): Promise<void> {
    this.sqlite.prepare(`UPDATE tool_invocation_executions SET status = 'uncertain', reason = ?, updated_at = ?
      WHERE idempotency_key = ? AND status = 'executing' AND owner_id = ?`)
      .run(reason.slice(0, 1024), this.now(), idempotencyKey, this.ownerId);
  }

  execution(idempotencyKey: string) {
    return this.sqlite.prepare("SELECT * FROM tool_invocation_executions WHERE idempotency_key = ?").get(idempotencyKey) as
      { idempotency_key: string; owner_id: string; lease_id: string | null; status: "prepared" | "executing" | "uncertain" | "completed"; reason: string | null; updated_at: string } | undefined;
  }

  /** Single-host startup only, before admitting workers; never guesses whether an external effect happened. */
  recoverInterrupted(): { completed: number; uncertain: number } {
    return this.sqlite.transaction(() => {
      const at = this.now();
      const receipts = this.sqlite.prepare(`SELECT r.idempotency_key FROM worker_tool_receipts r
        JOIN tool_invocation_bindings b ON b.idempotency_key = r.idempotency_key
        LEFT JOIN tool_invocation_executions e ON e.idempotency_key = b.idempotency_key
        WHERE b.status != 'completed' OR e.status != 'completed'`).all() as Array<{ idempotency_key: string }>;
      for (const receipt of receipts) this.hasReceipt(receipt.idempotency_key);
      const completed = this.sqlite.prepare(`UPDATE tool_invocation_executions SET status = 'completed', reason = NULL, updated_at = ?
        WHERE status != 'completed' AND EXISTS (SELECT 1 FROM worker_tool_receipts r WHERE r.idempotency_key = tool_invocation_executions.idempotency_key)`)
        .run(at).changes;
      this.sqlite.prepare(`UPDATE tool_invocation_bindings SET status = 'completed', release_reason = NULL, updated_at = ?
        WHERE status != 'completed' AND EXISTS (SELECT 1 FROM worker_tool_receipts r WHERE r.idempotency_key = tool_invocation_bindings.idempotency_key)`)
        .run(at);
      // Pre-journal bindings cannot prove that execution never began. Do not auto-retry them.
      const legacy = this.sqlite.prepare(`INSERT INTO tool_invocation_executions (idempotency_key, owner_id, status, reason, updated_at)
        SELECT b.idempotency_key, ?, 'uncertain', 'Legacy invocation has no execution ownership record', ?
        FROM tool_invocation_bindings b WHERE b.status != 'completed'
        AND NOT EXISTS (SELECT 1 FROM tool_invocation_executions e WHERE e.idempotency_key = b.idempotency_key)`).run(this.ownerId, at).changes;
      const uncertain = this.sqlite.prepare(`UPDATE tool_invocation_executions SET status = 'uncertain',
        reason = 'Host restarted after execution ownership was acquired; outcome and process cleanup are unconfirmed', updated_at = ?
        WHERE status = 'executing' AND owner_id != ?`).run(at, this.ownerId).changes;
      return { completed, uncertain: uncertain + legacy };
    })();
  }

  private hasReceipt(idempotencyKey: string): boolean {
    const row = readExecutionRow<{ result_json: string }>(this.sqlite, "receipt", idempotencyKey);
    if (row) validateToolProviderResult(JSON.parse(row.result_json));
    return Boolean(row);
  }

  async release(idempotencyKey: string, reason: string): Promise<void> {
    const result = this.sqlite.prepare(`
      UPDATE tool_invocation_bindings SET status = 'released', release_reason = ?, updated_at = ?
      WHERE idempotency_key = ? AND status = 'prepared'
    `).run(required(reason, "release reason"), this.now(), idempotencyKey);
    if (result.changes === 0 && this.get(idempotencyKey)?.status === "prepared") {
      throw new Error(`Tool invocation binding ${idempotencyKey} could not be released`);
    }
  }

  async hasOpenBindings(source: string, version: string): Promise<boolean> {
    return Boolean(this.sqlite.prepare(`
      SELECT 1 FROM tool_invocation_bindings b
      LEFT JOIN tool_invocation_executions e ON e.idempotency_key = b.idempotency_key
      WHERE b.tool_source = ? AND b.tool_version = ? AND (b.status = 'prepared' OR e.status IN ('executing', 'uncertain')) LIMIT 1
    `).get(source, version));
  }

  async closeAdmission(source: string, version: string, reason: string): Promise<void> {
    this.setAdmission(source, version, "closed", required(reason, "admission reason"));
  }

  async openAdmission(source: string, version: string): Promise<void> {
    this.setAdmission(source, version, "open", null);
  }

  admission(source: string, version: string): AdmissionFenceRow | undefined {
    return this.sqlite.prepare(`
      SELECT tool_source, tool_version, status, reason, revision, updated_at
      FROM tool_invocation_admission_fences WHERE tool_source = ? AND tool_version = ?
    `).get(source, version) as AdmissionFenceRow | undefined;
  }

  get(idempotencyKey: string): (ToolInvocationBinding & { releaseReason: string | null }) | undefined {
    const row = this.sqlite.prepare("SELECT * FROM tool_invocation_bindings WHERE idempotency_key = ?").get(idempotencyKey) as BindingRow | undefined;
    if (!row) return undefined;
    if (!(["prepared", "completed", "released"] as const).includes(row.status)) throw new Error(`Tool invocation binding ${idempotencyKey} has invalid status`);
    for (const [label, value] of Object.entries(row)) {
      if (label !== "release_reason" && typeof value === "string" && !value.length) throw new Error(`Tool invocation binding ${idempotencyKey} has empty ${label}`);
    }
    sha256(row.contract_fingerprint, "stored contract fingerprint");
    sha256(row.input_fingerprint, "stored input fingerprint");
    return {
      schemaVersion: 1,
      idempotencyKey: row.idempotency_key,
      invocationId: row.invocation_id,
      tool: { name: row.tool_name, source: row.tool_source, version: row.tool_version, contractFingerprint: row.contract_fingerprint },
      inputFingerprint: row.input_fingerprint,
      attribution: { caseId: row.case_id, runId: row.run_id, workId: row.work_id },
      status: row.status,
      releaseReason: row.release_reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private setAdmission(source: string, version: string, status: "open" | "closed", reason: string | null): void {
    const at = this.now();
    this.sqlite.prepare(`
      INSERT INTO tool_invocation_admission_fences (tool_source, tool_version, status, reason, revision, updated_at)
      VALUES (?, ?, ?, ?, 1, ?)
      ON CONFLICT(tool_source, tool_version) DO UPDATE SET
        status = excluded.status,
        reason = excluded.reason,
        revision = tool_invocation_admission_fences.revision + 1,
        updated_at = excluded.updated_at
    `).run(required(source, "tool source"), required(version, "tool version"), status, reason, at);
  }
}

interface AdmissionFenceRow {
  tool_source: string;
  tool_version: string;
  status: "open" | "closed";
  reason: string | null;
  revision: number;
  updated_at: string;
}

interface BindingRow {
  idempotency_key: string;
  invocation_id: string;
  tool_name: string;
  tool_source: string;
  tool_version: string;
  contract_fingerprint: string;
  input_fingerprint: string;
  case_id: string;
  run_id: string;
  work_id: string;
  status: ToolInvocationBinding["status"];
  release_reason: string | null;
  created_at: string;
  updated_at: string;
}

function sameBinding(existing: ToolInvocationBinding, input: ToolInvocationBindingInput): boolean {
  return existing.idempotencyKey === input.idempotencyKey
    && existing.invocationId === input.invocationId
    && existing.tool.name === input.tool.name
    && existing.tool.source === input.tool.source
    && existing.tool.version === input.tool.version
    && existing.tool.contractFingerprint === input.tool.contractFingerprint
    && existing.inputFingerprint === input.inputFingerprint
    && existing.attribution.caseId === input.attribution.caseId
    && existing.attribution.runId === input.attribution.runId
    && existing.attribution.workId === input.attribution.workId;
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Tool invocation binding ${label} is required`);
  return normalized;
}

function sha256(value: string, label: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`Tool invocation binding ${label} must be a SHA-256 fingerprint`);
  return value;
}

const processInput = z.object({
  executable: z.string().min(1),
  arguments: z.array(z.string()).default([]),
  workingDirectory: z.string().min(1),
  environment: z.record(z.string()).default({}),
  stdin: z.string().optional(),
  timeoutMs: z.number().int().min(1).max(300_000).default(60_000),
  outputLimitBytes: z.number().int().min(1).max(4 * 1024 * 1024).default(64 * 1024),
  resources: z.object({
    cpuTimeMs: z.number().int().min(1).max(300_000).default(60_000),
    memoryBytes: z.number().int().min(16 * 1024 * 1024).max(2 * 1024 * 1024 * 1024).default(512 * 1024 * 1024),
    maximumProcesses: z.number().int().min(1).max(64).default(8),
    writeBytes: z.number().int().min(1).max(1024 * 1024 * 1024).default(256 * 1024 * 1024),
  }).default({}),
});

export class ExecutionNodeProcessTool implements ExecutionToolAdapter {
  readonly name = "process_execute";
  readonly source = "traceforge.builtin";
  readonly version = "1.0.0";
  readonly priority = 100;
  readonly description = "Execute an explicit program and argument vector through the attributed Execution Node sandbox.";
  readonly inputSchema = {
    type: "object",
    properties: {
      executable: { type: "string", description: "Absolute executable path covered by the effective filesystem profile" },
      arguments: { type: "array", items: { type: "string" } },
      workingDirectory: { type: "string", description: "Absolute working directory covered by the effective filesystem profile" },
      environment: { type: "object", additionalProperties: { type: "string" } },
      stdin: { type: "string" },
      timeoutMs: { type: "integer", minimum: 1, maximum: 300_000 },
      outputLimitBytes: { type: "integer", minimum: 1, maximum: 4 * 1024 * 1024 },
      resources: {
        type: "object",
        description: "Mandatory process-tree CPU, memory, process-count, and write-volume limits.",
        properties: {
          cpuTimeMs: { type: "integer", minimum: 1, maximum: 300_000, default: 60_000 },
          memoryBytes: { type: "integer", minimum: 16 * 1024 * 1024, maximum: 2 * 1024 * 1024 * 1024, default: 512 * 1024 * 1024 },
          maximumProcesses: { type: "integer", minimum: 1, maximum: 64, default: 8 },
          writeBytes: { type: "integer", minimum: 1, maximum: 1024 * 1024 * 1024, default: 256 * 1024 * 1024 },
        },
        additionalProperties: false,
      },
    },
    required: ["executable", "workingDirectory"],
    additionalProperties: false,
  };
  readonly providedCapabilities = ["process.execute"];
  readonly dependencyCapabilities: string[] = [];
  readonly permissionRequirements = { process: "sandboxed" as const };
  readonly risk = "privileged" as const;
  readonly timeoutMs = 310_000;

  constructor(private readonly node: ExecutionNode,private readonly capacity?:import("./process-execution-capacity.js").ProcessExecutionCapacity,
    private readonly accounting?: Pick<import("./process-execution-capacity.js").ProcessCapacityInput,"source"|"version"|"operation"|"kind"|"parentInvocationKey">,
    private readonly authorize?:()=>void) {}

  async execute(input: unknown, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    context.signal?.throwIfAborted();
    if(this.capacity){
      processInput.parse(input);
      const admission=await this.capacity.acquire({source:this.source,version:this.version,operation:this.name,kind:"work",parentInvocationKey:context.idempotencyKey,...this.accounting,
        attribution:{caseId:context.caseId,runId:context.runId,workId:context.workId,workerId:context.workerId,scopeRef:context.scopeRef,
          leaseId:context.leaseId,leaseExpiresAt:context.leaseExpiresAt,idempotencyKey:context.idempotencyKey,actionId:`action:${context.idempotencyKey}`}},context.signal,this.authorize);
      let terminal=false;const node=new Proxy(this.node,{get(target,key){
        if(key==="startProcess")return async(request:Parameters<ExecutionNode["startProcess"]>[0])=>{admission.beforeStart(request.requestId);return target.startProcess(request);};
        if(key==="waitProcessEvents")return async(...args:Parameters<ExecutionNode["waitProcessEvents"]>)=>{const result=await target.waitProcessEvents(...args);
          if(["exited","failed"].includes(result.process.state))terminal=true;return result;};
        const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;
      }});
      try{return await new ExecutionNodeProcessTool(node).execute(input,context);}finally{admission.finish(terminal);}
    }
    let access: ProcessAccess | undefined;
    let stopping: Promise<void> | undefined;
    const stop = () => {
      if (!access || stopping) return;
      // Dispatch cleanup once. A returned descriptor is NOT proof of tree cleanup.
      stopping = this.stopProcess(access);
    };
    let onAbort: () => void = () => undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => { stop(); reject(context.signal?.reason ?? new Error("Process invocation cancelled")); };
      context.signal?.addEventListener("abort", onAbort, { once: true });
    });
    const execution = this.executeProcess(input, context, (started) => {
      access = started;
      // startProcess may resolve after the caller already timed out.
      if (context.signal?.aborted) stop();
      context.signal?.throwIfAborted();
    });
    try {
      return await Promise.race([execution, cancelled]);
    } catch (error) {
      stop();
      throw error;
    } finally {
      context.signal?.removeEventListener("abort", onAbort);
    }
  }

  private async stopProcess(access: ProcessAccess): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.node.terminateProcess({ ...access, force: true }),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, 5_000); }),
      ]);
    } catch {
      // Gateway retains uncertain ownership; cleanup errors cannot fabricate a receipt.
    } finally { clearTimeout(timer); }
  }

  private async executeProcess(
    input: unknown, context: ToolExecutionContext, onStarted: (access: ProcessAccess) => void,
  ): Promise<ToolExecutionResult> {
    const parsed = processInput.parse(input);
    const leaseRemainingMs = Date.parse(context.leaseExpiresAt) - Date.now();
    if (leaseRemainingMs <= 0) throw new Error(`Execution lease ${context.leaseId} has expired`);
    const timeoutMs = Math.min(parsed.timeoutMs, leaseRemainingMs);
    const started = await this.node.startProcess({
      requestId: `process:${context.idempotencyKey}`,
      attribution: {
        caseId: context.caseId,
        runId: context.runId,
        workId: context.workId,
        workerId: context.workerId,
        scopeRef: context.scopeRef,
        leaseId: context.leaseId,
        leaseExpiresAt: context.leaseExpiresAt,
        actionId: `action:${context.idempotencyKey}`,
        idempotencyKey: context.idempotencyKey,
      },
      executable: parsed.executable,
      arguments: parsed.arguments,
      workingDirectory: parsed.workingDirectory,
      environment: parsed.environment,
      stdin: parsed.stdin === undefined ? "closed" : "pipe",
      timeoutMs,
      outputLimitBytes: parsed.outputLimitBytes,
      resources: parsed.resources,
      permissions: context.effectivePermissions,
    });
    onStarted({ processId: started.process.id, adoptionToken: started.adoptionToken });
    if (parsed.stdin !== undefined) {
      await this.node.writeProcessInput({
        processId: started.process.id,
        adoptionToken: started.adoptionToken,
        dataBase64: Buffer.from(parsed.stdin).toString("base64"),
        closeAfterWrite: true,
      });
    }
    const output: Buffer[] = [];
    let outputBytes = 0;
    let cursor = 0;
    let descriptor = started.process;
    // Drain even an already-terminal start response; terminal events may span several pages.
    do {
      context.signal?.throwIfAborted();
      const batch = await this.node.waitProcessEvents({
        processId: descriptor.id,
        adoptionToken: started.adoptionToken,
        afterSequence: cursor,
        maximumEvents: 256,
      }, 1_000);
      context.signal?.throwIfAborted();
      descriptor = batch.process;
      let eventCursor = cursor;
      if (descriptor.id !== started.process.id || batch.events.length > 256) {
        throw new Error("Invalid execution event page; outcome requires reconciliation");
      }
      for (const event of batch.events) {
        if (event.processId !== descriptor.id || event.sequence !== eventCursor + 1) {
          throw new Error("Execution event sequence is incomplete; outcome requires reconciliation");
        }
        eventCursor = event.sequence;
      }
      if (batch.lostEvents) throw new Error("Execution event history is incomplete; outcome requires reconciliation");
      if (batch.nextSequence !== eventCursor || batch.nextSequence > descriptor.lastEventSequence
        || batch.nextSequence < cursor || (batch.nextSequence === cursor && descriptor.lastEventSequence > cursor)) {
        throw new Error("Execution event cursor did not advance; outcome requires reconciliation");
      }
      cursor = batch.nextSequence;
      for (const event of batch.events) {
        if (event.type !== "process.output") continue;
        if (event.dataBase64.length > 4 * Math.ceil((parsed.outputLimitBytes - outputBytes) / 3)) {
          throw new Error("Execution output exceeded its limit; outcome requires reconciliation");
        }
        const data = Buffer.from(event.dataBase64, "base64");
        if (data.toString("base64") !== event.dataBase64 || data.length !== event.bytes
          || outputBytes + data.length > parsed.outputLimitBytes) {
          throw new Error("Invalid execution output; outcome requires reconciliation");
        }
        outputBytes += data.length;
        output.push(data);
      }
    } while ((descriptor.state !== "exited" && descriptor.state !== "failed") || cursor < descriptor.lastEventSequence);
    if (descriptor.state === "failed" || descriptor.exitCode === null) {
      throw new Error("Execution transport failed without a confirmed result; outcome requires reconciliation");
    }
    const raw = Buffer.concat(output).toString("utf8");
    const succeeded = descriptor.state === "exited" && descriptor.exitCode === 0;
    return {
      status: succeeded ? "succeeded" : "failed",
      summary: succeeded
        ? `Process completed with exit code 0`
        : `Process exited with code ${descriptor.exitCode}`,
      raw,
      refs: [`execution-process:${descriptor.id}`],
      retryable: false,
      metadata: {
        processId: descriptor.id,
        exitCode: descriptor.exitCode,
        exitSignal: descriptor.exitSignal,
        capturedOutputBytes: descriptor.capturedOutputBytes,
        omittedOutputBytes: descriptor.omittedOutputBytes,
        enforcement: descriptor.enforcement,
        resourceLimitExceeded: descriptor.resourceLimitExceeded,
      },
    };
  }

}
import { readExecutionRow } from "./db/execution-archive.js";
