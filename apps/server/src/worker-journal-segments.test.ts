import { expect, it } from "vitest";
import { createAgentExecutionJournal } from "../../../packages/agent-runtime/src/index.js";
import type { CurrentWorkerCheckpointDocument } from "@traceforge/worker-runtime";
import { SqliteWorkerCheckpointStore } from "./worker-checkpoint-store.js";
import { database, initialize } from "./test-fixtures/execution-recovery.js";

it("archives old entries without changing intent identities and verifies the chain after restart", async () => {
  const sqlite = database(); initialize(sqlite);
  try {
    const store = new SqliteWorkerCheckpointStore(sqlite);
    const journal = createAgentExecutionJournal({ sessionId: "session", initialEntries: [] });
    journal.entries = Array.from({ length: 120 }, (_, turn) => ({ turn, kind: "tool" as const, summary: `Original detail ${turn}`, refs: [], receiptKey: `receipt:${turn}` }));
    journal.turn = 120; journal.completedIntentIds = ["already-executed"];
    const original: CurrentWorkerCheckpointDocument = { version: 3, caseId: "case", runId: "run", workId: "work", workKey: "effect", workerId: "worker", leaseId: "lease", journal, pendingInvocation: null, pendingControl: null, savedAt: new Date().toISOString() };
    const invalid = structuredClone(original); invalid.journal.entries[0].turn = -1;
    await expect(store.compact(invalid)).rejects.toThrow("entry");
    expect(sqlite.prepare("SELECT count(*) AS n FROM worker_journal_segments").get()).toEqual({ n: 0 });
    const compact = await store.compact(original);
    expect(compact.journal.entries).toHaveLength(48); expect(original.journal.entries).toHaveLength(120);
    expect(compact.journal.completedIntentIds).toEqual(["already-executed"]);
    const ref = await store.save(compact);
    expect((await new SqliteWorkerCheckpointStore(sqlite).load(ref)).history?.entries).toBe(72);
    const archived = await new SqliteWorkerCheckpointStore(sqlite).archivedEntries(ref, { caseId: "case", runId: "run", workId: "work" });
    expect([...archived, ...compact.journal.entries]).toEqual(original.journal.entries);
    await expect(store.archivedEntries(ref, { caseId: "other", runId: "run", workId: "work" })).rejects.toThrow("owner");
    const saved = sqlite.prepare("SELECT body FROM worker_journal_segments WHERE id=?").get(compact.history!.head) as { body: string };
    expect(JSON.parse(saved.body).entries[0].summary).toBe("Original detail 0");
    sqlite.prepare("UPDATE worker_journal_segments SET body='{}'").run();
    await expect(store.load(ref)).rejects.toThrow("corrupt");
  } finally { sqlite.close(); }
});
