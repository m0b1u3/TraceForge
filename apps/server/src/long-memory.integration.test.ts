import { expect, it } from "vitest";
import { foundationHost, eventually } from "./test-fixtures/foundation-host.js";
import { SqliteWorkerCheckpointStore } from "./worker-checkpoint-store.js";
import type { ScenarioWorkContinuationControl } from "./scenario-work-continuation.js";

it.each([60, 300])("completes %i host operations after rolling history archival without replaying effects", async (operations) => {
  let turns = 0, archivedContextVisible = false;
  const host = await foundationHost({ longTaskScope: { continuousExecution: true, maximumWorkTurns: 384, maximumWorkMinutes: 2 }, model: async args => {
    const context = JSON.parse(args.user);
    if (Array.isArray(context.entries)) return { entries: context.entries.map((entry: { id: string }) => ({ id: entry.id, text: "Progress preserved; unfinished items remain." })) };
    turns++;
    if (turns > 60 && (context.historySummary?.covered > 0 || context.transcript?.some((entry: { turn: number }) => entry.turn === 1))) archivedContextVisible = true;
    return turns <= operations ? { type: "invoke_tool", invocation: { id: `item-${turns}`, tool: "fixture.read", input: { candidate: `item-${turns}` }, rationale: "Process the next item with its own identity." } }
      : { type: "complete", summary: "All assigned items processed", outputs: [] };
  } });
  try {
    await host.start(); await eventually(async () => {
      const state = await host.state();
      if (["failed", "blocked"].includes(state.workItems[0]?.status)) throw new Error(`Long workflow stopped: ${state.workItems[0].error}`);
      return state.workItems[0]?.status === "completed";
    }, 60000).catch(async error => {
      const state = await host.state();
      throw new Error(`${String(error)}; model decisions=${turns}; effects=${host.calls()}; run=${state.status}; work=${JSON.stringify(state.workItems[0])}`);
    });
    expect(host.calls()).toBe(operations); expect(turns).toBe(operations+1);
    expect(archivedContextVisible).toBe(true);
    const checkpoint = (await host.state()).workItems[0].latestCheckpoint!;
    const saved = await new SqliteWorkerCheckpointStore(host.sqlite).load(checkpoint.payloadRef);
    expect(saved.history!.entries).toBeGreaterThan(0);
    expect(saved.journal!.entries.length).toBeLessThanOrEqual(96);
    expect(saved.journal!.completedIntentIds.length+(saved.completedHistory?.entries??0)).toBe(operations);
  } finally { await host.close(); }
});

it("resumes an archived long workflow after a model interruption and full host restart without replay", async () => {
  let turns = 0;
  const longTaskScope = { continuousExecution: true, maximumWorkTurns: 96, maximumWorkMinutes: 2 };
  const first = await foundationHost({ longTaskScope, model: async args => {
    const context = JSON.parse(args.user);
    if (Array.isArray(context.entries)) return { entries: context.entries.map((entry: { id: string }) => ({ id: entry.id, text: "Prior operations are saved." })) };
    if (++turns > 55) throw new Error("Simulated model disconnect");
    return { type: "invoke_tool", invocation: { id: `saved-${turns}`, tool: "fixture.read", input: { candidate: `saved-${turns}` }, rationale: "Process assigned item." } };
  } });
  let next: Awaited<ReturnType<typeof foundationHost>> | undefined;
  let closed = false;
  try {
    await first.start(); await eventually(async () => (await first.state()).workItems[0]?.status === "failed", 20000);
    const state = await first.state(); expect(first.calls()).toBe(55);
    await first.close(false); closed = true;
    let continueWork: ScenarioWorkContinuationControl["continue"] | undefined;
    next = await foundationHost({ root: first.root, longTaskScope,
      foundation: { workContinuationAuthorizer: undefined, onOperatorContinuationReady: port => { continueWork = port; } }, model: async args => {
      const context = JSON.parse(args.user);
      if (Array.isArray(context.entries)) return { entries: context.entries.map((entry: { id: string }) => ({ id: entry.id, text: "Prior operations are saved." })) };
      return { type: "complete", summary: "Saved operations retained after reconnect", outputs: [] };
    } });
    expect((await continueWork!({ runId: "run", workId: "work", commandId: "wrong-actor", actor: "model", reason: "Untrusted request",
      expectedRevision: state.revision, checkpointRef: state.workItems[0].latestCheckpoint.payloadRef })).audit.outcome).toBe("denied");
    expect((await continueWork!({ runId: "run", workId: "work", commandId: "resume-history", actor: "desktop-operator", reason: "Model connection restored",
      expectedRevision: state.revision, checkpointRef: state.workItems[0].latestCheckpoint.payloadRef })).audit.outcome).toBe("queued");
    await eventually(async () => (await next!.state()).workItems[0]?.status === "completed", 20000);
    expect(next.calls()).toBe(0);
    const saved = await new SqliteWorkerCheckpointStore(next.sqlite).load((await next.state()).workItems[0].latestCheckpoint.payloadRef);
    expect(saved.history!.entries).toBeGreaterThan(0);
    expect(saved.journal!.completedIntentIds).toHaveLength(55);
  } finally { if (next) await next.close(); else if (!closed) await first.close(); }
});
