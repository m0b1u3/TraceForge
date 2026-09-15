import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, linkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunWorkspace } from "./run-workspace.js";
import type { ExecutionToolAdapter } from "./tool-gateway.js";
import type { ToolExecutionContext } from "./model.js";
import { createExecutionToolRegistry, PolicyExecutionToolGateway } from "./tool-gateway.js";
import type { ToolExecutionResult } from "./model.js";
import { assignment } from "./test-fixtures.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function setup(seconds = 60) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "traceforge-workspace-"))); roots.push(base);
  const execute = vi.fn(async () => ({ status: "succeeded" as const, summary: "done", raw: "output", refs: ["execution-process:one"], retryable: false,
    metadata: { exitCode: 0, enforcement: { sandboxed: true, filesystemPolicyApplied: true, network: "deny", processTreeEmptyBarrier: true } } }));
  const authorize = vi.fn();
  const workspace = new RunWorkspace(join(base, "runs"), { execute } as unknown as ExecutionToolAdapter, authorize, undefined, undefined, () => seconds);
  const context: ToolExecutionContext = { caseId: "case", runId: "run", workId: "work", scopeRef: "scope", workerId: "worker", leaseId: "lease",
    leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(), idempotencyKey: "operation",
    effectivePermissions: { ...workspace.profile("case", "run", "workspace_execute", true), sources: ["test"] } };
  // File-contract tests are portable; production profile remains disabled outside macOS.
  context.effectivePermissions.filesystem = { read: [{ path: workspace.root("case", "run"), scope: "tree" }], write: [{ path: workspace.root("case", "run"), scope: "tree" }], deny: [] };
  context.effectivePermissions.process.access = "sandboxed";
  const call = async (name: string, input: unknown, ctx = context) => workspace.tools().find(tool => tool.name === `workspace_${name}`)!.execute(input, ctx);
  const json = async (name: string, input: unknown) => JSON.parse((await call(name, input)).raw);
  return { base, workspace, context, call, json, execute, authorize, root: workspace.root("case", "run") };
}

describe("Run-owned offline workspace", () => {
  it("shares only a host-selected namespace and preserves a process fence across Runs and restart",async()=>{
    const f=setup();
    const failed=vi.fn(async()=>{throw new Error("unknown execution");});
    const workspace=new RunWorkspace(join(f.base,"shared"),{execute:failed} as unknown as ExecutionToolAdapter,f.authorize,undefined,undefined,()=>60,()=>"conversation-key");
    const root=workspace.root("case","first");
    expect(workspace.root("case","second")).toBe(root);
    expect(workspace.root("other-case","second")).not.toBe(root);
    const context={...f.context,runId:"first",effectivePermissions:{...f.context.effectivePermissions,filesystem:{read:[{path:root,scope:"tree" as const}],write:[{path:root,scope:"tree" as const}],deny:[]}}};
    const file=JSON.parse((await workspace.tools().find(t=>t.name==="workspace_write")!.execute({path:"run.sh",content:"printf example",expectedDigest:null},context)).raw);
    const second={...context,runId:"second"};
    expect(JSON.parse((await workspace.tools().find(t=>t.name==="workspace_read")!.execute({path:"run.sh"},second)).raw).digest).toBe(file.digest);
    await expect(workspace.tools().find(t=>t.name==="workspace_execute")!.execute({path:"run.sh",expectedDigest:file.digest},context)).rejects.toThrow("unknown execution");
    const restored=new RunWorkspace(join(f.base,"shared"),{execute:failed} as unknown as ExecutionToolAdapter,f.authorize,undefined,undefined,()=>60,()=>"conversation-key");
    await expect(restored.tools().find(t=>t.name==="workspace_read")!.execute({path:"run.sh"},second)).rejects.toThrow("reconciliation");
    expect(failed).toHaveBeenCalledTimes(1);
  });
  it("uses explicit authorized long duration for both wall clock and CPU without widening permissions", async () => {
    const f = setup(1800), file = await f.json("write", { path: "run.sh", content: "printf ok", expectedDigest: null });
    await f.call("execute", { path: "run.sh", expectedDigest: file.digest, timeoutSeconds: 1200 });
    expect(f.execute.mock.calls[0]).toMatchObject([{ timeoutMs: 1200000, resources: { cpuTimeMs: 1200000 }, environment: {} }, { effectivePermissions: { network: "deny" } }]);
    expect(f.workspace.tools().find(t => t.name === "workspace_execute")!.timeoutMs).toBeGreaterThan(3600000);
  });
  it.each([61, 0, 1.5, "120", 3601])("rejects invalid or ungranted duration %s before process dispatch", async timeoutSeconds => {
    const f = setup(), file = await f.json("write", { path: "run.sh", content: "printf ok", expectedDigest: null });
    await expect(f.call("execute", { path: "run.sh", expectedDigest: file.digest, timeoutSeconds })).rejects.toThrow("duration");
    expect(f.execute).not.toHaveBeenCalled();
    await f.call("execute", { path: "run.sh", expectedDigest: file.digest });
    expect(f.execute).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 60000 }), expect.anything());
  });
  it("resolves the whole tool chain, requires process approval and replays receipts without rerunning", async () => {
    const f = setup(), current = assignment(), tools = f.workspace.tools();
    current.worker.capabilities = tools.flatMap(tool => tool.providedCapabilities);
    current.assignment.runId = f.context.runId;
    current.assignment.runContext.caseId = f.context.caseId;
    current.assignment.leaseExpiresAt = f.context.leaseExpiresAt;
    current.assignment.work.requiredCapabilities = ["workspace.execute"];
    const receipts = new Map<string, ToolExecutionResult>(); let approved = false, enabled = true;
    const gateway = new PolicyExecutionToolGateway(createExecutionToolRegistry(tools),
      { async authorize() { return approved ? { decision: "approved" } : { decision: "pending", approvalRef: "approval:script" }; } },
      { async get(key) { return receipts.get(key); }, async put(key, result) { receipts.set(key, result); } },
      { allowedRisks: ["read_only", "bounded_write", "privileged", "destructive"],
        permissionLayers: () => [{ source: "test", profile: enabled ? f.context.effectivePermissions : { ...f.context.effectivePermissions, process: { access: "deny", interactive: false, background: false } } }] });
    expect((await gateway.catalog(current.worker, current.assignment)).tools).toHaveLength(7);
    const invoke = (tool: string, input: unknown, key: string) => gateway.execute({ ...current, invocation: { id: key, tool, input, rationale: "Offline analysis" }, idempotencyKey: key });
    const saved = JSON.parse((await invoke("workspace_write", { path: "run.sh", content: "printf test", expectedDigest: null }, "write")).raw);
    const script = { path: "run.sh", expectedDigest: saved.digest };
    expect(await invoke("workspace_execute", script, "execute")).toMatchObject({ status: "approval_required" });
    expect(f.execute).not.toHaveBeenCalled(); approved = true;
    const result = await invoke("workspace_execute", script, "execute");
    expect(await invoke("workspace_execute", script, "execute")).toEqual(result);
    expect(f.execute).toHaveBeenCalledTimes(1);
    enabled = false;
    expect((await gateway.catalog(current.worker, current.assignment)).tools).toHaveLength(0);
    await expect(invoke("workspace_execute", { path: "run.sh" }, "different")).rejects.toThrow("policy");
  });
  it("does not create files from catalog/profile inspection and never grants another Run or user directory", () => {
    const f = setup();
    expect(existsSync(f.root)).toBe(false);
    expect(f.workspace.root("case", "other")).not.toBe(f.root);
    const profile = f.workspace.profile("case", "run", "workspace_execute", false);
    expect(profile).toMatchObject({ filesystem: { read: [], write: [] }, process: { access: "deny" }, network: "deny" });
    expect(f.workspace.tools()).toHaveLength(7);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("creates, reads, searches, edits, runs, changes and reruns with revision-protected deletion", async () => {
    const f = setup();
    const created = await f.json("write", { path: "scripts/inspect.sh", content: "printf first", expectedDigest: null });
    expect(await f.json("read", { path: "scripts/inspect.sh" })).toMatchObject({ content: "printf first", digest: created.digest });
    expect(await f.json("search", { text: "first" })).toMatchObject({ matches: [{ path: "scripts/inspect.sh", line: 1 }] });
    expect(await f.json("list", {})).toHaveLength(2);
    const edited = await f.json("edit", { path: "scripts/inspect.sh", before: "first", after: "second", expectedDigest: created.digest });
    expect((await f.call("execute", { path: "scripts/inspect.sh", expectedDigest: edited.digest, arguments: ["literal; not a command"] })).raw).toBe("output");
    expect(f.execute.mock.calls[0]).toMatchObject([{ executable: "/bin/bash", arguments: ["--noprofile", "--norc", join(f.root, "scripts/inspect.sh"), "literal; not a command"], workingDirectory: f.root, environment: {} }, { runId: "run" }]);
    const third = await f.json("edit", { path: "scripts/inspect.sh", before: "second", after: "third", expectedDigest: edited.digest });
    await expect(f.call("execute", { path: "scripts/inspect.sh", expectedDigest: edited.digest })).rejects.toThrow("revision conflict");
    await f.call("execute", { path: "scripts/inspect.sh", expectedDigest: third.digest });
    await expect(f.call("remove", { path: "scripts/inspect.sh", expectedDigest: created.digest })).rejects.toThrow("revision conflict");
    const current = await f.json("read", { path: "scripts/inspect.sh" });
    await f.call("remove", { path: "scripts/inspect.sh", expectedDigest: current.digest });
    expect(f.execute).toHaveBeenCalledTimes(2);
    expect(f.authorize).toHaveBeenCalledWith(f.context, "workspace.execute");
  });

  it.each(["../outside", "/absolute", "a/../../other", "a\\other", "a//b", "a/./b", "a\nfile"])("rejects non-relative path %s", async path => {
    await expect(setup().call("write", { path, content: "x", expectedDigest: null })).rejects.toThrow("relative");
  });

  it("rejects symlinks, hard links and directories as files", async () => {
    const f = setup(); await f.call("list", {});
    const outside = join(f.base, "private"); writeFileSync(outside, "private");
    symlinkSync(outside, join(f.root, "linked"));
    await expect(f.call("read", { path: "linked" })).rejects.toThrow("link");
    rmSync(join(f.root, "linked")); linkSync(outside, join(f.root, "hard"));
    await expect(f.call("write", { path: "hard", content: "changed", expectedDigest: null })).rejects.toThrow("link");
    rmSync(join(f.root, "hard"));
    await f.call("write", { path: "nested/file", content: "x", expectedDigest: null });
    await expect(f.call("read", { path: "nested" })).rejects.toThrow("regular file");
  });

  it("rejects stale writes, ambiguous edits, oversized content and unknown input fields", async () => {
    const f = setup(), saved = await f.json("write", { path: "file", content: "repeat repeat", expectedDigest: null });
    await expect(f.call("write", { path: "file", content: "x", expectedDigest: null })).rejects.toThrow("revision conflict");
    await expect(f.call("edit", { path: "file", before: "repeat", after: "x", expectedDigest: saved.digest })).rejects.toThrow("exactly one");
    await expect(f.call("write", { path: "large", content: "字".repeat(100_000), expectedDigest: null })).rejects.toThrow("text");
    await expect(f.call("execute", { path: "file", environment: { SECRET: "x" } })).rejects.toThrow("input");
  });

  it("requires authorization, current lease, uncancelled context and exact Run path grants", async () => {
    const f = setup(); f.authorize.mockImplementationOnce(() => { throw new Error("revoked"); });
    await expect(f.call("list", {})).rejects.toThrow("revoked");
    await expect(f.call("list", {}, { ...f.context, leaseExpiresAt: "2000-01-01" })).rejects.toThrow("lease");
    await expect(f.call("list", {}, { ...f.context, runId: "other" })).rejects.toThrow("permissions");
    await expect(f.call("list", {}, { ...f.context, signal: AbortSignal.abort() })).rejects.toThrow();
    expect(existsSync(f.root)).toBe(false);
  });

  it("serializes file operations against scripts and persistently fences uncertain cleanup across restart", async () => {
    const f = setup(), saved = await f.json("write", { path: "run.sh", content: "printf ok", expectedDigest: null });
    let release!: () => void;
    f.execute.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); throw new Error("transport lost"); });
    const running = f.call("execute", { path: "run.sh", expectedDigest: saved.digest });
    await expect(f.call("list", {})).rejects.toThrow("busy");
    release(); await expect(running).rejects.toThrow("transport lost");
    const restarted = new RunWorkspace(join(f.base, "runs"), { execute: f.execute } as unknown as ExecutionToolAdapter, f.authorize);
    await expect(restarted.tools()[0].execute({ path: "run.sh" }, f.context)).rejects.toThrow("reconciliation");
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it("does not clear a process fence on an unverified success response", async () => {
    const f = setup(), saved = await f.json("write", { path: "run.sh", content: "printf ok", expectedDigest: null });
    f.execute.mockResolvedValueOnce({ status: "succeeded", summary: "not native", raw: "", refs: [], retryable: false, metadata: { exitCode: 0, enforcement: { sandboxed: true, filesystemPolicyApplied: true, network: "deny", processTreeEmptyBarrier: false } } });
    await expect(f.call("execute", { path: "run.sh", expectedDigest: saved.digest })).rejects.toThrow("cleanup barrier");
    await expect(f.call("list", {})).rejects.toThrow("reconciliation");
  });

  it("does not quarantine files on a known preflight refusal and rechecks cancellation after preflight", async () => {
    const f = setup(), saved = await f.json("write", { path: "run.sh", content: "printf test", expectedDigest: null });
    const unavailable = new RunWorkspace(join(f.base, "runs"), { execute: f.execute } as unknown as ExecutionToolAdapter, f.authorize,
      async () => { throw new Error("Native execution unavailable"); });
    await expect(unavailable.tools().find(tool => tool.name === "workspace_execute")!.execute({ path: "run.sh", expectedDigest: saved.digest }, f.context)).rejects.toThrow("unavailable");
    expect(await f.json("list", {})).toHaveLength(1);
    const controller = new AbortController();
    const cancelled = new RunWorkspace(join(f.base, "runs"), { execute: f.execute } as unknown as ExecutionToolAdapter, f.authorize, async () => { controller.abort(); });
    await expect(cancelled.tools().find(tool => tool.name === "workspace_execute")!.execute({ path: "run.sh", expectedDigest: saved.digest }, { ...f.context, signal: controller.signal })).rejects.toThrow();
    expect(await f.json("list", {})).toHaveLength(1); expect(f.execute).not.toHaveBeenCalled();
  });
});
