import { describe, expect, it } from "vitest";
import type { ToolProviderRecoverySnapshot } from "@traceforge/worker-runtime";
import { createDb, getSqliteClient } from "./db/client.js";
import { SqliteToolProviderRecoveryStateStore } from "./tool-provider-recovery-adapter.js";
import {
  ToolProviderRecoveryReconciler,
  type ToolProviderRecoveryControlPort,
} from "./tool-provider-recovery-reconciler.js";
import type { ToolProviderInstallState } from "./tool-provider-control-plane.js";

interface Installation {
  manifest: { providerId: string; version: string };
  state: ToolProviderInstallState;
  stateReason: string | null;
}

class MemoryControl implements ToolProviderRecoveryControlPort {
  readonly calls: Array<{ providerId: string; version: string; reason: string; actor: string; commandId: string }> = [];
  constructor(readonly installations: Installation[]) {}
  list() { return this.installations; }
  async quarantine(providerId: string, version: string, reason: string, actor: string, commandId: string) {
    this.calls.push({ providerId, version, reason, actor, commandId });
    const installation = this.installations.find((entry) => entry.manifest.providerId === providerId && entry.manifest.version === version)!;
    installation.state = "quarantined";
    installation.stateReason = reason;
  }
}

function installation(providerId: string, state: ToolProviderInstallState, stateReason: string | null = null): Installation {
  return { manifest: { providerId, version: "1.0.0" }, state, stateReason };
}

function snapshot(providerId: string, status: ToolProviderRecoverySnapshot["status"], revision = 1): ToolProviderRecoverySnapshot {
  return {
    schemaVersion: 1,
    identity: { providerId, version: "1.0.0" },
    status,
    revision,
    failures: status === "healthy" ? [] : [{
      kind: "crash", message: "provider process exited", retryable: true, at: "2026-08-29T04:00:00.000Z",
    }],
    nextAttemptAt: status === "backoff" ? "2026-08-29T04:00:01.000Z" : null,
    stabilityDeadlineAt: status === "observing" ? "2026-08-29T04:01:00.000Z" : null,
    quarantineReason: status === "quarantined" ? "failure budget exhausted" : null,
    updatedAt: "2026-08-29T04:00:00.000Z",
  };
}

describe("ToolProviderRecoveryReconciler", () => {
  it("projects a durable recovery quarantine before an enabled Provider can recover", async () => {
    const sqlite = getSqliteClient(createDb(":memory:"));
    const state = new SqliteToolProviderRecoveryStateStore(sqlite);
    await state.save(snapshot("first-provider", "quarantined", 3));
    const control = new MemoryControl([installation("first-provider", "enabled")]);
    const reconciler = new ToolProviderRecoveryReconciler(state, control);

    await expect(reconciler.reconcile()).resolves.toEqual({
      projectedToControl: ["first-provider@1.0.0"], projectedToRecovery: [], consistent: [],
    });
    expect(control.calls).toEqual([expect.objectContaining({
      actor: "provider-recovery-reconciler",
      commandId: "provider-recovery:first-provider:1.0.0:3",
      reason: "failure budget exhausted",
    })]);
    expect(control.installations[0]?.state).toBe("quarantined");
    sqlite.close();
  });

  it("projects a control-plane quarantine over an interrupted recovery snapshot", async () => {
    const sqlite = getSqliteClient(createDb(":memory:"));
    const state = new SqliteToolProviderRecoveryStateStore(sqlite);
    await state.save(snapshot("first-provider", "recovering", 4));
    const control = new MemoryControl([installation("first-provider", "quarantined", "operator isolation")]);
    const reconciler = new ToolProviderRecoveryReconciler(state, control, () => new Date("2026-08-29T05:00:00.000Z"));

    await expect(reconciler.reconcile()).resolves.toEqual({
      projectedToControl: [], projectedToRecovery: ["first-provider@1.0.0"], consistent: [],
    });
    await expect(state.load({ providerId: "first-provider", version: "1.0.0" })).resolves.toMatchObject({
      status: "quarantined", revision: 5, quarantineReason: "operator isolation",
      nextAttemptAt: null, stabilityDeadlineAt: null,
    });
    expect(control.calls).toEqual([]);
    sqlite.close();
  });

  it("validates every stored snapshot before performing any projection", async () => {
    const sqlite = getSqliteClient(createDb(":memory:"));
    const state = new SqliteToolProviderRecoveryStateStore(sqlite);
    await state.save(snapshot("first-provider", "quarantined"));
    await state.save(snapshot("second-provider", "healthy"));
    sqlite.prepare("UPDATE tool_provider_recovery_states SET snapshot_json = '{' WHERE provider_id = 'second-provider'").run();
    const control = new MemoryControl([
      installation("first-provider", "enabled"), installation("second-provider", "enabled"),
    ]);
    const reconciler = new ToolProviderRecoveryReconciler(state, control);

    await expect(reconciler.reconcile()).rejects.toThrow(/not valid JSON/);
    expect(control.calls).toEqual([]);
    expect(control.installations.map((entry) => entry.state)).toEqual(["enabled", "enabled"]);
    sqlite.close();
  });

  it("leaves unrelated healthy Provider state untouched", async () => {
    const sqlite = getSqliteClient(createDb(":memory:"));
    const state = new SqliteToolProviderRecoveryStateStore(sqlite);
    await state.save(snapshot("first-provider", "healthy", 2));
    const control = new MemoryControl([installation("first-provider", "enabled")]);
    const reconciler = new ToolProviderRecoveryReconciler(state, control);

    await expect(reconciler.reconcile()).resolves.toEqual({
      projectedToControl: [], projectedToRecovery: [], consistent: [],
    });
    await expect(state.load({ providerId: "first-provider", version: "1.0.0" })).resolves.toMatchObject({
      status: "healthy", revision: 2,
    });
    expect(control.calls).toEqual([]);
    sqlite.close();
  });
});
