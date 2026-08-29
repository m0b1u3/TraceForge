import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { EffectivePermissionProfile } from "@traceforge/orchestration-core";
import type { ScenarioAuthorizationPort } from "@traceforge/scenario-sdk";
import {
  PolicyProviderCapabilityAuthorizer,
  ProviderCapabilityBroker,
  type ProviderCapabilityInvocation,
} from "@traceforge/worker-runtime";
import { createDb, getSqliteClient } from "./db/client.js";
import {
  ScenarioProviderCapabilityScopeAuthorizer,
  SqliteProviderCapabilityApprovalReader,
  SqliteProviderCapabilityReceiptStore,
} from "./provider-capability-adapters.js";

const permissions: EffectivePermissionProfile = {
  version: 1, platform: "linux", filesystem: { read: [], write: [], deny: [] }, network: "brokered",
  process: { access: "sandboxed", interactive: false, background: false }, secrets: "handles_only", sources: ["fixture"],
};

function invocation(): ProviderCapabilityInvocation {
  return {
    provider: { id: "provider.fixture", version: "1.0.0", generation: 1 }, parentRequestId: "parent-1",
    capability: "fixture.lookup", action: "fixture.inspect", idempotencyKey: "capability-effect-1",
    input: { subject: "first candidate" }, depth: 1,
    attribution: {
      caseId: "case-1", runId: "run-1", workId: "work-1", workerId: "worker-1", scopeRef: "scope-1",
      leaseId: "lease-1", leaseExpiresAt: "2100-01-01T00:00:00.000Z", idempotencyKey: "tool-effect-1",
      effectivePermissions: permissions,
    },
  };
}

function scopePort(denied = false): ScenarioAuthorizationPort {
  return {
    requireAction(scopeRef, caseId, action) {
      if (denied) throw new Error("fixture scope rejected action");
      expect({ scopeRef, caseId, action }).toEqual({ scopeRef: "scope-1", caseId: "case-1", action: "fixture.inspect" });
      return { id: "scope-authorization-1", caseId, scenarioKind: "fixture.scenario", scopePayload: {}, expiresAt: "2100-01-01T00:00:00.000Z" };
    },
    authorizeResource() { throw new Error("not used by neutral capability fixture"); },
  };
}

describe("Provider capability SQLite and authorization adapters", () => {
  it("replays a terminal Receipt after a database restart without re-executing the handler", async () => {
    const directory = mkdtempSync(join(tmpdir(), "traceforge-provider-capability-"));
    const path = join(directory, "runtime.sqlite");
    let sqlite = getSqliteClient(createDb(path));
    let executions = 0;
    const first = new ProviderCapabilityBroker({
      receipts: new SqliteProviderCapabilityReceiptStore(sqlite),
      authorizer: { async authorize() { return { decision: "approved", authorizationRef: "scope-authorization-1" }; } },
      handlers: [{ capability: "fixture.lookup", async execute() { executions += 1; return { output: { state: "available" }, refs: ["evidence:first"] }; } }],
      createId: () => "receipt-1", now: () => "2026-08-28T12:00:00.000Z",
    });
    const initial = await first.invoke(invocation());
    expect(initial).toMatchObject({ status: "succeeded" });
    expect(initial.replayed).toBeUndefined();
    sqlite.close();

    sqlite = getSqliteClient(createDb(path));
    const recovered = new ProviderCapabilityBroker({
      receipts: new SqliteProviderCapabilityReceiptStore(sqlite),
      authorizer: { async authorize() { throw new Error("replay must not re-authorize"); } },
      handlers: [{ capability: "fixture.lookup", async execute() { executions += 1; return { output: {}, refs: [] }; } }],
    });
    expect(await recovered.invoke(invocation())).toMatchObject({ id: "receipt-1", status: "succeeded", replayed: true });
    expect(executions).toBe(1);
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("stores approval-required and completed attempts in order and returns the latest Receipt", async () => {
    const sqlite = getSqliteClient(createDb(":memory:"));
    const receipts = new SqliteProviderCapabilityReceiptStore(sqlite);
    const base = {
      id: "receipt-pending", provider: invocation().provider, parentRequestId: "parent-1",
      capability: "fixture.lookup", action: "fixture.inspect", idempotencyKey: "capability-effect-1",
      inputFingerprint: "fingerprint", attribution: {
        caseId: "case-1", runId: "run-1", workId: "work-1", workerId: "worker-1", scopeRef: "scope-1",
        leaseId: "lease-1", leaseExpiresAt: "2100-01-01T00:00:00.000Z", idempotencyKey: "tool-effect-1",
      },
      status: "approval_required" as const, refs: [], requestBytes: 1, responseBytes: 0, retryable: true,
      startedAt: "2026-08-28T12:00:00.000Z", completedAt: "2026-08-28T12:00:00.001Z",
    };
    await receipts.put(base);
    await receipts.put({
      ...base, id: "receipt-complete", status: "succeeded", retryable: false,
      completedAt: "2026-08-28T12:00:00.002Z", authorizationRef: "scope-authorization-1",
    });

    await expect(receipts.get("provider.fixture", "capability-effect-1")).resolves.toMatchObject({
      id: "receipt-complete", status: "succeeded",
    });
    expect(sqlite.prepare("SELECT status FROM provider_capability_receipts ORDER BY completed_at").all()).toEqual([
      { status: "approval_required" }, { status: "succeeded" },
    ]);
    sqlite.prepare("UPDATE provider_capability_receipts SET receipt_json = '{}' WHERE id = 'receipt-complete'").run();
    await expect(receipts.get("provider.fixture", "capability-effect-1")).rejects.toThrow();
    sqlite.close();
  });

  it("composes Scenario scope and the durable Work approval projection without writing it directly", async () => {
    const sqlite = getSqliteClient(createDb(":memory:"));
    const approvals = new SqliteProviderCapabilityApprovalReader(sqlite);
    const authorizer = new PolicyProviderCapabilityAuthorizer([{
      capability: "fixture.lookup", actions: ["fixture.inspect"], permissionRequirements: { network: "brokered" }, risk: "privileged",
    }], new ScenarioProviderCapabilityScopeAuthorizer(scopePort()), approvals);

    const pending = await authorizer.authorize(invocation());
    expect(pending).toMatchObject({ decision: "pending", authorizationRef: "scope-authorization-1", approvalRef: expect.stringContaining("provider-capability-approval:") });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM scenario_work_approvals").get()).toEqual({ count: 0 });

    sqlite.prepare(`
      INSERT INTO scenario_work_approvals
        (id, run_id, case_id, work_id, action_key, tool_name, risk, rationale, input_ref,
         status, requested_by_worker_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?)
    `).run(
      pending.approvalRef, "run-1", "case-1", "work-1", "tool-effect-1", "provider:fixture.lookup",
      "privileged", "fixture approval", "receipt:pending", "worker-1", "2026-08-28T12:00:00.000Z",
    );
    await expect(authorizer.authorize(invocation())).resolves.toEqual({
      decision: "approved", authorizationRef: "scope-authorization-1",
    });

    const denied = new PolicyProviderCapabilityAuthorizer([{
      capability: "fixture.lookup", actions: ["fixture.inspect"], permissionRequirements: {}, risk: "read_only",
    }], new ScenarioProviderCapabilityScopeAuthorizer(scopePort(true)), approvals);
    await expect(denied.authorize(invocation())).resolves.toEqual({ decision: "rejected", reason: "fixture scope rejected action" });
    sqlite.close();
  });
});
