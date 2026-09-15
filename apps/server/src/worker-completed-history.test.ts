import { expect, it } from "vitest";
import { createAgentExecutionJournal } from "../../../packages/agent-runtime/src/index.js";
import { AgentJournalCheckpointAdapter } from "../../../packages/worker-runtime/src/agent-journal-checkpoint.js";
import type { CurrentWorkerCheckpointDocument } from "@traceforge/worker-runtime";
import { SqliteWorkerCheckpointStore } from "./worker-checkpoint-store.js";
import { database, initialize } from "./test-fixtures/execution-recovery.js";

it("retains more than 4096 committed identities with a bounded active checkpoint and exact historical lookup", async () => {
  const sqlite=database(); initialize(sqlite);
  try {
    const store=new SqliteWorkerCheckpointStore(sqlite);
    let doc: CurrentWorkerCheckpointDocument = { version:3,caseId:"case",runId:"run",workId:"work",workKey:"effect",workerId:"worker",leaseId:"lease",
      journal:createAgentExecutionJournal({sessionId:"session",initialEntries:[]}),pendingInvocation:null,pendingControl:null,savedAt:new Date().toISOString() };
    for(let batch=0;batch<34;batch++) {
      doc.journal.completedIntentIds.push(...Array.from({length:128},(_,i)=>`item-${batch*128+i}`));
      doc.journal.turn+=128;
      doc=await store.compact(doc);
    }
    expect(doc.journal.completedIntentIds.length).toBeLessThanOrEqual(256);
    expect(doc.completedHistory!.entries+doc.journal.completedIntentIds.length).toBe(4352);
    const ref=await store.save(doc);
    const restored=await new SqliteWorkerCheckpointStore(sqlite).load(ref) as CurrentWorkerCheckpointDocument;
    const adapter=new AgentJournalCheckpointAdapter(store);
    expect(await adapter.hasCompleted(restored,"item-0")).toBe(true);
    expect(await adapter.hasCompleted(restored,"item-4351")).toBe(true);
    expect(await adapter.hasCompleted(restored,"never-executed")).toBe(false);
    await expect(store.save({...restored,workId:"other"})).rejects.toThrow("ownership");
    await expect(store.save({...restored,journal:{...restored.journal,completedIntentIds:["item-0"]}})).rejects.toThrow("overlaps");
    expect(()=>sqlite.prepare("UPDATE worker_completed_segments SET body='{}'").run()).toThrow("immutable");
    await expect(new AgentJournalCheckpointAdapter({save:store.save.bind(store),load:store.load.bind(store)}).hasCompleted(restored,"item-0")).rejects.toThrow("cannot read");
  } finally {sqlite.close();}
});
