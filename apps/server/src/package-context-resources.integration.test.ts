import { afterEach, describe, expect, it, vi } from "vitest";
import { ScenarioPackageRegistry, type ScenarioPackageInstallation } from "@traceforge/scenario-sdk";
import { BoundedOutputDistiller, executionToolContractFingerprint, type WorkerModelRequest, type ToolExecutionContext } from "@traceforge/worker-runtime";
import { PackageContextDiscoverySource, SqlitePackageContextStore, contextContentDigest } from "./package-context-resources.js";
import { contextBinding, contextFoundation, contextPackage, contextText, enableSkillContract, skillContract } from "./test-fixtures/context-package.js";
import { PackageContextLifecycle } from "./package-context-lifecycle.js";
import { database, initialize } from "./test-fixtures/execution-recovery.js";
import { foundationHost, eventually } from "./test-fixtures/foundation-host.js";
import { registerPhysicalStorageFunctions } from "./db/physical-storage.js";
import { PackageContextPolicy } from "./package-context-policy.js";
import { SqliteToolReceiptStore, SqliteToolInvocationBindingStore } from "./worker-execution-adapters.js";
import { SqliteScenarioAuthorizationService } from "./scenario-authorization.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture(configure?: (pkg: ScenarioPackageInstallation) => void, extra: Array<{ resourceId: string; content: string }> = []) {
  const sqlite = database(); cleanup.push(() => { sqlite.close(); });
  const controls = initialize(sqlite); const pkg = contextPackage(["observe"]);
  pkg.resourceManifest!.resources[0]!.context!.requiredCapabilities = ["observe"];
  configure?.(pkg);
  const packages = new ScenarioPackageRegistry([pkg]); const store = new SqlitePackageContextStore(sqlite);
  store.install(packages, [{ package: contextBinding, resourceId: "first", content: contextText }, ...extra.map((r) => ({ package: contextBinding, ...r }))]);
  sqlite.prepare("INSERT INTO scenario_authorizations(id,case_id,scenario_kind,scope_json,status,approved_by,expires_at,created_at,updated_at) VALUES ('scope','case','neutral','{}','active','test','2099-01-01T00:00:00Z','2026-01-01','2026-01-01')").run();
  const run = controls.runtime.load("run")!;
  new SqliteScenarioAuthorizationService(sqlite,packages).pin("scope","case",contextBinding,0);
  const source = new PackageContextDiscoverySource(packages, store, sqlite, (id) => id === "run" ? run : null);
  const context = { runId: "run", workId: "work", workerId: "worker", caseId: "case", scopeRef: "scope", leaseId: "lease",
    leaseExpiresAt: "2099-01-01", idempotencyKey: "first", effectivePermissions: {} } as ToolExecutionContext;
  const read = async (args: unknown = { id: "first", digest: contextContentDigest(contextText) }, ctx = context) => (await source.discover())[1]!.execute(args, ctx);
  return { sqlite, pkg, packages, store, source, context, run, read };
}

async function observedFixture(configure?: (pkg: ScenarioPackageInstallation) => void) {
  const f = fixture(configure); const receipt = await f.read();
  const bindings = new SqliteToolInvocationBindingStore(f.sqlite);
  const tool = (await f.source.discover())[1]!;
  const { execute: _execute, ...toolSpec } = tool;
  await bindings.prepare({ idempotencyKey: "effect:first", invocationId: "first", inputFingerprint: "a".repeat(64),
    tool: { name: tool.name, source: tool.source, version: tool.version, contractFingerprint: executionToolContractFingerprint(tool) },
    attribution: { caseId: "case", runId: "run", workId: "work" } });
  await new SqliteToolReceiptStore(f.sqlite).put("effect:first", receipt); await bindings.complete("effect:first");
  const request: WorkerModelRequest = { turnId: "turn", worker: { id: "worker", roles: ["observer"], capabilities: ["observe"],
    status: "online", maxConcurrentWork: 1, heartbeatAt: new Date().toISOString() },
    assignment: { runId: "run", leaseId: "lease", leaseExpiresAt: "2099-01-01", runRevision: f.run.revision,
      runContext: { caseId: "case", goal: "Observe", scopeRef: "scope", activePhaseId: "observe", directives: [] }, work: f.run.workItems[0]! },
    tools: [toolSpec], toolResolution: { requestedCapabilities: ["observe"], unresolvedCapabilities: [], registryRevision: 1 },
    transcript: [{ turn: 1, kind: "tool", ...await new BoundedOutputDistiller().distill(receipt, 8000), receiptKey: "effect:first" },
      { turn: 2, kind: "model", summary: `Derived instruction: ${contextText}`, refs: [] }], steering: [contextText] };
  return { ...f, request, policy: new PackageContextPolicy(f.sqlite, f.source) };
}

describe("Current context projection", () => {
  it("prepares and evaluates a Skill using owned immutable receipts, without verifying findings", async () => {
    const f = fixture(enableSkillContract);
    const specs = await f.source.discover();
    const prepare = specs.find((t) => t.name === "context.skill.prepare")!;
    const evaluate = specs.find((t) => t.name === "context.skill.evaluate")!;
    const prepared = await prepare.execute({ id: "first", digest: contextContentDigest(contextText), input: { candidate: "first" } }, { ...f.context, idempotencyKey: "effect:prepare" });
    expect(prepared.status).toBe("succeeded");
    expect(JSON.parse(prepared.raw)).toMatchObject({ executionAuthorized: false, contract: skillContract, preparationKey: "effect:prepare" });
    const bindings = new SqliteToolInvocationBindingStore(f.sqlite);
    await bindings.prepare({ idempotencyKey: "effect:prepare", invocationId: "prepare", inputFingerprint: "a".repeat(64),
      tool: { name: prepare.name, source: prepare.source, version: prepare.version, contractFingerprint: executionToolContractFingerprint(prepare) },
      attribution: { caseId: "case", runId: "run", workId: "work" } });
    await new SqliteToolReceiptStore(f.sqlite).put("effect:prepare", prepared); await bindings.complete("effect:prepare");
    const args = { id: "first", digest: contextContentDigest(contextText), preparationKey: "effect:prepare", output: { recorded: false } };
    expect(JSON.parse((await evaluate.execute(args, f.context)).raw)).toMatchObject({ completed: false, findingVerified: false });
    args.output.recorded = true;
    expect(JSON.parse((await evaluate.execute(args, f.context)).raw)).toMatchObject({ completed: true, findingVerified: false });
    expect(await evaluate.execute({ ...args, output: { recorded: "true" } }, f.context)).toMatchObject({ status: "failed" });
    expect(await evaluate.execute({ ...args, id: "other" }, f.context)).toMatchObject({ status: "failed" });
    expect(await evaluate.execute({ ...args, preparationKey: "effect:other" }, f.context)).toMatchObject({ status: "failed" });
    f.store.revoke(contextContentDigest(contextText), "withdrawn");
    expect(await evaluate.execute(args, f.context)).toMatchObject({ status: "failed" });
    expect((await new SqliteToolReceiptStore(f.sqlite).get("effect:prepare"))!.raw).toBe(prepared.raw);
  });
  it.each([{}, { candidate: 1 }, { candidate: "x", extra: true }, { candidate: "x".repeat(2049) }])("rejects invalid Skill inputs %#", async (input) => {
    const f = fixture(enableSkillContract); const tool = (await f.source.discover()).find((t) => t.name === "context.skill.prepare")!;
    expect(await tool.execute({ id: "first", digest: contextContentDigest(contextText), input }, f.context)).toMatchObject({ status: "failed", raw: "" });
  });
  it("requires a separate Skill action grant even when its text is readable", async () => {
    const f = fixture((pkg) => { pkg.resourceManifest!.resources[0]!.context!.skill = skillContract; });
    const prepare = (await f.source.discover()).find((t) => t.name === "context.skill.prepare")!;
    expect((await f.read()).status).toBe("succeeded");
    expect(await prepare.execute({ id: "first", digest: contextContentDigest(contextText), input: { candidate: "first" } }, f.context)).toMatchObject({ status: "failed" });
  });
  it("completes the HTTP Skill preparation/evaluation chain with Gateway receipts", async () => {
    const pkg = contextPackage(["context.read", "context.skill.prepare", "context.skill.evaluate"]); enableSkillContract(pkg);
    let turns = 0;
    const h = await foundationHost({ foundation: { scenarioPackageRegistry: new ScenarioPackageRegistry([pkg]), toolDiscoverySources: [],
      contextResourceContents: [{ package: contextBinding, resourceId: "first", content: contextText }] }, model: async (args) => {
      const c = JSON.parse(args.user); turns++;
      if (turns === 1) return { type: "invoke_tool", invocation: { id: "prepare", tool: "context.skill.prepare",
        input: { id: "first", digest: contextContentDigest(contextText), input: { candidate: "first" } }, rationale: "Prepare" } };
      if (turns === 2) {
        const preparationKey = c.transcript.find((e: any) => e.kind === "tool").receiptKey;
        return { type: "invoke_tool", invocation: { id: "evaluate", tool: "context.skill.evaluate",
          input: { id: "first", digest: contextContentDigest(contextText), preparationKey, output: { recorded: true } }, rationale: "Evaluate" } };
      }
      expect(args.user).toContain('findingVerified'); expect(args.user).toContain('completed');
      return { type: "complete", summary: "Contract evaluated, not a verified finding", outputs: [] };
    } }); cleanup.push(() => h.close());
    await h.start(); await eventually(async () => (await h.state()).workItems[0]?.status === "completed");
    expect(turns).toBe(3);
    const receipts = h.sqlite.prepare("SELECT result_json FROM worker_tool_receipts").all() as { result_json: string }[];
    expect(receipts).toHaveLength(2); expect(receipts.every((r) => JSON.parse(r.result_json).status === "succeeded")).toBe(true);
  });
  it("reconstructs only from bound receipts and does not trust a supplied copy of resource text", async () => {
    const f = await observedFixture(); f.request.transcript[0]!.summary = "FORGED_INSTRUCTION";
    f.request.transcript.push({ ...f.request.transcript[0]!, turn: 3 });
    const scan = vi.spyOn(f.source, "selection");
    const projected = await f.policy.prepare(f.request);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(projected.request.transcript[0]!.summary).toContain(contextText);
    expect(JSON.stringify(projected.request)).not.toContain("FORGED_INSTRUCTION");
    expect(f.request.transcript[0]!.summary).toBe("FORGED_INSTRUCTION");
  });
  it.each(["revocation", "scope", "phase", "expiry", "corruption", "missing"])("filters %s while preserving the immutable original", async (mode) => {
    const f = await observedFixture((pkg) => { pkg.resourceManifest!.resources[0]!.context!.expiresAt = "2030-01-01T00:00:00Z"; });
    if (mode === "revocation") f.store.revoke(contextContentDigest(contextText), "withdrawn");
    if (mode === "scope") f.sqlite.prepare("UPDATE scenario_authorizations SET status='revoked'").run();
    if (mode === "phase") f.run.workItems[0]!.phaseId = "other";
    if (mode === "expiry") vi.spyOn(Date, "now").mockReturnValue(Date.parse("2031-01-01T00:00:00Z"));
    if (mode === "corruption") f.sqlite.prepare("UPDATE package_context_content SET content='changed'").run();
    if (mode === "missing") f.sqlite.prepare("DELETE FROM package_context_content").run();
    const before = JSON.stringify(f.request); const projected = await f.policy.prepare(f.request);
    expect(JSON.stringify(projected.request)).not.toContain(contextText);
    expect(projected.manifest.contextGovernance.suppressed).toHaveLength(1);
    expect(JSON.stringify(f.request)).toBe(before);
    expect((await new SqliteToolReceiptStore(f.sqlite).get("effect:first"))!.raw).toContain(contextText);
  });
  it("migrates legacy resource observations using same-Work receipt lookup and never arbitrary transcript text", async () => {
    const f = await observedFixture(); delete f.request.transcript[0]!.receiptKey;
    expect((await f.policy.prepare(f.request)).request.transcript[0]!.receiptKey).toBe("effect:first");
    f.store.revoke(contextContentDigest(contextText), "withdrawn");
    expect(JSON.stringify((await f.policy.prepare(f.request)).request)).not.toContain(contextText);
  });
  it("does not accept a missing or cross-Work receipt identity", async () => {
    const f = await observedFixture(); f.request.assignment.work = { ...f.request.assignment.work, id: "other" };
    await expect(f.policy.prepare(f.request)).rejects.toThrow("attribution");
    f.request.assignment.work.id = "work"; f.request.transcript[0]!.receiptKey = "missing";
    await expect(f.policy.prepare(f.request)).rejects.toThrow("attribution");
  });
  it("bounds projection work and remains empty for a new zero-history request", async () => {
    const f = await observedFixture(); f.request.transcript = []; f.request.steering = [];
    expect((await f.policy.prepare(f.request)).request.transcript).toEqual([]);
    f.request.transcript = Array.from({ length: 513 }, () => ({ turn: 1, kind: "system" as const, summary: "", refs: [] }));
    await expect(f.policy.prepare(f.request)).rejects.toThrow("budget");
  });
  it("searches, reads, withdraws and filters through the HTTP Worker while keeping prior snapshots", async () => {
    const settings = contextFoundation();
    settings.scenarioPackageRegistry = new ScenarioPackageRegistry([contextPackage(["context.search", "context.read", "context.catalog"])]);
    // Scope capabilities must explicitly admit search, not infer it from read permission.
    const pkg = settings.scenarioPackageRegistry.requireForScenario("neutral", 1);
    pkg.definition.authorizationActions.push("context.search");
    const policy = pkg.authorizationPolicy as { parseScope(payload: unknown): { payload: unknown; allowedActions: string[]; deniedActions: string[] } };
    const parse = policy.parseScope;
    policy.parseScope = (payload) => ({ ...parse(payload), allowedActions: ["context.search", "context.read", "context.catalog"] });
    let h!: Awaited<ReturnType<typeof foundationHost>>; let turns = 0;
    h = await foundationHost({ foundation: settings, model: async (args) => {
      turns++; const c = JSON.parse(args.user);
      if (turns === 1) return { type: "invoke_tool", invocation: { id: "search", tool: "context.search", input: { query: "candidate" }, rationale: "Find relevant material" } };
      if (turns === 2) { expect(args.user).not.toContain(contextText); return { type: "invoke_tool", invocation: { id: "read", tool: "context.read", input: { id: "first", digest: contextContentDigest(contextText) }, rationale: "Read selected material" } }; }
      if (turns === 3) { expect(args.user).toContain(contextText); new SqlitePackageContextStore(h.sqlite).revoke(contextContentDigest(contextText), "withdrawn");
        return { type: "invoke_tool", invocation: { id: "refresh", tool: "context.catalog", input: {}, rationale: contextText } }; }
      expect(args.user).not.toContain(contextText); expect(c.manifest.contextGovernance.suppressed.length).toBeGreaterThan(0);
      return { type: "complete", summary: "Replanned without stale material", outputs: [] };
    } }); cleanup.push(() => h.sqlite.open ? h.close() : undefined);
    await h.start(); await eventually(async () => (await h.state()).workItems[0]?.status === "failed");
    // Revocation during inference now rejects that decision before its proposed tool can run.
    const stopped = await h.state();
    await h.request("/api/scenarios/runs/run/work/work/continue", { commandId: "resume-after-context-change", actor: "test", reason: "Re-evaluate current context",
      expectedRevision: stopped.revision, checkpointRef: stopped.workItems[0].latestCheckpoint.payloadRef });
    await eventually(async () => (await h.state()).workItems[0]?.status === "completed");
    expect(turns).toBe(4);
    const snapshots = h.sqlite.prepare("SELECT id,request_json FROM scenario_cognitive_snapshots WHERE consumer='worker'").all() as Array<{ id: string; request_json: string }>;
    const historical = snapshots.find((s) => s.request_json.includes(contextText))!; expect(historical).toBeDefined();
    expect(JSON.stringify(await h.request(`/api/scenarios/cognitive-snapshot?snapshotId=${encodeURIComponent(historical.id)}`))).toContain(contextText);
    await expect(h.request("/api/scenarios/cognitive-snapshot-replays", { snapshotId: historical.id })).rejects.toThrow("409"); expect(turns).toBe(4);
    expect(JSON.stringify(h.sqlite.prepare("SELECT document_json FROM worker_checkpoints").all())).toContain(contextText);
    expect(h.sqlite.prepare("SELECT count(*) AS n FROM worker_tool_receipts").get()).toEqual({ n: 2 });
  });
  it("revalidates a confirmed old receipt after full host restart instead of reinjecting withdrawn text", async () => {
    const settings = contextFoundation();
    const first = await foundationHost({ foundation: settings, failResultCheckpoint: true, model: async () => ({ type: "invoke_tool",
      invocation: { id: "read", tool: "context.read", input: { id: "first", digest: contextContentDigest(contextText) }, rationale: "Read" } }) });
    cleanup.push(() => first.sqlite.open ? first.close() : undefined);
    await first.start(); await eventually(async () => (await first.state()).workItems[0]?.status === "failed");
    const before = await first.state(); await first.close(false);
    const next = await foundationHost({ root: first.root, foundation: { ...settings, contextResourceContents: [],
      revokedContextResources: [{ digest: contextContentDigest(contextText), reason: "withdrawn before restart" }] },
      model: async (args) => { expect(args.user).not.toContain(contextText); return { type: "complete", summary: "Replanned", outputs: [] }; } });
    cleanup.push(() => next.sqlite.open ? next.close() : undefined);
    await next.request("/api/scenarios/runs/run/work/work/continue", { commandId: "continue-with-current-context", actor: "test", reason: "Continue under current policy",
      expectedRevision: before.revision, checkpointRef: before.workItems[0].latestCheckpoint.payloadRef });
    await eventually(async () => (await next.state()).workItems[0]?.status === "completed");
    expect(next.requests).toHaveLength(1);
    expect(next.sqlite.prepare("SELECT count(*) AS n FROM worker_tool_receipts").get()).toEqual({ n: 1 });
  });
});

describe("Context resource administrative lifecycle", () => {
  const grant = { async authorize() { return { decision: "allowed" as const, authorizationRef: "test", expiresAt: "2099-01-01" }; } };
  const command = { commandId: "export", actor: "test", reason: "Transfer reviewed material", action: "export", package: contextBinding,
    resourceId: "first", digest: contextContentDigest(contextText) };
  it("denies by default and binds repeated commands to their exact identity", async () => {
    const f = fixture();
    await expect(new PackageContextLifecycle(f.sqlite, f.packages, f.store).execute(command)).rejects.toThrow("authorization");
    const control = new PackageContextLifecycle(f.sqlite, f.packages, f.store, grant);
    expect(await control.execute(command)).toMatchObject({ content: contextText, replayed: false });
    expect(await control.execute(command)).toMatchObject({ content: contextText, replayed: true });
    await expect(control.execute({ ...command, reason: "changed" })).rejects.toThrow("conflict");
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM package_context_lifecycle").get()).toEqual({ n: 1 });
    f.store.revoke(command.digest, "withdrawn");
    await expect(control.execute(command)).rejects.toThrow("revoked");
  });
  it("refuses active/recoverable Runs and retires revoked content without deleting evidence", async () => {
    const f = await observedFixture(); const control = new PackageContextLifecycle(f.sqlite, f.packages, f.store, grant);
    const retire = { ...command, commandId: "retire", action: "retire" };
    await expect(control.execute(retire)).rejects.toThrow("recoverable");
    f.sqlite.prepare("UPDATE scenario_event_streams SET status='failed'").run();
    await expect(control.execute(retire)).rejects.toThrow("recoverable");
    f.sqlite.prepare("UPDATE scenario_event_streams SET status='completed'").run();
    f.store.revoke(command.digest, "withdrawn");
    expect(await control.execute(retire)).toMatchObject({ action: "retire", auditOriginalsPreserved: true });
    expect(await control.execute(retire)).toMatchObject({ replayed: true });
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM package_context_content").get()).toEqual({ n: 0 });
    expect((await new SqliteToolReceiptStore(f.sqlite).get("effect:first"))!.raw).toContain(contextText);
    expect(JSON.stringify((await f.policy.prepare(f.request)).request)).not.toContain(contextText);
    expect(() => f.store.install(f.packages, [{ package: contextBinding, resourceId: "first", content: contextText }])).toThrow();
  });
  it("rolls back retirement if its audit cannot be committed", async () => {
    const f = fixture(); const control = new PackageContextLifecycle(f.sqlite, f.packages, f.store, grant);
    f.sqlite.prepare("UPDATE scenario_event_streams SET status='completed'").run();
    f.sqlite.exec("CREATE TRIGGER fixture_deny_audit BEFORE INSERT ON package_context_lifecycle BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
    await expect(control.execute({ ...command, action: "retire" })).rejects.toThrow("fixture failure");
    expect(f.store.read(contextBinding, f.pkg.resourceManifest!.resources[0]!)).toBe(contextText);
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM package_context_retired").get()).toEqual({ n: 0 });
  });
  it("bounds lifecycle audit growth and never evicts old entries to reclaim content", async () => {
    const f = fixture(); const control = new PackageContextLifecycle(f.sqlite, f.packages, f.store, grant);
    f.sqlite.prepare("UPDATE scenario_event_streams SET status='completed'").run();
    f.sqlite.exec(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<2048)
      INSERT INTO package_context_lifecycle SELECT 'seed-'||x,'seed','{}','test','{}','2026-01-01' FROM n`);
    await expect(control.execute({ ...command, action: "retire" })).rejects.toThrow("budget");
    expect(f.store.read(contextBinding, f.pkg.resourceManifest!.resources[0]!)).toBe(contextText);
    expect(() => f.sqlite.prepare("DELETE FROM package_context_lifecycle WHERE command_id='seed-1'").run()).toThrow("immutable");
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM package_context_lifecycle").get()).toEqual({ n: 2048 });
  });
  it("rejects expired grants and mismatched digests without exporting content", async () => {
    const f = fixture(); const expired = { async authorize() { return { decision: "allowed" as const, authorizationRef: "test", expiresAt: "2020-01-01" }; } };
    await expect(new PackageContextLifecycle(f.sqlite, f.packages, f.store, expired).execute(command)).rejects.toThrow("authorization");
    const control = new PackageContextLifecycle(f.sqlite, f.packages, f.store, grant);
    await expect(control.execute({ ...command, digest: `sha256:${"0".repeat(64)}` })).rejects.toThrow("mismatch");
  });
  it("exports and retires via explicitly authorized HTTP administration and persists the tombstone", async () => {
    const settings = contextFoundation();
    const h = await foundationHost({ ready: () => false, foundation: { ...settings, contextLifecycleAuthorizer: grant } });
    cleanup.push(() => h.sqlite.open ? h.close() : undefined);
    expect(await h.request("/api/scenarios/context-resources/lifecycle", command)).toMatchObject({ content: contextText });
    expect(await h.request("/api/scenarios/context-resources/lifecycle", { ...command, commandId: "retire", action: "retire" })).toMatchObject({ action: "retire" });
    await h.close(false);
    const next = await foundationHost({ root: h.root, ready: () => false, foundation: { ...settings, contextResourceContents: [], contextLifecycleAuthorizer: grant } });
    cleanup.push(() => next.close());
    expect(await next.request("/api/scenarios/context-resources/lifecycle", { ...command, commandId: "retire", action: "retire" })).toMatchObject({ replayed: true });
    await expect(next.request("/api/scenarios/context-resources/lifecycle", command)).rejects.toThrow("409");
  });
});

describe("Package context assembly", () => {
  it.each(["validFrom", "expiresAt"] as const)("excludes resources outside %s while retaining stored content", async (field) => {
    const f = fixture((pkg) => { pkg.resourceManifest!.resources[0]!.context![field] = field === "validFrom" ? "2099-01-01T00:00:00Z" : "2020-01-01T00:00:00Z"; });
    expect(await f.read()).toMatchObject({ status: "failed" });
    expect(JSON.parse((await (await f.source.discover())[0]!.execute({}, f.context)).raw).entries).toEqual([]);
    expect(f.store.read(contextBinding, f.pkg.resourceManifest!.resources[0]!)).toBe(contextText);
  });
  it("searches literal terms across authorized body and metadata without injecting body text", async () => {
    const f = fixture(); const search = (await f.source.discover())[2]!;
    const result = await search.execute({ query: "PERMISSION findings" }, f.context);
    expect(result.status).toBe("succeeded"); expect(result.raw).not.toContain(contextText);
    expect(JSON.parse(result.raw).entries).toMatchObject([{ id: "first" }]);
    expect(JSON.parse((await search.execute({ query: "missing" }, f.context)).raw).entries).toEqual([]);
    f.store.revoke(contextContentDigest(contextText), "withdrawn");
    expect(JSON.parse((await search.execute({ query: "permission" }, f.context)).raw).entries).toEqual([]);
  });
  it.each(["", "x".repeat(257), "a b c d e f g h i", 1, { $query: "first" }])("rejects invalid or over-budget search %#", async (query) => {
    const f = fixture(); expect(await (await f.source.discover())[2]!.execute({ query }, f.context)).toMatchObject({ status: "failed", raw: "" });
  });
  it("excludes both sides of an explicit active conflict and unblocks the survivor after revocation", async () => {
    const other = "Second candidate notes";
    const f = fixture((pkg) => {
      const first = pkg.resourceManifest!.resources[0]!;
      first.context!.conflictsWith = ["second"];
      pkg.resourceManifest!.resources = [first, { ...structuredClone(first), id: "second", digest: contextContentDigest(other), context: { ...first.context!, conflictsWith: [] } }];
    }, [{ resourceId: "second", content: other }]);
    expect(await f.read()).toMatchObject({ status: "failed" });
    expect(f.source.selection(f.context).conflicts.size).toBe(2);
    f.store.revoke(contextContentDigest(other), "withdrawn");
    expect(await f.read()).toMatchObject({ status: "succeeded" });
  });
  it("pins paginated search results and rejects a cursor when resource visibility changes", async () => {
    const other = "candidate secondary notes";
    const f = fixture((pkg) => {
      const first = pkg.resourceManifest!.resources[0]!;
      pkg.resourceManifest!.resources = [first, { ...structuredClone(first), id: "second", digest: contextContentDigest(other) }];
    }, [{ resourceId: "second", content: other }]);
    const search = (await f.source.discover())[2]!;
    const page = JSON.parse((await search.execute({ query: "candidate" }, f.context)).raw);
    expect(page.nextOffset).toBe(1);
    expect(await search.execute({ query: "candidate", offset: 1 }, f.context)).toMatchObject({ status: "failed" });
    expect(await search.execute({ query: "candidate", offset: 1, fingerprint: page.fingerprint }, f.context)).toMatchObject({ status: "succeeded" });
    f.store.revoke(contextContentDigest(other), "withdrawn");
    expect(await search.execute({ query: "candidate", offset: 1, fingerprint: page.fingerprint }, f.context)).toMatchObject({ status: "failed" });
  });
  it.each(["date", "order", "conflict"])("rejects malformed %s lifecycle metadata", (mode) => {
    expect(() => fixture((pkg) => {
      const info = pkg.resourceManifest!.resources[0]!.context!;
      if (mode === "date") info.expiresAt = "not-a-date";
      if (mode === "order") { info.validFrom = "2030-01-01T00:00:00Z"; info.expiresAt = "2020-01-01T00:00:00Z"; }
      if (mode === "conflict") info.conflictsWith = ["missing"];
    })).toThrow();
  });
  it("discovers summaries without loading text into the catalog, then reads a pinned attributed resource", async () => {
    const f = fixture(); const result = await (await f.source.discover())[0]!.execute({}, f.context);
    expect(result.raw).not.toContain(contextText);
    expect(JSON.parse(result.raw).entries[0]).toMatchObject({ id: "first", type: "skill", digest: contextContentDigest(contextText) });
    const loaded = await f.read(); expect(JSON.parse(loaded.raw)).toMatchObject({ content: contextText, trust: "untrusted_context", caseId: "case", runId: "run", workId: "work", package: contextBinding });
    expect(loaded.refs[0]).toMatch(/^context:[a-f0-9]{64}$/);
  });
  it.each(["case", "run", "work", "worker", "lease", "scope"])("rejects cross-%s attribution", async (field) => {
    const f = fixture(); const key = field === "scope" ? "scopeRef" : `${field}Id`;
    expect(await f.read(undefined, { ...f.context, [key]: "other" })).toMatchObject({ status: "failed", raw: "", refs: [] });
  });
  it.each(["revoked", "expired", "denied", "capability", "phase", "digest", "missing", "corrupt", "metadata"])("fails closed for %s resources", async (mode) => {
    const f = fixture();
    if (mode === "revoked") f.store.revoke(contextContentDigest(contextText), "retired");
    if (mode === "expired") f.sqlite.prepare("UPDATE scenario_authorizations SET expires_at='2020-01-01'").run();
    if (mode === "denied") (f.pkg.authorizationPolicy as { parseScope(payload: unknown): unknown }).parseScope =
      (payload) => ({ payload, allowedActions: ["context.read"], deniedActions: ["context.read"] });
    if (mode === "capability") f.run.workItems[0]!.requiredCapabilities = [];
    if (mode === "phase") f.run.workItems[0]!.phaseId = "other";
    if (mode === "missing") f.sqlite.prepare("DELETE FROM package_context_content").run();
    if (mode === "corrupt") f.sqlite.prepare("UPDATE package_context_content SET content='changed'").run();
    if (mode === "metadata") f.pkg.resourceManifest!.resources[0]!.context!.summary = "changed";
    expect(await f.read(mode === "digest" ? { id: "first", digest: contextContentDigest("different") } : undefined)).toMatchObject({ status: "failed", raw: "" });
  });
  it("preserves content and revocations across store reconstruction", async () => {
    const f = fixture(); const next = new SqlitePackageContextStore(f.sqlite);
    expect(next.read(contextBinding, f.pkg.resourceManifest!.resources[0]!)).toBe(contextText);
    next.revoke(contextContentDigest(contextText), "retired");
    expect(() => new SqlitePackageContextStore(f.sqlite).read(contextBinding, f.pkg.resourceManifest!.resources[0]!)).toThrow("revoked");
  });
  it("atomically rejects digest mismatches, undeclared content and storage overflow", () => {
    const f = fixture();
    expect(() => f.store.install(f.packages, [{ package: contextBinding, resourceId: "first", content: "wrong" }])).toThrow("digest");
    expect(() => f.store.install(f.packages, [{ package: contextBinding, resourceId: "absent", content: contextText }])).toThrow("declared");
    expect(() => new SqlitePackageContextStore(f.sqlite, 1).install(f.packages, [])).toThrow("budget");
    expect(f.store.read(contextBinding, f.pkg.resourceManifest!.resources[0]!)).toBe(contextText);
  });
  it("requires a new Package version for changed metadata even when text is unchanged", () => {
    const f = fixture(); f.pkg.resourceManifest!.resources[0]!.context!.summary = "new summary";
    expect(() => f.store.install(f.packages, [{ package: contextBinding, resourceId: "first", content: contextText }])).toThrow("immutable");
  });
  it("refuses oversized text and physical storage pressure before storing new content", () => {
    const f = fixture(); const pkg = contextPackage(["observe"]);
    const large = "x".repeat(65537); pkg.resourceManifest!.resources[0]!.digest = contextContentDigest(large);
    expect(() => f.store.install(new ScenarioPackageRegistry([pkg]), [{ package: contextBinding, resourceId: "first", content: large }])).toThrow("size");
    f.sqlite.prepare("DELETE FROM package_context_content").run();
    registerPhysicalStorageFunctions(f.sqlite, () => ({ databaseBytes: 0, walBytes: 0, shmBytes: 0, availableBytes: 0 }));
    expect(() => f.store.install(f.packages, [{ package: contextBinding, resourceId: "first", content: contextText }])).toThrow("physical storage");
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM package_context_content").get()).toEqual({ n: 0 });
  });
  it("pages large text without silently truncating content and keeps page refs distinct", async () => {
    const f = fixture(); const text = "\u0001".repeat(9000);
    f.sqlite.prepare("DELETE FROM package_context_content").run();
    f.pkg.resourceManifest!.resources[0]!.digest = contextContentDigest(text);
    f.store.install(f.packages, [{ package: contextBinding, resourceId: "first", content: text }]);
    let offset = 0; let reconstructed = ""; const refs: string[] = [];
    for (let turn = 0; turn < 30; turn++) {
      const read = await f.read({ id: "first", digest: contextContentDigest(text), offset });
      expect(read.status).toBe("succeeded"); expect(read.raw.length).toBeLessThanOrEqual(6500);
      const page = JSON.parse(read.raw); reconstructed += page.content; refs.push(...read.refs);
      if (page.nextOffset === null) break; expect(page.nextOffset).toBeGreaterThan(offset); offset = page.nextOffset;
    }
    expect(reconstructed).toBe(text); expect(new Set(refs).size).toBe(refs.length);
  });
  it("validates context references and phases at installation", () => {
    const pkg = contextPackage(); pkg.resourceManifest!.resources[0]!.context!.references = ["missing"];
    expect(() => new ScenarioPackageRegistry([pkg])).toThrow("missing context");
    pkg.resourceManifest!.resources[0]!.context!.references = []; pkg.resourceManifest!.resources[0]!.context!.phaseIds = ["missing"];
    expect(() => new ScenarioPackageRegistry([pkg])).toThrow("metadata");
  });
  it("exposes no implicit context tools for zero packages", async () => {
    const f = fixture();
    expect(await new PackageContextDiscoverySource(new ScenarioPackageRegistry(), f.store, f.sqlite, () => null).discover()).toEqual([]);
  });
  it("uses the real HTTP Worker path and snapshots only selected text after an authorized read", async () => {
    const h = await foundationHost({ foundation: contextFoundation(), model: async (args) => {
      const c = JSON.parse(args.user); const results = c.transcript.filter((t: { kind: string }) => t.kind === "tool");
      if (results.length === 0) return { type: "invoke_tool", invocation: { id: "catalog", tool: "context.catalog", input: {}, rationale: "Discover summaries" } };
      if (results.length === 1) return { type: "invoke_tool", invocation: { id: "read", tool: "context.read", input: { id: "first", digest: contextContentDigest(contextText) }, rationale: "Load selected instructions" } };
      return { type: "complete", summary: "Read selected resource", outputs: [] };
    } }); cleanup.push(() => h.sqlite.open ? h.close() : undefined);
    await h.start(); await eventually(async () => (await h.state()).workItems[0]?.status === "completed");
    expect(h.requests).toHaveLength(3);
    expect(JSON.stringify(h.requests.slice(0, 2))).not.toContain(contextText);
    expect(JSON.stringify(h.requests[2])).toContain(contextText);
    expect(h.sqlite.prepare("SELECT count(*) AS n FROM worker_tool_receipts").get()).toEqual({ n: 2 });
    const snapshots = h.sqlite.prepare("SELECT request_json FROM scenario_cognitive_snapshots").all();
    expect(JSON.stringify(snapshots)).toContain(contextText);
  });
  it("restores an audited resource observation after a host restart without needing content reinstallation", async () => {
    const settings = contextFoundation();
    const first = await foundationHost({ foundation: settings, failResultCheckpoint: true, model: async () => ({ type: "invoke_tool",
      invocation: { id: "read", tool: "context.read", input: { id: "first", digest: contextContentDigest(contextText) }, rationale: "Read" } }) });
    cleanup.push(() => first.sqlite.open ? first.close() : undefined);
    await first.start(); await eventually(async () => (await first.state()).workItems[0]?.status === "failed");
    const before = await first.state(); await first.close(false);
    const next = await foundationHost({ root: first.root, foundation: { ...settings, contextResourceContents: [] },
      model: async () => ({ type: "complete", summary: "Restored observation", outputs: [] }) });
    cleanup.push(() => next.sqlite.open ? next.close() : undefined);
    await next.request("/api/scenarios/runs/run/work/work/continue", { commandId: "continue-context", actor: "test", reason: "Use confirmed read",
      expectedRevision: before.revision, checkpointRef: before.workItems[0].latestCheckpoint.payloadRef });
    await eventually(async () => (await next.state()).workItems[0]?.status === "completed");
    expect(next.requests).toHaveLength(1); expect(JSON.stringify(next.requests)).toContain(contextText);
    expect(next.sqlite.prepare("SELECT count(*) AS n FROM worker_tool_receipts").get()).toEqual({ n: 1 });
  });
});
