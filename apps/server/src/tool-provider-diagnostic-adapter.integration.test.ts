import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createToolProviderDiagnostic } from "@traceforge/worker-runtime";
import { createDb, getSqliteClient } from "./db/client.js";
import { SqliteToolProviderDiagnosticStore } from "./tool-provider-diagnostic-adapter.js";

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });

function setup(policy = {}, now = "2026-08-29T07:00:00.000Z") {
  const sqlite = getSqliteClient(createDb(":memory:"));
  open.push(sqlite);
  return { sqlite, store: new SqliteToolProviderDiagnosticStore(sqlite, policy, () => now) };
}

function diagnostic(id: string, detail: string, createdAt = "2026-08-29T07:00:00.000Z") {
  return createToolProviderDiagnostic({
    id, provider: { id: "first-provider", version: "1.0.0", generation: 2 },
    category: "process_exit", summary: "Tool Provider exited", detail,
    attribution: { caseId: "case-1", runId: "run-1", workId: "work-1" },
    now: new Date(createdAt),
  });
}

describe("SqliteToolProviderDiagnosticStore", () => {
  it("returns redacted summaries and requires an audited authorization decision for detail", async () => {
    const { store } = setup();
    const record = diagnostic("diagnostic-1", "private stderr");
    store.write(record);

    const summary = store.getSummary(record.id)!;
    expect(summary).toMatchObject({ id: record.id, summary: record.summary, detailRetained: true });
    expect(summary).not.toHaveProperty("detail");
    await expect(store.readDetail(record.id, { actor: "operator-1", purpose: "incident review" }, {
      async authorize() { return { decision: "denied", reason: "missing diagnostic-detail permission" }; },
    })).resolves.toEqual({ status: "denied", reason: "missing diagnostic-detail permission" });
    await expect(store.readDetail(record.id, { actor: "operator-2", purpose: "incident review" }, {
      async authorize(input) {
        expect(input.diagnostic).not.toHaveProperty("detail");
        return { decision: "allowed", reason: "authorized incident responder" };
      },
    })).resolves.toMatchObject({ status: "allowed", detail: "private stderr", diagnostic: { id: record.id } });
    await expect(store.readDetail(record.id, { actor: "operator-3", purpose: "incident review" }, {
      async authorize() { throw new Error("authorization backend unavailable"); },
    })).resolves.toEqual({ status: "denied", reason: "Diagnostic detail authorization failed closed" });
    expect(store.listAccessAudit(record.id).map((entry) => ({ actor: entry.actor, decision: entry.decision }))).toEqual([
      { actor: "operator-1", decision: "denied" },
      { actor: "operator-2", decision: "allowed" },
      { actor: "operator-3", decision: "denied" },
    ]);
  });

  it("purges only retained detail by age while preserving the opaque diagnostic reference", async () => {
    const { store } = setup({ retentionMs: 1_000, cleanupBatchSize: 1 }, "2026-08-29T07:00:02.000Z");
    const record = diagnostic("diagnostic-expired", "sensitive historical detail", "2026-08-29T07:00:00.000Z");
    store.write(record);

    expect(store.getSummary(record.id)).toMatchObject({ id: record.id, detailRetained: false, detailPurgedAt: "2026-08-29T07:00:02.000Z" });
    await expect(store.readDetail(record.id, { actor: "operator", purpose: "late review" }, {
      async authorize() { throw new Error("purged detail must not reach authorization"); },
    })).resolves.toEqual({ status: "detail_purged", reason: "Diagnostic detail is no longer retained" });
    expect(store.cleanup("2026-08-29T07:00:03.000Z")).toMatchObject({ purgedRecords: 0, reclaimedBytes: 0 });
  });

  it("enforces hard record and byte capacity through bounded, oldest-first cleanup batches", () => {
    const { sqlite, store } = setup({
      retentionMs: 60_000, maximumRetainedRecords: 2, maximumRetainedDetailBytes: 6, cleanupBatchSize: 1,
    }, "2026-08-29T07:00:03.000Z");
    store.write(diagnostic("diagnostic-1", "111", "2026-08-29T07:00:01.000Z"));
    store.write(diagnostic("diagnostic-2", "222", "2026-08-29T07:00:02.000Z"));
    store.write(diagnostic("diagnostic-3", "333", "2026-08-29T07:00:03.000Z"));

    expect(store.listSummaries().map((entry) => ({ id: entry.id, retained: entry.detailRetained }))).toEqual([
      { id: "diagnostic-3", retained: true },
      { id: "diagnostic-2", retained: true },
      { id: "diagnostic-1", retained: false },
    ]);
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(detail_bytes), 0) AS bytes
      FROM tool_provider_diagnostics WHERE detail_retained = 1
    `).get()).toEqual({ count: 2, bytes: 6 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM tool_provider_diagnostic_cleanup_audit WHERE purged_records > 0").get())
      .toEqual({ count: 1 });
  });
});
