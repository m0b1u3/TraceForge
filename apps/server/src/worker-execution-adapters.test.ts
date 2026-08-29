import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { ExecutionNode, ProcessDescriptor, StartProcessRequest } from "@traceforge/execution-node";
import { createDb, getSqliteClient } from "./db/client.js";
import { SqliteScenarioEventStore } from "./scenario-event-store.js";
import { ExecutionNodeProcessTool, SqliteToolInvocationBindingStore, SqliteToolReceiptStore } from "./worker-execution-adapters.js";

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

  it("persists immutable invocation bindings and tracks their terminal lifecycle", async () => {
    const sqlite = getSqliteClient(createDb(":memory:"));
    databases.push(sqlite);
    let current = "2026-08-29T00:00:00.000Z";
    const store = new SqliteToolInvocationBindingStore(sqlite, () => current);
    const binding = {
      idempotencyKey: "effect:binding-1",
      invocationId: "invocation-1",
      tool: { name: "neutral.inspect", source: "managed.neutral", version: "1.0.0", contractFingerprint: "a".repeat(64) },
      inputFingerprint: "b".repeat(64),
      attribution: { caseId: "case-1", runId: "run-1", workId: "work-1" },
    };
    await expect(store.prepare(binding)).resolves.toMatchObject({ status: "prepared", ...binding });
    await expect(store.hasOpenBindings("managed.neutral", "1.0.0")).resolves.toBe(true);
    await expect(store.prepare({ ...binding, inputFingerprint: "c".repeat(64) })).rejects.toThrow(/binding conflict/);
    current = "2026-08-29T00:00:01.000Z";
    await store.complete(binding.idempotencyKey);
    expect(store.get(binding.idempotencyKey)).toMatchObject({ status: "completed", updatedAt: current });
    await expect(store.hasOpenBindings("managed.neutral", "1.0.0")).resolves.toBe(false);

    const releasable = { ...binding, idempotencyKey: "effect:binding-2", invocationId: "invocation-2" };
    await store.prepare(releasable);
    await store.release(releasable.idempotencyKey, "Work was cancelled");
    expect(store.get(releasable.idempotencyKey)).toMatchObject({ status: "released", releaseReason: "Work was cancelled" });

    const pending = { ...binding, idempotencyKey: "effect:binding-pending", invocationId: "invocation-pending" };
    await store.prepare(pending);
    await store.closeAdmission("managed.neutral", "1.0.0", "version transition");
    expect(store.admission("managed.neutral", "1.0.0")).toMatchObject({ status: "closed", reason: "version transition", revision: 1 });
    await expect(store.prepare(pending)).resolves.toMatchObject({ status: "prepared" });
    await expect(store.prepare(releasable)).rejects.toThrow(/already released/);
    await expect(store.prepare({ ...binding, idempotencyKey: "effect:binding-3", invocationId: "invocation-3" }))
      .rejects.toThrow(/admission is closed/);
    await store.openAdmission("managed.neutral", "1.0.0");
    expect(store.admission("managed.neutral", "1.0.0")).toMatchObject({ status: "open", reason: null, revision: 2 });
    await expect(store.prepare({ ...binding, idempotencyKey: "effect:binding-3", invocationId: "invocation-3" }))
      .resolves.toMatchObject({ status: "prepared" });
  });

  it("atomically releases prepared invocation bindings when their Work reaches a terminal lifecycle", async () => {
    const sqlite = getSqliteClient(createDb(":memory:"));
    databases.push(sqlite);
    const bindings = new SqliteToolInvocationBindingStore(sqlite, () => "2026-08-29T00:00:00.000Z");
    await bindings.prepare({
      idempotencyKey: "effect:terminal-work", invocationId: "invocation-terminal-work",
      tool: { name: "neutral.inspect", source: "managed.neutral", version: "1.0.0", contractFingerprint: "a".repeat(64) },
      inputFingerprint: "b".repeat(64),
      attribution: { caseId: "case-1", runId: "run-1", workId: "work-1" },
    });
    sqlite.prepare(`
      INSERT INTO scenario_event_streams
        (run_id, case_id, definition_kind, definition_version, status, active_phase_id, revision, created_at, updated_at)
      VALUES ('run-1', 'case-1', 'neutral', 1, 'running', 'phase-1', 0, ?, ?)
    `).run("2026-08-29T00:00:00.000Z", "2026-08-29T00:00:00.000Z");

    new SqliteScenarioEventStore(sqlite).append({
      runId: "run-1", commandId: "cancel-work-1", fingerprint: "command-fingerprint", expectedRevision: 0,
      events: [{ type: "work_cancelled", workId: "work-1", reason: "no longer required", at: "2026-08-29T00:00:01.000Z" }],
    });

    expect(bindings.get("effect:terminal-work")).toMatchObject({
      status: "released",
      releaseReason: "Work was cancelled before the Tool Invocation produced a terminal receipt",
      updatedAt: "2026-08-29T00:00:01.000Z",
    });
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
