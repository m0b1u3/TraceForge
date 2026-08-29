import { describe, expect, it } from "vitest";
import { createDb, getSqliteClient } from "./db/client.js";
import { SqliteToolProviderSchedulingAuditStore } from "./tool-provider-scheduling-adapter.js";

describe("SqliteToolProviderSchedulingAuditStore", () => {
  it("persists scheduling rejection attribution and reason", () => {
    const sqlite = getSqliteClient(createDb(":memory:"));
    const store = new SqliteToolProviderSchedulingAuditStore(sqlite);
    store.write({
      schemaVersion: 1,
      id: "schedule-audit-1",
      outcome: "timed_out",
      reason: "wait_timeout",
      identity: {
        providerId: "provider.neutral",
        providerVersion: "1.0.0",
        toolName: "neutral.inspect",
        caseId: "case-1",
        runId: "run-1",
        workId: "work-1",
      },
      queuedAt: "2026-08-29T00:00:00.000Z",
      decidedAt: "2026-08-29T00:00:01.000Z",
      waitMs: 1_000,
    });

    expect(store.get("schedule-audit-1")).toEqual({
      schemaVersion: 1,
      id: "schedule-audit-1",
      outcome: "timed_out",
      reason: "wait_timeout",
      identity: {
        providerId: "provider.neutral",
        providerVersion: "1.0.0",
        toolName: "neutral.inspect",
        caseId: "case-1",
        runId: "run-1",
        workId: "work-1",
      },
      queuedAt: "2026-08-29T00:00:00.000Z",
      decidedAt: "2026-08-29T00:00:01.000Z",
      waitMs: 1_000,
    });
    sqlite.close();
  });
});
