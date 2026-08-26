import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { ExecutionNode, ProcessDescriptor, StartProcessRequest } from "@traceforge/execution-node";
import { createDb, getSqliteClient } from "./db/client.js";
import { ExecutionNodeProcessTool, SqliteToolReceiptStore } from "./worker-execution-adapters.js";

const databases: Database.Database[] = [];

afterEach(() => {
  while (databases.length) databases.pop()!.close();
});

describe("worker execution adapters", () => {
  it("persists tool receipts across store instances", async () => {
    const sqlite = getSqliteClient(createDb(":memory:"));
    databases.push(sqlite);
    const result = { status: "succeeded" as const, summary: "done", raw: "raw", refs: ["ref_1"], retryable: false };
    await new SqliteToolReceiptStore(sqlite).put("effect:call_1", result);
    await expect(new SqliteToolReceiptStore(sqlite).get("effect:call_1")).resolves.toEqual(result);
  });

  it("executes an attributed process exclusively through the Execution Node contract", async () => {
    const requests: StartProcessRequest[] = [];
    const writes: unknown[] = [];
    const descriptor: ProcessDescriptor = {
      id: "process_1", nodeId: "node_1", pid: 4242, state: "running",
      attribution: {
        caseId: "case_1", runId: "run_1", workId: "work_1", workerId: "worker_1", scopeRef: "scope_1",
        leaseId: "lease_1", leaseExpiresAt: "2099-01-01T00:00:00.000Z", actionId: "action_1", idempotencyKey: "effect_1",
      },
      executable: process.execPath, arguments: ["--version"], workingDirectory: process.cwd(), terminal: null,
      enforcement: {
        sandboxBackend: "test", sandboxed: true, filesystemPolicyApplied: true,
        permissionProfileFingerprint: "proof", resourceLimitsApplied: true, resourceLimitsFingerprint: "resource-proof", network: "deny",
      },
      startedAt: "2026-08-26T00:00:00.000Z", updatedAt: "2026-08-26T00:00:00.000Z", exitedAt: null,
      exitCode: null, exitSignal: null, resourceLimitExceeded: null, capturedOutputBytes: 0, omittedOutputBytes: 0, lastEventSequence: 0,
    };
    const node = {
      async startProcess(request: StartProcessRequest) { requests.push(request); return { process: descriptor, adoptionToken: "token", replayed: false }; },
      async writeProcessInput(request: unknown) { writes.push(request); return descriptor; },
      async waitProcessEvents() {
        const exited = { ...descriptor, state: "exited" as const, exitCode: 0, capturedOutputBytes: 2, lastEventSequence: 2 };
        return {
          process: exited,
          events: [
            { type: "process.output" as const, sequence: 1, processId: descriptor.id, at: descriptor.updatedAt, stream: "stdout" as const, dataBase64: Buffer.from("ok").toString("base64"), bytes: 2 },
            { type: "process.exited" as const, sequence: 2, processId: descriptor.id, at: descriptor.updatedAt, exitCode: 0, signal: null },
          ],
          nextSequence: 2,
          lostEvents: false,
        };
      },
    } as unknown as ExecutionNode;
    const result = await new ExecutionNodeProcessTool(node).execute({
      executable: process.execPath,
      arguments: ["--version"],
      workingDirectory: process.cwd(),
      stdin: "input",
    }, {
      workerId: "worker_1", runId: "run_1", workId: "work_1", caseId: "case_1", scopeRef: "scope_1",
      leaseId: "lease_1", leaseExpiresAt: "2099-01-01T00:00:00.000Z", idempotencyKey: "effect_1",
      effectivePermissions: {
        version: 1,
        platform: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux",
        filesystem: { read: [{ path: process.cwd(), scope: "tree" }], write: [], deny: [] },
        network: "deny", process: { access: "sandboxed", interactive: false, background: false }, secrets: "deny", sources: ["test"],
      },
    });
    expect(requests[0]!.attribution).toMatchObject({ caseId: "case_1", runId: "run_1", workId: "work_1", leaseId: "lease_1" });
    expect(writes).toHaveLength(1);
    expect(result).toMatchObject({ status: "succeeded", raw: "ok", refs: ["execution-process:process_1"] });
  });
});
