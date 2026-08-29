import { describe, expect, it } from "vitest";
import type { ExecutionToolDiscoverySnapshot, ExecutionToolSpec } from "@traceforge/worker-runtime";
import { executionToolCatalogFingerprint } from "@traceforge/worker-runtime";
import { createDb, getSqliteClient } from "./db/client.js";
import { SqliteExecutionToolDiscoveryStateStore } from "./tool-discovery-state-adapter.js";

const catalog: ExecutionToolSpec[] = [{
  name: "first", source: "external", version: "1.0.0", priority: 100, description: "first",
  inputSchema: {}, providedCapabilities: ["cap.first"], dependencyCapabilities: [],
  permissionRequirements: {}, risk: "read_only", timeoutMs: 1_000,
}];

function snapshot(revision: number): ExecutionToolDiscoverySnapshot {
  return {
    schemaVersion: 1, source: "external", revision, outcome: "ready",
    lastAttemptAt: "2026-08-29T02:00:00.000Z", lastSuccessAt: "2026-08-29T02:00:01.000Z",
    lastFailure: null, lastSuccessfulCatalog: catalog,
    catalogFingerprint: executionToolCatalogFingerprint(catalog), updatedAt: "2026-08-29T02:00:01.000Z",
  };
}

describe("SqliteExecutionToolDiscoveryStateStore", () => {
  it("persists and strictly restores discovery history", async () => {
    const sqlite = getSqliteClient(createDb(":memory:"));
    const store = new SqliteExecutionToolDiscoveryStateStore(sqlite);
    await store.save(snapshot(1));
    await expect(store.load("external")).resolves.toEqual(snapshot(1));
    sqlite.close();
  });

  it("rejects stale revisions", async () => {
    const sqlite = getSqliteClient(createDb(":memory:"));
    const store = new SqliteExecutionToolDiscoveryStateStore(sqlite);
    await store.save(snapshot(2));
    await expect(store.save(snapshot(1))).rejects.toThrow(/Stale tool discovery revision/);
    await expect(store.load("external")).resolves.toMatchObject({ revision: 2 });
    sqlite.close();
  });

  it("rejects corrupted JSON and envelope mismatches", async () => {
    const sqlite = getSqliteClient(createDb(":memory:"));
    const store = new SqliteExecutionToolDiscoveryStateStore(sqlite);
    await store.save(snapshot(1));
    sqlite.prepare("UPDATE tool_discovery_states SET state_json = '{' WHERE source = 'external'").run();
    await expect(store.load("external")).rejects.toThrow(/not valid JSON/);
    sqlite.prepare("UPDATE tool_discovery_states SET state_json = ? WHERE source = 'external'").run(JSON.stringify(snapshot(2)));
    await expect(store.load("external")).rejects.toThrow(/revision does not match/);
    sqlite.close();
  });
});
