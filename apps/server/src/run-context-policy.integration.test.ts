import { afterEach, describe, expect, it } from "vitest";
import { ScenarioPackageRegistry } from "@traceforge/scenario-sdk";
import { SqliteScenarioAuthorizationService } from "./scenario-authorization.js";
import { DurableScenarioRuntime, ScenarioDefinitionRegistry } from "@traceforge/orchestration-core";
import type { LlmProvider } from "@traceforge/llm";
import type { EvidenceGraphState } from "@traceforge/evidence-graph";
import { executionToolContractFingerprint, type ToolExecutionContext, type WorkerModelRequest } from "@traceforge/worker-runtime";
import {
  ContextCompactionRuntime,
  RunObserverSupervisor,
  RunPlannerSupervisor,
  StructuredRunObserverModel,
  StructuredRunPlannerModel,
} from "@traceforge/cognitive-runtime";
import { PackageContextDiscoverySource, SqlitePackageContextStore, contextContentDigest } from "./package-context-resources.js";
import { SqliteToolReceiptStore } from "./worker-execution-adapters.js";
import { RunContextPolicy } from "./run-context-policy.js";
import { SqliteContextCompactionStore } from "./context-compaction-store.js";
import { SqliteCognitiveSnapshotStore } from "./cognitive-context-snapshots.js";
import { SqliteRunObserverStore } from "./run-observer.js";
import { SqliteRunPlannerStore } from "./run-planner.js";
import { SqliteScenarioEventStore } from "./scenario-event-store.js";
import { SqliteEvidenceGraphStore } from "./evidence-graph-store.js";
import { contextBinding, contextPackage, contextText } from "./test-fixtures/context-package.js";
import { database, initialize, definition, at } from "./test-fixtures/execution-recovery.js";
import { foundationHost, eventually } from "./test-fixtures/foundation-host.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(shared = true) {
  const sqlite = database(); cleanup.push(() => { sqlite.close(); }); const controls = initialize(sqlite);
  const pkg = contextPackage(["observe"]); const resource = pkg.resourceManifest!.resources[0]!;
  resource.context!.requiredCapabilities = ["observe"];
  if (shared) resource.context!.readerRoles = ["worker", "planner", "observer"];
  const packages = new ScenarioPackageRegistry([pkg]), store = new SqlitePackageContextStore(sqlite);
  store.install(packages, [{ package: contextBinding, resourceId: "first", content: contextText }]);
  sqlite.prepare("INSERT INTO scenario_authorizations(id,case_id,scenario_kind,scope_json,status,approved_by,expires_at,created_at,updated_at) VALUES ('scope','case','neutral','{}','active','test','2099-01-01','2026-01-01','2026-01-01')").run();
  const run = controls.runtime.load("run")!;
  const source = new PackageContextDiscoverySource(packages, store, sqlite, () => controls.runtime.load("run")!);
  new SqliteScenarioAuthorizationService(sqlite,packages).pin("scope","case",packages.bindingFor(packages.list()[0]!),0);
  const context = { runId: "run", caseId: "case", workId: "work", workerId: "worker", scopeRef: "scope", leaseId: "lease",
    leaseExpiresAt: "2099-01-01", idempotencyKey: "effect:read", effectivePermissions: {} } as ToolExecutionContext;
  const tool = (await source.discover()).find((t) => t.name === "context.read")!;
  const receipt = await tool.execute({ id: "first", digest: resource.digest }, context);
  await controls.bindings.prepare({ idempotencyKey: "effect:read", invocationId: "read", inputFingerprint: "a".repeat(64),
    tool: { name: tool.name, source: tool.source, version: tool.version, contractFingerprint: executionToolContractFingerprint(tool) },
    attribution: { caseId: "case", runId: "run", workId: "work" } });
  await new SqliteToolReceiptStore(sqlite).put("effect:read", receipt); await controls.bindings.complete("effect:read");
  const snapshots = new SqliteCognitiveSnapshotStore(sqlite), policy = new RunContextPolicy(sqlite, source, (id) => controls.runtime.load(id) ?? null, snapshots);
  run.workItems[0]!.resultSummary = contextText;
  run.outputs = [{ id: "output", kind: "decision", schemaVersion: 1, summary: contextText, refs: ["output-ref"], producedByWorkId: "work", phaseId: "observe", createdAt: at }];
  const graph: EvidenceGraphState = { caseId: "case", revision: 0, nodes: [], edges: [], createdAt: at, updatedAt: at };
  const input = { run, graph, recentEvents: [{ type: "work_completed" as const, workId: "work", leaseId: "lease", summary: contextText, outputs: run.outputs, at }] };
  return { ...controls, pkg, packages, store, source, context, snapshots, policy, input };
}
function provider(evaluate: LlmProvider["extractJson"]): LlmProvider { return { extractJson: evaluate, async runTools() { throw new Error("No tools"); } }; }

describe("Cross-role context provenance", () => {
  it.each(["planner", "observer"] as const)("filters withdrawn %s summaries and events without mutating audit originals", async (role) => {
    const f = await fixture(); const before = JSON.stringify(f.input);
    expect(JSON.stringify(await f.policy.prepare(f.input, role))).toContain(contextText);
    f.store.revoke(contextContentDigest(contextText), "withdrawn");
    const projected = await f.policy.prepare(f.input, role);
    expect(JSON.stringify(projected)).not.toContain(contextText); expect(projected.run.workItems[0]!.id).toBe("work");
    expect(projected.manifest.contextLineage.withheldWorkIds).toEqual(["work"]); expect(projected.recentEvents).toEqual([]);
    expect(JSON.stringify(f.input)).toBe(before); expect((await new SqliteToolReceiptStore(f.sqlite).get("effect:read"))!.raw).toContain(contextText);
  });
  it("requires explicit role sharing rather than widening Worker resource permission", async () => {
    const f = await fixture(false);
    expect(JSON.stringify(await f.policy.prepare(f.input, "worker"))).toContain(contextText);
    expect(JSON.stringify(await f.policy.prepare(f.input, "planner"))).not.toContain(contextText);
    expect(JSON.stringify(await f.policy.prepare(f.input, "observer"))).not.toContain(contextText);
  });
  it.each(["scope", "metadata", "missing", "retired"])("fails closed for %s source changes", async (mode) => {
    const f = await fixture();
    if (mode === "scope") f.sqlite.prepare("UPDATE scenario_authorizations SET status='revoked'").run();
    if (mode === "metadata") f.pkg.resourceManifest!.resources[0]!.context!.summary = "changed";
    if (mode === "missing") f.sqlite.prepare("DELETE FROM package_context_content").run();
    if (mode === "retired") f.sqlite.prepare("INSERT INTO package_context_retired VALUES (?,?)").run(JSON.stringify([contextBinding.id, contextBinding.version, contextBinding.schemaRevision]), "first");
    expect(JSON.stringify(await f.policy.prepare(f.input, "observer"))).not.toContain(contextText);
  });
  it("records transitive Work/directive dependencies and rejects stale decisions", async () => {
    const f = await fixture(), projection = await f.policy.prepare(f.input, "observer");
    f.snapshots.prepare({ id: "observer-evaluation", consumer: "observer", runId: "run", caseId: "case", sourceRunRevision: f.input.run.revision,
      request: { system: "test", user: "test", schema: {} }, contextManifest: projection.manifest, at });
    await f.policy.recordDerivations("observer-evaluation", [{ kind: "work", id: "next" }, { kind: "directive", id: "steering" }]);
    f.input.run.workItems.push({ ...f.input.run.workItems[0]!, id: "next", title: contextText, objective: contextText });
    f.input.run.directives.push({ id: "steering", kind: "steer", targetWorkId: "next", instruction: contextText, rationale: contextText, issuedBy: "observer", createdAt: at });
    f.store.revoke(contextContentDigest(contextText), "withdrawn");
    const next = new RunContextPolicy(f.sqlite, f.source, () => f.input.run, f.snapshots);
    const projected = await next.prepare(f.input, "planner");
    expect(JSON.stringify(projected)).not.toContain(contextText);
    expect(projected.manifest.contextLineage.withheldWorkIds).toContain("next"); expect(projected.run.directives).toEqual([]);
    await expect(next.assertSnapshotCurrent("observer-evaluation")).rejects.toThrow("changed");
    expect(() => next.assertReplayAllowed(f.snapshots.get("observer-evaluation")!)).toThrow("projection");
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM context_derivations").get()).toEqual({ n: 2 });
  });
  it.each(["revoked", "capability"])("withholds inherited Worker instructions on %s without borrowing the source Work's authority", async (mode) => {
    const f = await fixture(), projection = await f.policy.prepare(f.input, "planner");
    f.snapshots.prepare({ id: "derived", consumer: "planner", runId: "run", caseId: "case", sourceRunRevision: f.input.run.revision,
      request: { system: "test", user: "test", schema: {} }, contextManifest: projection.manifest, at });
    await f.policy.recordDerivations("derived", [{ kind: "work", id: "next" }, { kind: "directive", id: "steering" }]);
    const work = { ...f.input.run.workItems[0]!, id: "next", title: contextText, objective: contextText,
      requiredCapabilities: mode === "capability" ? [] : ["observe"] };
    f.input.run.workItems.push(work);
    const directive = { id: "steering", kind: "steer" as const, targetWorkId: "next", instruction: contextText, rationale: contextText, issuedBy: "observer" as const, createdAt: at };
    f.input.run.directives.push(directive);
    const source = new PackageContextDiscoverySource(f.packages, f.store, f.sqlite, () => f.input.run);
    const policy = new RunContextPolicy(f.sqlite, source, () => f.input.run, f.snapshots);
    if (mode === "revoked") f.store.revoke(contextContentDigest(contextText), "withdrawn");
    const request: WorkerModelRequest = { turnId: "worker-derived", worker: { id: "worker", roles: ["observer"], capabilities: ["observe"], maxConcurrentWork: 1, status: "online", heartbeatAt: at },
      assignment: { runId: "run", leaseId: "lease", leaseExpiresAt: "2099-01-01", runRevision: f.input.run.revision, work,
        runContext: { caseId: "case", goal: "Observe", scopeRef: "scope", activePhaseId: "observe", directives: [directive] } },
      transcript: [], steering: [contextText], tools: [], toolResolution: { requestedCapabilities: [], unresolvedCapabilities: [], registryRevision: 1 } };
    const before = JSON.stringify(request), result = await policy.projectWorker(request);
    expect(JSON.stringify(result.request)).not.toContain(contextText);
    expect(result.request.assignment.work.id).toBe("next"); expect(result.request.assignment.runContext.directives).toEqual([]);
    expect(JSON.stringify(request)).toBe(before);
  });
  it.each(["planner", "observer"] as const)("guards %s input and rejects a result if sources change during inference", async (role) => {
    const f = await fixture(); const p = provider(async (args) => {
      expect(args.user).toContain(contextText); f.store.revoke(contextContentDigest(contextText), "during inference");
      return role === "planner" ? { action: "wait", rationale: "wait" } : { action: "continue", rationale: "wait" };
    });
    const model = role === "planner" ? new StructuredRunPlannerModel(p, undefined, f.snapshots, undefined, undefined, f.policy)
      : new StructuredRunObserverModel(p, undefined, f.snapshots, undefined, undefined, f.policy);
    await expect(model.evaluate({ ...f.input, contextId: role, definition, maximumGraphNodes: 10, maximumRunItems: 10 })).rejects.toThrow("changed");
    expect(f.snapshots.get(role)?.status).toBe("failed");
  });
  it("reevaluates Observer on a resource-only change at the same Run/Graph revision", async () => {
    const f = await fixture(); let calls = 0;
    const d = { ...definition, agentTopology: { ...definition.agentTopology, observer: { ...definition.agentTopology.observer, enabled: true } } };
    const store = new SqliteRunObserverStore(f.sqlite);
    const model = new StructuredRunObserverModel(provider(async () => { calls++; return { action: "continue", rationale: "wait" }; }), undefined, f.snapshots, undefined, undefined, f.policy);
    const supervisor = new RunObserverSupervisor(f.runtime, new ScenarioDefinitionRegistry([d]), new SqliteScenarioEventStore(f.sqlite),
      new SqliteEvidenceGraphStore(f.sqlite), store, model, undefined, () => `observer-${calls}`, undefined, undefined, undefined, f.policy);
    await supervisor.tick(); await supervisor.tick(); expect(calls).toBe(1);
    const revision = f.runtime.load("run")!.revision;
    f.store.revoke(contextContentDigest(contextText), "withdrawn"); await supervisor.tick(); await supervisor.tick();
    expect(calls).toBe(2); expect(f.runtime.load("run")!.revision).toBe(revision); expect(store.list("run")).toHaveLength(2);
  });
  it("persists Planner-proposed Work provenance before applying it", async () => {
    const f = await fixture(); let calls = 0;
    const d = { ...definition, agentTopology: { ...definition.agentTopology, planner: { ...definition.agentTopology.planner, enabled: true } } };
    const model = new StructuredRunPlannerModel(provider(async () => { calls++; return calls === 1 ? { action: "plan", rationale: "plan", proposals: [{
      kind: "observe", title: "Second candidate", objective: "Observe independently", priority: 50, requiredCapabilities: ["observe"], hypothesisIds: [], evidenceRefs: [], maxAttempts: 1 }], cancellations: [], reprioritizations: [] }
      : { action: "wait", rationale: "wait" }; }), undefined, f.snapshots, undefined, undefined, f.policy);
    const supervisor = new RunPlannerSupervisor(f.runtime, new ScenarioDefinitionRegistry([d]), new SqliteScenarioEventStore(f.sqlite), new SqliteEvidenceGraphStore(f.sqlite),
      new SqliteRunPlannerStore(f.sqlite), model, 4, () => `planner-${calls}`, undefined, undefined, f.policy);
    await supervisor.tick(); expect(f.runtime.load("run")!.workItems).toHaveLength(2);
    expect(f.sqlite.prepare("SELECT target_id FROM context_derivations").get()).toEqual({ target_id: "planner-work-planner-0-0" });
    f.store.revoke(contextContentDigest(contextText), "withdrawn"); await supervisor.tick(); expect(calls).toBe(2);
  });
  it("filters structurally sourced graph nodes and their dependents, leaving the graph untouched", async () => {
    const f = await fixture(); const first = { id: "node-first", caseId: "case", runId: "run", kind: "fact" as const,
      title: contextText, summary: contextText, status: "active" as const, confidence: 0.5, properties: { detail: contextText },
      source: { type: "tool_result" as const, ref: "effect:read", observedAt: at, producerId: "worker" }, version: 1,
      createdAt: at, updatedAt: at, invalidatedAt: null, invalidationReason: null };
    f.input.graph.nodes.push(first, { ...first, id: "node-second", source: null }, { ...first, id: "foreign", runId: "other" });
    f.input.graph.edges.push({ id: "edge", caseId: "case", sourceId: "node-second", targetId: "node-first", relation: "derived_from", rationale: contextText, createdAt: at });
    const before = JSON.stringify(f.input.graph); f.store.revoke(contextContentDigest(contextText), "withdrawn");
    const result = await f.policy.prepare(f.input, "observer");
    expect(JSON.stringify(result.graph)).not.toContain(contextText);
    expect(result.graph.nodes.map((n) => n.id)).toEqual(["node-first", "node-second"]);
    expect(result.manifest.contextLineage.withheldNodeIds.sort()).toEqual(["node-first", "node-second"]);
    expect(JSON.stringify(f.input.graph)).toBe(before);
  });
  it("rejects cross-Case context rather than filtering an unrelated graph", async () => {
    const f = await fixture(); f.input.graph.caseId = "other";
    await expect(f.policy.prepare(f.input, "observer")).rejects.toThrow("Case");
  });
  it("carries HTTP Worker results into governed Observer compaction and filters after full restart", async () => {
    const pkg = contextPackage(["context.read"]); pkg.resourceManifest!.resources[0]!.context!.readerRoles = ["worker", "planner", "observer"];
    const packages = new ScenarioPackageRegistry([pkg]);
    const foundation = { scenarioPackageRegistry: packages, toolDiscoverySources: [], contextResourceContents: [{ package: contextBinding, resourceId: "first", content: contextText }] };
    const first = await foundationHost({ foundation, model: async (args) => JSON.parse(args.user).transcript.some((t: any) => t.kind === "tool")
      ? { type: "complete", summary: contextText.repeat(250), outputs: [] } : { type: "invoke_tool", invocation: { id: "read", tool: "context.read",
        input: { id: "first", digest: contextContentDigest(contextText) }, rationale: "Read" } } });
    cleanup.push(() => first.sqlite.open ? first.close() : undefined);
    await first.start(); await eventually(async () => (await first.state()).workItems[0]?.status === "completed");
    const assemble = (h: typeof first) => {
      const load = (id: string) => new DurableScenarioRuntime(new SqliteScenarioEventStore(h.sqlite), new ScenarioDefinitionRegistry(packages.definitions()), packages).load(id) ?? null;
      const snapshots = new SqliteCognitiveSnapshotStore(h.sqlite), source = new PackageContextDiscoverySource(packages, new SqlitePackageContextStore(h.sqlite), h.sqlite, load);
      return { snapshots, policy: new RunContextPolicy(h.sqlite, source, load, snapshots), compaction: new ContextCompactionRuntime(new SqliteContextCompactionStore(h.sqlite)) };
    };
    const a = assemble(first); let observed = "";
    const model = new StructuredRunObserverModel(provider(async (args) => { observed = args.user; return { action: "continue", rationale: "Observed bounded context" }; }), undefined,
      a.snapshots, undefined, undefined, a.policy, a.compaction);
    const graph: EvidenceGraphState = { caseId: "case", revision: 0, nodes: [], edges: [], createdAt: at, updatedAt: at };
    await model.evaluate({ run: await first.state(), graph, recentEvents: [], contextId: "http-observer-before", maximumGraphNodes: 1, maximumRunItems: 1 });
    expect(observed).toContain("compactedText"); expect(observed).toContain("effect:read");
    expect(a.snapshots.get("http-observer-before")!.contextManifest.contextCompaction).toMatchObject({ status: "completed" });
    await first.close(false);
    const next = await foundationHost({ root: first.root, ready: () => false, foundation: { ...foundation, contextResourceContents: [],
      revokedContextResources: [{ digest: contextContentDigest(contextText), reason: "withdrawn between hosts" }] } });
    cleanup.push(() => next.close()); const b = assemble(next);
    const after = new StructuredRunObserverModel(provider(async (args) => { expect(args.user).not.toContain(contextText); return { action: "continue", rationale: "Reassessed" }; }),
      undefined, b.snapshots, undefined, undefined, b.policy, b.compaction);
    await after.evaluate({ run: await next.state(), graph, recentEvents: [], contextId: "http-observer-after", maximumGraphNodes: 1, maximumRunItems: 1 });
    expect(b.snapshots.get("http-observer-before")!.contextManifest.contextCompaction).toMatchObject({ status: "completed" });
    await expect(next.request("/api/scenarios/cognitive-snapshot-replays", { snapshotId: "http-observer-before" })).rejects.toThrow("409");
    expect(next.sqlite.prepare("SELECT count(*) AS n FROM worker_tool_receipts").get()).toEqual({ n: 1 });
  });
});

describe("Persistent bounded compaction", () => {
  it("recovers interrupted preparation and keeps immutable completed summaries", async () => {
    const f = await fixture(), store = new SqliteContextCompactionStore(f.sqlite);
    store.prepare({ id: "interrupted", caseId: "case", runId: "run", consumer: "observer", inputFingerprint: "input", protectedFingerprint: "protected",
      sourceFingerprint: "sources", compactorVersion: "test", status: "prepared", entries: null, error: null, sourceIds: [] });
    expect(new SqliteContextCompactionStore(f.sqlite).recoverPrepared()).toBe(1); expect(store.get("interrupted")?.status).toBe("failed");
    const input = { caseId: "case", runId: "run", consumer: "worker", sourceFingerprint: "sources", context: { transcript: [{ receiptKey: "receipt", summary: "long text ".repeat(4000) }] } };
    const result = await new ContextCompactionRuntime(store).prepare(input);
    expect(result.manifest.contextCompaction).toMatchObject({ status: "completed" });
    expect((await new ContextCompactionRuntime(new SqliteContextCompactionStore(f.sqlite)).prepare(input)).manifest.contextCompaction).toMatchObject({ replayed: true });
    expect(() => f.sqlite.prepare("DELETE FROM context_compactions").run()).toThrow("cannot be deleted");
  });
});
