import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolExecutionResult } from "@traceforge/worker-runtime";
import { createDb, getSqliteClient } from "./db/client.js";
import { SqliteToolInvocationBindingStore, SqliteToolReceiptStore } from "./worker-execution-adapters.js";
import {
  ToolInvocationReconciliationControl,
  ToolInvocationReconciliationError,
  type ToolInvocationReconciliationAssertion,
  type ToolInvocationReconciliationAuthorizer,
  type ToolInvocationReconciliationEvidenceVerifier,
} from "./tool-invocation-reconciliation.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const sqlite of databases.splice(0)) sqlite.close(); });

const preparedAt = "2026-08-30T00:00:00.000Z";
const reconciledAt = "2026-08-30T00:01:00.000Z";
const result: ToolExecutionResult = {
  status: "succeeded", summary: "Trusted terminal result", raw: "", refs: ["evidence:terminal"], retryable: false,
};

async function fixture(options: {
  authorizer?: ToolInvocationReconciliationAuthorizer;
  verifier?: ToolInvocationReconciliationEvidenceVerifier;
} = {}) {
  const sqlite = getSqliteClient(createDb(":memory:"));
  databases.push(sqlite);
  const bindings = new SqliteToolInvocationBindingStore(sqlite, () => preparedAt);
  await bindings.prepare({
    idempotencyKey: "effect:neutral", invocationId: "invocation_1",
    tool: { name: "neutral.observe", source: "managed.neutral", version: "1.0.0", contractFingerprint: "a".repeat(64) },
    inputFingerprint: "b".repeat(64), attribution: { caseId: "case_1", runId: "run_1", workId: "work_1" },
  });
  sqlite.prepare("UPDATE tool_invocation_executions SET status = 'uncertain', lease_id = 'lease_1', reason = 'host interrupted'").run();
  const authorizer = options.authorizer ?? {
    async authorize() { return { decision: "allowed" as const, reason: "incident responder role" }; },
  };
  const verifier = options.verifier ?? verifierFromExpected();
  const control = new ToolInvocationReconciliationControl(sqlite, bindings, authorizer, verifier, () => reconciledAt);
  return { sqlite, bindings, receipts: new SqliteToolReceiptStore(sqlite), control };
}

function verifierFromExpected(
  mutate?: (assertion: ToolInvocationReconciliationAssertion) => void,
): ToolInvocationReconciliationEvidenceVerifier {
  return {
    async verify(input) {
      const assertion: ToolInvocationReconciliationAssertion = {
        schemaVersion: 1,
        identity: structuredClone(input.expectedIdentity),
        executionOwnership: structuredClone(input.expectedExecutionOwnership),
        outcome: input.resolution === "confirmed_result" ? "result_confirmed" : "no_effect_confirmed",
        resultFingerprint: input.result ? hash(input.result) : null,
        cleanup: {
          status: input.resolution === "confirmed_result" ? "terminal" : "not_started",
          evidenceRef: "trusted-node-attestation:1",
        },
        issuedAt: reconciledAt,
        expiresAt: "2026-08-30T00:06:00.000Z",
      };
      mutate?.(assertion);
      return assertion;
    },
  };
}

function command(resolution: "confirmed_result" | "confirmed_no_effect" = "confirmed_result") {
  return {
    idempotencyKey: "effect:neutral", actor: "operator_1", commandId: `reconcile:${resolution}`,
    resolution, reason: "Resolve interrupted execution from trusted evidence", evidence: { attestation: "opaque" },
    ...(resolution === "confirmed_result" ? { result } : {}),
  };
}

describe("Tool Invocation authorized reconciliation", () => {
  it("atomically records a trusted result, closes uncertainty, and replays the same command", async () => {
    const context = await fixture();
    const first = await context.control.reconcile(command());
    expect(first).toMatchObject({ replayed: false, audit: { outcome: "resolved", authorizationDecision: "allowed" } });
    expect(await context.receipts.get("effect:neutral")).toEqual(result);
    expect(context.bindings.get("effect:neutral")?.status).toBe("completed");
    expect(context.bindings.execution("effect:neutral")?.status).toBe("completed");
    expect(await context.bindings.hasOpenBindings("managed.neutral", "1.0.0")).toBe(false);
    await expect(context.control.reconcile(command())).resolves.toMatchObject({ replayed: true });
    await expect(context.control.reconcile({ ...command(), reason: "changed" })).rejects.toBeInstanceOf(ToolInvocationReconciliationError);
  });

  it("releases protection only after trusted proof confirms that no effect occurred", async () => {
    const context = await fixture();
    await expect(context.control.reconcile(command("confirmed_no_effect"))).resolves.toMatchObject({ audit: { outcome: "resolved" } });
    expect(await context.receipts.get("effect:neutral")).toBeUndefined();
    expect(context.bindings.get("effect:neutral")).toMatchObject({ status: "released", releaseReason: expect.stringContaining("confirmed no external effect") });
    expect(context.bindings.execution("effect:neutral")).toMatchObject({ status: "completed", reason: expect.stringContaining("no external effect") });
    expect(await context.bindings.hasOpenBindings("managed.neutral", "1.0.0")).toBe(false);
  });

  it.each(["denied", "throws", "invalid"])("fails authorization closed when the authorizer %s", async (mode) => {
    const context = await fixture({ authorizer: {
      async authorize() {
        if (mode === "throws") throw new Error("authorization backend unavailable");
        if (mode === "invalid") return { decision: "allowed", reason: "" };
        return { decision: "denied", reason: "separation of duties" };
      },
    } as ToolInvocationReconciliationAuthorizer });
    await expect(context.control.reconcile(command())).rejects.toMatchObject({ statusCode: 403 });
    expect(context.control.listAudits()).toMatchObject([{ authorizationDecision: "denied", outcome: "denied" }]);
    expect(context.bindings.execution("effect:neutral")?.status).toBe("uncertain");
  });

  it("audits an unknown invocation without consulting authorization or evidence systems", async () => {
    let authorizationCalls = 0;
    let verificationCalls = 0;
    const context = await fixture({
      authorizer: { async authorize() { authorizationCalls++; return { decision: "allowed", reason: "allowed" }; } },
      verifier: { async verify() { verificationCalls++; throw new Error("must not be called"); } },
    });
    await expect(context.control.reconcile({ ...command(), idempotencyKey: "unknown", commandId: "unknown-command" }))
      .rejects.toMatchObject({ statusCode: 404 });
    expect({ authorizationCalls, verificationCalls }).toEqual({ authorizationCalls: 0, verificationCalls: 0 });
    expect(context.control.listAudits("unknown")).toMatchObject([{
      authorizationDecision: "not_evaluated", outcome: "rejected", failureReason: "Unknown Tool Invocation",
    }]);
  });

  it("does not allow an authorized command to rewrite a non-uncertain invocation", async () => {
    const context = await fixture();
    context.sqlite.prepare("UPDATE tool_invocation_executions SET status = 'completed'").run();
    await expect(context.control.reconcile(command())).rejects.toThrow("not uncertain");
    expect(context.control.listAudits()).toMatchObject([{ authorizationDecision: "allowed", outcome: "rejected" }]);
  });

  it.each(["identity", "ownership", "stale", "future", "cleanup", "outcome"])("rejects untrusted %s evidence without releasing uncertainty", async (field) => {
    const context = await fixture({ verifier: verifierFromExpected((assertion) => {
      if (field === "identity") assertion.identity.attribution.workId = "other";
      if (field === "ownership") assertion.executionOwnership.ownerId = "other";
      if (field === "stale") assertion.expiresAt = reconciledAt;
      if (field === "future") assertion.issuedAt = "2026-08-30T00:02:00.000Z";
      if (field === "cleanup") assertion.cleanup.status = "not_started";
      if (field === "outcome") assertion.resultFingerprint = "0".repeat(64);
    }) });
    await expect(context.control.reconcile(command())).rejects.toMatchObject({ statusCode: 409 });
    expect(context.control.listAudits()).toMatchObject([{
      authorizationDecision: "allowed", outcome: "rejected", failureReason: "Reconciliation evidence could not be trusted",
    }]);
    expect(context.bindings.execution("effect:neutral")?.status).toBe("uncertain");
    expect(await context.receipts.get("effect:neutral")).toBeUndefined();
  });

  it("rejects a no-effect command carrying a result before authorization or verification", async () => {
    const context = await fixture();
    await expect(context.control.reconcile({ ...command("confirmed_no_effect"), result })).rejects.toThrow("must not include a result");
    expect(context.control.listAudits()).toEqual([]);
    expect(context.bindings.execution("effect:neutral")?.status).toBe("uncertain");
  });

  it("rolls the receipt and ownership release back if the immutable resolution audit cannot be committed", async () => {
    const context = await fixture();
    context.sqlite.exec(`CREATE TEMP TRIGGER fail_resolution_audit BEFORE INSERT ON tool_invocation_reconciliation_audits
      WHEN NEW.outcome = 'resolved' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`);
    await expect(context.control.reconcile(command())).rejects.toThrow("audit unavailable");
    expect(await context.receipts.get("effect:neutral")).toBeUndefined();
    expect(context.bindings.get("effect:neutral")?.status).toBe("prepared");
    expect(context.bindings.execution("effect:neutral")?.status).toBe("uncertain");
  });

  it("detects an ownership race after verification and records a rejected command", async () => {
    let sqlite!: Database.Database;
    const verifier: ToolInvocationReconciliationEvidenceVerifier = {
      async verify(input) {
        const assertion = await verifierFromExpected().verify(input);
        sqlite.prepare("UPDATE tool_invocation_executions SET owner_id = 'new-owner'").run();
        return assertion;
      },
    };
    const context = await fixture({ verifier });
    sqlite = context.sqlite;
    await expect(context.control.reconcile(command())).rejects.toThrow("ownership changed");
    expect(context.control.listAudits()).toMatchObject([{ outcome: "rejected" }]);
    expect(context.bindings.execution("effect:neutral")?.status).toBe("uncertain");
  });

  it("keeps reconciliation audit rows immutable", async () => {
    const context = await fixture();
    await context.control.reconcile(command());
    expect(() => context.sqlite.prepare("UPDATE tool_invocation_reconciliation_audits SET actor = 'other'").run()).toThrow("immutable");
    expect(() => context.sqlite.prepare("DELETE FROM tool_invocation_reconciliation_audits").run()).toThrow("immutable");
  });
});

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sort(value))).digest("hex");
}

function sort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, sort(entry)]));
  return value;
}
