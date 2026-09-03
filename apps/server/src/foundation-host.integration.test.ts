import { afterEach, describe, expect, it } from "vitest";
import { foundationHost, eventually } from "./test-fixtures/foundation-host.js";
import { registerPhysicalStorageFunctions } from "./db/physical-storage.js";

const hosts: Awaited<ReturnType<typeof foundationHost>>[] = [];
async function host(options: Parameters<typeof foundationHost>[0] = {}) { const value = await foundationHost(options); hosts.push(value); return value; }
afterEach(async () => { for (const h of hosts.splice(0)) if (h.sqlite.open) await h.close(); });

describe("Production foundation host composition", () => {
  it("waits for discovery before registering embedded workers, then runs HTTP/model/Provider/checkpoint end to end", async () => {
    let release!: () => void; const gate = new Promise<void>((done) => { release = done; });
    const h = await host({ discoveryGate: gate });
    try {
      await h.start(); await new Promise((done) => setTimeout(done, 150));
      expect((await h.request("/api/security-tools/runtime")).startupState).toBe("starting");
      expect(await h.request("/api/scenarios/workers")).toEqual([]); expect(h.requests).toHaveLength(0);
    } finally { release(); }
    await eventually(async () => (await h.state()).workItems[0]?.status === "completed");
    expect(h.calls()).toBe(1); expect(h.requests).toHaveLength(2);
    expect(h.requests[1]!.transcript.some((t: { kind: string }) => t.kind === "tool")).toBe(true);
    expect((await h.request("/api/scenarios/runs/run/model-calls")).every((c: { status: string }) => c.status === "completed")).toBe(true);
    expect(h.sqlite.prepare("SELECT count(*) AS n FROM worker_checkpoints").get()).toMatchObject({ n: 3 });
  });
  it("isolates identical Work names across Runs and preserves both model histories", async () => {
    const h = await host(); await h.start("first-run");
    await eventually(async () => (await h.state("first-run")).workItems[0]?.status === "completed");
    await h.start("second-run"); await eventually(async () => (await h.state("second-run")).workItems[0]?.status === "completed");
    expect(h.calls()).toBe(2);
    const rows = h.sqlite.prepare("SELECT id,run_id FROM scenario_cognitive_snapshots WHERE consumer='worker'").all() as Array<{ id: string; run_id: string }>;
    expect(rows).toHaveLength(4); expect(new Set(rows.map((r) => r.id)).size).toBe(4);
    expect(new Set(rows.map((r) => r.run_id)).size).toBe(2);
  });
  it("restores confirmed output after checkpoint HTTP failure and complete host restart without redispatch", async () => {
    const first = await host({ failResultCheckpoint: true }); await first.start();
    await eventually(async () => (await first.state()).workItems[0]?.status === "failed");
    expect(first.calls()).toBe(1); const previous = await first.state();
    await first.close(false);
    const next = await host({ root: first.root });
    await next.request("/api/scenarios/runs/run/work/work/continue", { commandId: "continue", actor: "test", reason: "Resume saved result",
      expectedRevision: previous.revision, checkpointRef: previous.workItems[0].latestCheckpoint.payloadRef });
    await completed(next);
    expect(next.calls()).toBe(0); expect(next.requests).toHaveLength(1);
    expect(next.requests[0]!.transcript.some((t: { kind: string }) => t.kind === "tool")).toBe(true);
    expect((await next.state()).workItems).toHaveLength(1);
  });
  it("fails safely before dispatch under physical pressure through the real Worker path", async () => {
    let ready=false;const h = await host({ready:()=>ready});await h.start();
    registerPhysicalStorageFunctions(h.sqlite, () => ({ databaseBytes: 0, walBytes: 0, shmBytes: 0, availableBytes: 0 }));ready=true;
    await eventually(async () => (await h.state()).workItems[0]?.status === "failed");
    expect(h.calls()).toBe(0); expect(h.sqlite.prepare("SELECT count(*) AS n FROM worker_tool_receipts").get()).toEqual({ n: 0 });
  });
  it("uses a new evaluation identity when the same Work retries a model turn under a new lease", async () => {
    let failed = false;
    const h = await host({ model: async (args) => {
      const context = JSON.parse(args.user);
      if (!context.transcript.some((t: { kind: string }) => t.kind === "tool")) return { type: "invoke_tool",
        invocation: { id: "first", tool: "fixture.read", input: {}, rationale: "Observe" } };
      if (!failed) { failed = true; throw new Error("Transient model failure after saved observation"); }
      return { type: "complete", summary: "Recovered", outputs: [] };
    } });
    await h.start(); await eventually(async () => (await h.state()).workItems[0]?.status === "failed");
    const before = await h.state();
    await h.request("/api/scenarios/runs/run/work/work/continue", { commandId: "new-evaluation", actor: "test", reason: "Resume model evaluation",
      expectedRevision: before.revision, checkpointRef: before.workItems[0].latestCheckpoint.payloadRef });
    await completed(h);
    expect(h.calls()).toBe(1);
    expect(h.sqlite.prepare("SELECT count(*) AS n FROM scenario_cognitive_snapshots WHERE consumer='worker'").get()).toEqual({ n: 3 });
  });
  it("keeps provider crashes uncertain and refuses continuation without independent reconciliation", async () => {
    const h = await host({ input: { crash: true } }); await h.start();
    await eventually(async () => (await h.state()).workItems[0]?.status === "blocked");
    expect(h.calls()).toBe(1);
    expect(h.sqlite.prepare("SELECT status FROM tool_invocation_executions").get()).toEqual({ status: "uncertain" });
    const state = await h.state();
    await expect(h.request("/api/scenarios/runs/run/work/work/continue", { commandId: "unsafe", actor: "test", reason: "Try resume",
      expectedRevision: state.revision, checkpointRef: state.workItems[0].latestCheckpoint.payloadRef })).rejects.toThrow("409");
    expect(h.sqlite.prepare("SELECT count(*) AS n FROM worker_tool_receipts").get()).toEqual({ n: 0 });
  });
  it.each(["invalid", "timeout"])("settles %s model failures without dispatching or retaining a running model reservation", async (mode) => {
    const h = await host({ model: async () => mode === "invalid" ? { type: "invented" } : new Promise(() => {}) }); await h.start();
    await eventually(async () => (await h.state()).workItems[0]?.status === "failed");
    expect(h.calls()).toBe(0);
    expect(h.sqlite.prepare("SELECT count(*) AS n FROM scenario_model_calls WHERE status='running'").get()).toEqual({ n: 0 });
  });
  it("keeps a zero-package host free of implicit scenario Workers", async () => {
    const h = await host({ empty: true });
    await eventually(async () => (await h.request("/api/security-tools/runtime")).startupState === "ready");
    expect(await h.request("/api/scenarios/definitions")).toEqual([]);
    expect(await h.request("/api/scenarios/workers")).toEqual([]); expect(h.requests).toHaveLength(0);
  });
  it("closes an active host even when its model ignores cancellation", async () => {
    const h = await host({ modelTimeoutMs: 60000, model: async () => new Promise(() => {}) });
    await h.start(); await eventually(async () => h.requests.length === 1);
    const started = Date.now(); await h.app.close();
    expect(Date.now() - started).toBeLessThan(3000);
    expect(h.calls()).toBe(0); expect(h.rpc.status().state).toBe("stopped");
    expect(h.sqlite.prepare("SELECT count(*) AS n FROM scenario_model_calls WHERE status='running'").get()).toEqual({ n: 0 });
  });
  it("drains startup before closing its sources, without registering a late Worker", async () => {
    let release!: () => void; const gate = new Promise<void>((done) => { release = done; });
    const h = await host({ discoveryGate: gate }); let closed = false;
    const closing = h.app.close().then(() => { closed = true; });
    try { await new Promise((done) => setTimeout(done, 40)); expect(closed).toBe(false); }
    finally { release(); await closing; }
    expect(h.requests).toHaveLength(0); expect(h.rpc.status().state).toBe("stopped");
  });
});

async function completed(h: Awaited<ReturnType<typeof foundationHost>>) {
  try {
    await eventually(async () => {
      const work = (await h.state()).workItems[0];
      if (["failed", "blocked"].includes(work?.status)) throw new Error(JSON.stringify(work));
      return work?.status === "completed";
    });
  } catch (error) {
    throw new Error(`${String(error)}; state=${JSON.stringify(await h.state())}; workers=${JSON.stringify(await h.request("/api/scenarios/workers"))}`);
  }
}
