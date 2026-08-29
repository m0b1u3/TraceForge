import { describe, expect, it } from "vitest";
import type { ToolProviderRecoverySnapshot } from "@traceforge/worker-runtime";
import { createDb, getSqliteClient } from "./db/client.js";
import { SqliteToolProviderRecoveryStateStore } from "./tool-provider-recovery-adapter.js";

function snapshot(revision: number, status: ToolProviderRecoverySnapshot["status"] = "backoff"): ToolProviderRecoverySnapshot {
  return {
    schemaVersion: 1,
    identity: { providerId: "provider.fixture", version: "1.0.0" },
    status,
    revision,
    failures: [{ kind: "crash", message: "provider crashed", retryable: true, at: "2026-08-29T01:00:00.000Z" }],
    nextAttemptAt: status === "backoff" ? "2026-08-29T01:00:01.000Z" : null,
    stabilityDeadlineAt: null,
    quarantineReason: status === "quarantined" ? "failure budget exhausted" : null,
    updatedAt: "2026-08-29T01:00:00.000Z",
  };
}

describe("SqliteToolProviderRecoveryStateStore", () => {
  it("persists and strictly restores a recovery snapshot", async () => {
    const sqlite = getSqliteClient(createDb(":memory:"));
    const store = new SqliteToolProviderRecoveryStateStore(sqlite);
    await store.save(snapshot(1));
    await expect(store.load({ providerId: "provider.fixture", version: "1.0.0" })).resolves.toEqual(snapshot(1));
    sqlite.close();
  });

  it("rejects stale revision writes without rolling state backward", async () => {
    const sqlite = getSqliteClient(createDb(":memory:"));
    const store = new SqliteToolProviderRecoveryStateStore(sqlite);
    await store.save(snapshot(2, "quarantined"));
    await expect(store.save(snapshot(1))).rejects.toThrow(/Stale Tool Provider recovery revision/);
    await expect(store.load({ providerId: "provider.fixture", version: "1.0.0" })).resolves.toMatchObject({ revision: 2, status: "quarantined" });
    sqlite.close();
  });

  it("rejects corrupted JSON and envelope revision mismatches", async () => {
    const sqlite = getSqliteClient(createDb(":memory:"));
    const store = new SqliteToolProviderRecoveryStateStore(sqlite);
    await store.save(snapshot(1));
    sqlite.prepare("UPDATE tool_provider_recovery_states SET snapshot_json = '{' WHERE provider_id = 'provider.fixture'").run();
    await expect(store.load({ providerId: "provider.fixture", version: "1.0.0" })).rejects.toThrow(/not valid JSON/);
    sqlite.prepare("UPDATE tool_provider_recovery_states SET snapshot_json = ? WHERE provider_id = 'provider.fixture'").run(JSON.stringify(snapshot(2)));
    await expect(store.load({ providerId: "provider.fixture", version: "1.0.0" })).rejects.toThrow(/revision does not match/);
    sqlite.close();
  });
});
