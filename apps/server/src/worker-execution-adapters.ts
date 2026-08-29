import type Database from "better-sqlite3";
import { z } from "zod";
import type { ExecutionNode, ProcessEvent } from "@traceforge/execution-node";
import type {
  ExecutionToolAdapter,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolInvocationBinding,
  ToolInvocationBindingInput,
  ToolInvocationBindingStore,
  ToolReceiptStore,
} from "@traceforge/worker-runtime";

export class SqliteToolReceiptStore implements ToolReceiptStore {
  constructor(private readonly sqlite: Database.Database, private readonly now: () => string = () => new Date().toISOString()) {}

  async get(idempotencyKey: string): Promise<ToolExecutionResult | undefined> {
    const row = this.sqlite.prepare("SELECT result_json FROM worker_tool_receipts WHERE idempotency_key = ?")
      .get(idempotencyKey) as { result_json: string } | undefined;
    return row ? JSON.parse(row.result_json) as ToolExecutionResult : undefined;
  }

  async put(idempotencyKey: string, result: ToolExecutionResult): Promise<void> {
    this.sqlite.prepare(
      "INSERT INTO worker_tool_receipts (idempotency_key, result_json, created_at) VALUES (?, ?, ?)",
    ).run(idempotencyKey, JSON.stringify(result), this.now());
  }
}

export class SqliteToolInvocationBindingStore implements ToolInvocationBindingStore {
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
      return this.get(input.idempotencyKey)!;
    })();
  }

  async complete(idempotencyKey: string): Promise<void> {
    this.sqlite.prepare(`
      UPDATE tool_invocation_bindings SET status = 'completed', release_reason = NULL, updated_at = ?
      WHERE idempotency_key = ? AND status = 'prepared'
    `).run(this.now(), idempotencyKey);
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
      SELECT 1 FROM tool_invocation_bindings
      WHERE tool_source = ? AND tool_version = ? AND status = 'prepared' LIMIT 1
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

  constructor(private readonly node: ExecutionNode) {}

  async execute(input: unknown, context: ToolExecutionContext): Promise<ToolExecutionResult> {
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
    if (parsed.stdin !== undefined) {
      await this.node.writeProcessInput({
        processId: started.process.id,
        adoptionToken: started.adoptionToken,
        dataBase64: Buffer.from(parsed.stdin).toString("base64"),
        closeAfterWrite: true,
      });
    }
    const output: Buffer[] = [];
    let cursor = 0;
    let descriptor = started.process;
    while (descriptor.state !== "exited" && descriptor.state !== "failed") {
      const batch = await this.node.waitProcessEvents({
        processId: descriptor.id,
        adoptionToken: started.adoptionToken,
        afterSequence: cursor,
        maximumEvents: 256,
      }, 1_000);
      descriptor = batch.process;
      cursor = batch.nextSequence;
      for (const event of batch.events) this.collectOutput(event, output);
    }
    const raw = Buffer.concat(output).toString("utf8");
    const succeeded = descriptor.state === "exited" && descriptor.exitCode === 0;
    return {
      status: succeeded ? "succeeded" : "failed",
      summary: succeeded
        ? `Process completed with exit code 0`
        : descriptor.state === "failed" ? "Execution Node reported a process failure" : `Process exited with code ${descriptor.exitCode}`,
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

  private collectOutput(event: ProcessEvent, output: Buffer[]): void {
    if (event.type === "process.output") output.push(Buffer.from(event.dataBase64, "base64"));
  }
}
