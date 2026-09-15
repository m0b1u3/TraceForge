import { expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { WorkspaceJobs } from "./workspace-jobs.js";
import type { RunWorkspace, ToolExecutionContext, ToolExecutionResult } from "@traceforge/worker-runtime";

const context = { caseId: "case", runId: "run", workId: "work", scopeRef: "scope", workerId: "worker", leaseId: "lease", idempotencyKey: "start" } as ToolExecutionContext;
const completed: ToolExecutionResult = { status: "succeeded", summary: "done", raw: "final", refs: [], retryable: false };
function setup(progress?: ConstructorParameters<typeof WorkspaceJobs>[6]) {
  const sqlite = new Database(":memory:");
  let finish!: (result: ToolExecutionResult) => void;
  const execute = vi.fn(async (_input?: unknown, _context?: ToolExecutionContext) => new Promise<ToolExecutionResult>(resolve => { finish = resolve; }));
  const workspace = { tools: () => [{ name: "workspace_execute", dependencyCapabilities: [], execute }] } as unknown as RunWorkspace;
  const authorize = vi.fn(), terminate = vi.fn(async () => { finish(completed); });
  const recorded = vi.fn(() => true);
  const jobs = new WorkspaceJobs(sqlite, workspace, authorize, terminate, recorded, undefined, progress);
  const call = async (name: string, input: unknown, ctx = context) => JSON.parse((await jobs.tools().find(tool => tool.name === `workspace_${name}`)!.execute(input, ctx)).raw);
  return { sqlite, jobs, execute, authorize, terminate, recorded, call, finish: () => finish(completed), async close() { await jobs.close(); sqlite.close(); } };
}
it("keeps process telemetry live after start returns and closes it after completion", async () => {
  const progress = vi.fn(), f = setup(progress);
  try {
    const start = await f.call("start", {});
    const child = f.execute.mock.calls[0]![1]!;
    child.onProgress?.({ phase: "command", text: "command" });
    expect(progress).toHaveBeenLastCalledWith(context, expect.objectContaining({ handle: start.handle, command: "command", terminal: undefined }));
    child.onProgress?.({ phase: "output", text: "first output" });
    f.finish(); await vi.waitFor(() => expect(progress).toHaveBeenLastCalledWith(context, expect.objectContaining({ output: "first output", terminal: completed })));
    const count = progress.mock.calls.length;
    child.onProgress?.({ phase: "output", text: "late" });
    expect(progress).toHaveBeenCalledTimes(count);
    expect(f.execute).toHaveBeenCalledOnce();
  } finally { await f.close(); }
});
it("returns a durable handle, streams bounded output and collects completion without repeating effects", async () => {
  const f = setup();
  try {
    const start = await f.call("start", { path: "task.sh" });
    expect(start).toMatchObject({ state: "starting", completionConfirmed: false });
    expect(f.jobs.pending("run", "work")).toBe(true);
    f.jobs.started(context, { processId: "process", adoptionToken: "host-only" });
    f.jobs.output(context, "first");
    expect(await f.call("poll", { handle: start.handle, waitSeconds: 0 })).toMatchObject({ output: "first", nextCursor: 5, state: "running" });
    expect(await f.call("start", { path: "task.sh" })).toMatchObject({ handle: start.handle, replayed: true });
    expect(f.execute).toHaveBeenCalledTimes(1);
    f.finish(); await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.jobs.pending("run", "work")).toBe(true);
    expect(await f.call("poll", { handle: start.handle, cursor: 5, waitSeconds: 0 })).toMatchObject({ state: "completed", terminalResult: completed });
    expect(f.jobs.pending("run", "work")).toBe(false);
    expect(JSON.stringify(f.sqlite.prepare("SELECT * FROM workspace_jobs").all())).not.toContain("host-only");
  } finally { await f.close(); }
});
it("isolates handles by Work/lease and stops the exact owned process", async () => {
  const f = setup();
  try {
    const start = await f.call("start", {});
    f.jobs.started(context, { processId: "one", adoptionToken: "private" });
    await expect(f.call("stop", { handle: start.handle }, { ...context, leaseId: "other" })).rejects.toThrow("belong");
    expect(f.terminate).not.toHaveBeenCalled();
    await f.call("stop", { handle: start.handle });
    expect(f.terminate).toHaveBeenCalledExactlyOnceWith({ processId: "one", adoptionToken: "private" });
  } finally { await f.close(); }
});
it("refuses missing consent before durable intent or dispatch", async () => {
  const f = setup(); f.authorize.mockImplementation(() => { throw new Error("no consent"); });
  try {
    await expect(f.call("start", {})).rejects.toThrow("no consent"); expect(f.execute).not.toHaveBeenCalled();
    expect(f.sqlite.prepare("SELECT * FROM workspace_jobs").all()).toEqual([]);
  } finally { await f.close(); }
});
it("terminates on ownership revocation even after the start tool returned", async () => {
  const f = setup();
  try {
    await f.call("start", {}); f.jobs.started(context, { processId: "one", adoptionToken: "private" });
    f.authorize.mockImplementation(() => { throw new Error("revoked"); });
    await new Promise(resolve => setTimeout(resolve, 650));
    expect(f.terminate).toHaveBeenCalledExactlyOnceWith({ processId: "one", adoptionToken: "private" });
  } finally { await f.close(); }
});
it("requires collecting every bounded output page before allowing completion", async () => {
  const f = setup();
  try {
    const start = await f.call("start", {}); f.jobs.output(context, "x".repeat(20000)); f.finish();
    await new Promise(resolve => setTimeout(resolve, 0));
    const first = await f.call("poll", { handle: start.handle, waitSeconds: 0 });
    expect(first).toMatchObject({ nextCursor: 16384, hasMoreOutput: true, terminalResult: null });
    expect(f.jobs.pending("run", "work")).toBe(true);
    const last = await f.call("poll", { handle: start.handle, cursor: first.nextCursor, waitSeconds: 0 }, { ...context, workerId: "replacement", leaseId: "next-lease" });
    expect(last).toMatchObject({ nextCursor: 20000, hasMoreOutput: false, terminalResult: completed });
    expect(f.jobs.pending("run", "work")).toBe(false);
  } finally { await f.close(); }
});
it("does not equate a returned poll response with its durable receipt", async () => {
  const f = setup();
  try {
    const start = await f.call("start", {}); f.finish(); await new Promise(resolve => setTimeout(resolve, 0));
    f.recorded.mockReturnValue(false);
    await f.call("poll", { handle: start.handle, waitSeconds: 0 }, { ...context, idempotencyKey: "poll" });
    expect(f.jobs.pending("run", "work")).toBe(true);
    await expect(f.call("start", {}, { ...context, idempotencyKey: "next-start" })).rejects.toThrow("existing workspace process");
    f.recorded.mockReturnValue(true);
    expect(f.jobs.pending("run", "work")).toBe(false);
    expect(f.recorded).toHaveBeenLastCalledWith("poll", start.handle);
  } finally { await f.close(); }
});
it("restores uncertain intent without relaunching and rejects altered idempotent input", async () => {
  const f = setup();
  try {
    const start = await f.call("start", {}); f.finish(); await new Promise(resolve => setTimeout(resolve, 0));
    await f.jobs.close();
    f.sqlite.prepare("UPDATE workspace_jobs SET state='running',result=NULL").run();
    const replacement = new WorkspaceJobs(f.sqlite, { tools: () => [{ name: "workspace_execute", dependencyCapabilities: [], execute: f.execute }] } as unknown as RunWorkspace, () => {}, async () => {}, () => true);
    try {
      const invoke = replacement.tools().find(tool => tool.name === "workspace_start")!;
      expect(JSON.parse((await invoke.execute({}, context)).raw)).toMatchObject({ handle: start.handle, state: "unknown", replayed: true });
      await expect(invoke.execute({ changed: true }, context)).rejects.toThrow("identity conflict");
      expect(f.execute).toHaveBeenCalledTimes(1);
    } finally { await replacement.close(); }
  } finally { f.sqlite.close(); }
});
