import type Database from "better-sqlite3";
import { z } from "zod";
import type { ExecutionNode, ProcessEvent } from "@traceforge/execution-node";
import type {
  ExecutionToolAdapter,
  ToolExecutionContext,
  ToolExecutionResult,
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
  readonly requiredCapabilities = ["process.execute"];
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
