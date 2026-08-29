import { describe, expect, it } from "vitest";
import type { ExecutionToolAdapter } from "./tool-gateway.js";
import { ExecutionToolDiscoveryRuntime } from "./tool-discovery.js";
import {
  executionToolCatalogFingerprint,
  type ExecutionToolDiscoverySnapshot,
  type ExecutionToolDiscoveryStatePort,
} from "./tool-discovery-state.js";

class MemoryDiscoveryState implements ExecutionToolDiscoveryStatePort {
  readonly snapshots = new Map<string, ExecutionToolDiscoverySnapshot>();
  async load(source: string) { return this.snapshots.get(source); }
  async save(snapshot: ExecutionToolDiscoverySnapshot) { this.snapshots.set(snapshot.source, structuredClone(snapshot)); }
}

function historicalSnapshot(): ExecutionToolDiscoverySnapshot {
  const lastSuccessfulCatalog = [tool("first", "external")].map(({ execute: _execute, ...spec }) => spec);
  return {
    schemaVersion: 1, source: "external", revision: 4, outcome: "ready",
    lastAttemptAt: "2026-08-29T02:00:00.000Z", lastSuccessAt: "2026-08-29T02:00:01.000Z",
    lastFailure: null, lastSuccessfulCatalog,
    catalogFingerprint: executionToolCatalogFingerprint(lastSuccessfulCatalog), updatedAt: "2026-08-29T02:00:01.000Z",
  };
}

function tool(name: string, source: string, version = "1.0.0"): ExecutionToolAdapter {
  return {
    name, source, version, priority: 100, description: name, inputSchema: {},
    providedCapabilities: [`cap.${name}`], dependencyCapabilities: [], permissionRequirements: {}, risk: "read_only", timeoutMs: 1_000,
    async execute() { return { status: "succeeded", summary: "done", raw: "", refs: [], retryable: false }; },
  };
}

describe("ExecutionToolDiscoveryRuntime", () => {
  it("reports initialization before the first source refresh", () => {
    const runtime = new ExecutionToolDiscoveryRuntime([{ source: "external", async discover() { return []; } }]);
    expect(runtime.snapshot()).toMatchObject({ status: "initializing", sources: [{ status: "pending" }] });
  });

  it("restores historical discovery metadata without making the old catalog executable", async () => {
    const state = new MemoryDiscoveryState();
    state.snapshots.set("external", historicalSnapshot());
    const runtime = new ExecutionToolDiscoveryRuntime(
      [{ source: "external", async discover() { return [tool("fresh", "external")]; } }],
      30_000, 3, () => new Date("2026-08-29T03:00:00.000Z"), state,
    );
    await runtime.restore();
    expect(runtime.registry.list()).toEqual([]);
    expect(runtime.snapshot()).toMatchObject({
      status: "initializing",
      sources: [{
        status: "pending", discoveredProviders: 1, discoveryRevision: 4,
        lastSuccessfulCatalogFingerprint: historicalSnapshot().catalogFingerprint,
        restoredFromPersistence: true,
      }],
    });
    await runtime.refresh();
    expect(runtime.registry.get("fresh")).toMatchObject({ lifecycle: "active" });
    expect(state.snapshots.get("external")).toMatchObject({ revision: 5, outcome: "ready" });
  });

  it("continues the persisted revision when a managed source appears during startup recovery", async () => {
    const state = new MemoryDiscoveryState();
    const historical = historicalSnapshot();
    state.snapshots.set("managed", { ...historical, source: "managed", lastSuccessfulCatalog: [], catalogFingerprint: null });
    const runtime = new ExecutionToolDiscoveryRuntime([], 30_000, 3, () => new Date("2026-08-29T03:00:00.000Z"), state);
    await runtime.restore();
    await runtime.activateSource({ source: "managed", async discover() { return [tool("fresh", "managed")]; } });
    expect(state.snapshots.get("managed")).toMatchObject({ revision: 5, outcome: "ready" });
    expect(runtime.registry.get("fresh")).toMatchObject({ lifecycle: "active" });
  });

  it("retains the historical catalog when the first post-restart discovery fails", async () => {
    const state = new MemoryDiscoveryState();
    state.snapshots.set("external", historicalSnapshot());
    const runtime = new ExecutionToolDiscoveryRuntime([{
      source: "external", async discover() { throw new Error("source unavailable after restart"); },
    }], 0, 3, () => new Date("2026-08-29T03:00:00.000Z"), state);
    await runtime.restore();
    await runtime.refresh();
    expect(runtime.registry.list()).toEqual([]);
    expect(state.snapshots.get("external")).toMatchObject({
      revision: 5, outcome: "degraded", lastSuccessfulCatalog: [{ name: "first" }],
      lastFailure: { message: "source unavailable after restart" },
    });
  });

  it("persists a bounded failure while retaining the last successful catalog", async () => {
    const state = new MemoryDiscoveryState();
    let fail = false;
    const runtime = new ExecutionToolDiscoveryRuntime([{
      source: "external",
      async discover() { if (fail) throw new Error("x".repeat(2_000)); return [tool("first", "external")]; },
    }], 0, 3, () => new Date("2026-08-29T03:00:00.000Z"), state);
    await runtime.refresh();
    fail = true;
    await runtime.refresh();
    const persisted = state.snapshots.get("external")!;
    expect(persisted).toMatchObject({ revision: 2, outcome: "degraded", lastSuccessfulCatalog: [{ name: "first" }] });
    expect(persisted.lastFailure?.message).toHaveLength(1_024);
    expect(runtime.registry.get("first")).toMatchObject({ lifecycle: "active" });
  });

  it("rolls back a newly discovered catalog when durable state cannot commit", async () => {
    let saves = 0;
    const state: ExecutionToolDiscoveryStatePort = {
      async load() { return undefined; },
      async save() { saves += 1; if (saves >= 2) throw new Error("state store unavailable"); },
    };
    let providers = [tool("first", "external")];
    const runtime = new ExecutionToolDiscoveryRuntime([{
      source: "external", async discover() { return providers; },
    }], 0, 3, () => new Date("2026-08-29T03:00:00.000Z"), state);
    await runtime.refresh();
    providers = [tool("second", "external")];
    await runtime.refresh();
    expect(runtime.registry.get("first")).toMatchObject({ lifecycle: "active" });
    expect(runtime.registry.get("second")).toMatchObject({ lifecycle: "draining" });
    expect(runtime.snapshot()).toMatchObject({ status: "degraded", sources: [{ lastError: expect.stringContaining("persistence failed") }] });
  });

  it("refreshes due sources and coalesces concurrent discovery", async () => {
    let calls = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const runtime = new ExecutionToolDiscoveryRuntime([{
      source: "external",
      async discover() { calls += 1; await blocked; return [tool("first", "external")]; },
    }], 30_000, 3, () => new Date("2026-08-27T08:00:00.000Z"));
    const first = runtime.refreshDue();
    const second = runtime.refreshDue();
    release();
    await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect(runtime.snapshot()).toMatchObject({
      status: "ready",
      sources: [{ source: "external", status: "ready", discoveredProviders: 1 }],
      providers: [{ tool: { name: "first", source: "external" }, lifecycle: "active", health: "healthy" }],
    });
  });

  it("keeps the last good catalog when a later discovery fails", async () => {
    let fail = false;
    const runtime = new ExecutionToolDiscoveryRuntime([{
      source: "external",
      async discover() { if (fail) throw new Error("provider endpoint unavailable"); return [tool("first", "external")]; },
    }], 0);
    await runtime.refresh();
    fail = true;
    await expect(runtime.refresh()).resolves.toBeUndefined();
    expect(runtime.registry.get("first")).toMatchObject({ lifecycle: "active" });
    expect(runtime.snapshot()).toMatchObject({
      status: "degraded",
      sources: [{ status: "degraded", lastError: "provider endpoint unavailable", discoveredProviders: 1 }],
    });
  });

  it("drains disappeared tools and activates a new version", async () => {
    let tools = [tool("first", "external"), tool("removed", "external")];
    const runtime = new ExecutionToolDiscoveryRuntime([{ source: "external", async discover() { return tools; } }], 0);
    await runtime.refresh();
    tools = [tool("first", "external", "2.0.0")];
    await runtime.refresh();
    expect(runtime.registry.get("first")).toMatchObject({ lifecycle: "active", provider: { version: "2.0.0" } });
    expect(runtime.registry.get("removed")).toMatchObject({ lifecycle: "draining" });
  });

  it("replaces and deactivates managed discovery sources without leaving tools eligible", async () => {
    const closed: string[] = [];
    const first = {
      source: "managed",
      async discover() { return [tool("candidate", "managed")]; },
      async close() { closed.push("first"); },
    };
    const second = {
      source: "managed",
      async discover() { return [tool("candidate", "managed", "2.0.0")]; },
      async close() { closed.push("second"); },
    };
    const runtime = new ExecutionToolDiscoveryRuntime([first]);
    await runtime.refresh();
    const activation = await runtime.activateSource(second);
    await activation.drained;
    expect(closed).toEqual(["first"]);
    expect(runtime.registry.get("candidate")).toMatchObject({ lifecycle: "active", provider: { version: "2.0.0" } });

    await runtime.deactivateSource("managed");
    expect(closed).toEqual(["first", "second"]);
    expect(runtime.hasSource("managed")).toBe(false);
    expect(runtime.registry.resolve(["cap.candidate"]).providers).toEqual([]);
    expect(runtime.registry.get("candidate")).toMatchObject({ lifecycle: "draining" });
  });

  it("publishes a new generation before waiting for old in-flight calls to drain", async () => {
    const closed: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const firstTool = tool("candidate", "managed");
    firstTool.execute = async () => {
      await blocked;
      return { status: "succeeded", summary: "old completed", raw: "", refs: [], retryable: false };
    };
    const first = {
      source: "managed",
      async discover() { return [firstTool]; },
      async close() { closed.push("first"); },
    };
    const second = {
      source: "managed",
      async discover() { return [tool("candidate", "managed", "2.0.0")]; },
    };
    const runtime = new ExecutionToolDiscoveryRuntime([first]);
    await runtime.refresh();
    const oldAdapter = runtime.registry.get("candidate")!.provider;
    const oldCall = oldAdapter.execute({}, {} as never);

    const activation = await runtime.activateSource(second);
    expect(runtime.registry.get("candidate")).toMatchObject({ lifecycle: "active", provider: { version: "2.0.0" } });
    expect(closed).toEqual([]);
    await expect(oldAdapter.execute({}, {} as never)).rejects.toMatchObject({ retryable: true });

    release();
    await expect(oldCall).resolves.toMatchObject({ summary: "old completed" });
    await activation.drained;
    expect(closed).toEqual(["first"]);
  });

  it("does not reactivate a manually draining source during periodic refresh", async () => {
    const runtime = new ExecutionToolDiscoveryRuntime([{
      source: "managed",
      async discover() { return [tool("candidate", "managed")]; },
    }], 0);
    await runtime.refresh();
    runtime.drainSource("managed");
    await runtime.refreshDue();
    expect(runtime.registry.get("candidate")).toMatchObject({ lifecycle: "draining" });
    expect(runtime.registry.resolve(["cap.candidate"]).providers).toEqual([]);
    expect(runtime.snapshot().sources).toMatchObject([{ acceptingInvocations: false, inFlightInvocations: 0 }]);
  });

  it("rebinds a fresh implementation when a drained source is re-enabled at the same version", async () => {
    const first = tool("candidate", "managed");
    const second = tool("candidate", "managed");
    second.execute = async () => ({ status: "succeeded", summary: "fresh implementation", raw: "", refs: [], retryable: false });
    const runtime = new ExecutionToolDiscoveryRuntime([{
      source: "managed",
      async discover() { return [first]; },
    }]);
    await runtime.refresh();
    runtime.drainSource("managed");
    const activation = await runtime.activateSource({
      source: "managed",
      async discover() { return [second]; },
    });
    await activation.drained;
    const active = runtime.registry.get("candidate")!.provider;
    await expect(active.execute({}, {} as never)).resolves.toMatchObject({ summary: "fresh implementation" });
  });

  it("restores the current generation when replacement catalog commit is rejected", async () => {
    const runtime = new ExecutionToolDiscoveryRuntime([{
      source: "managed",
      async discover() { return [tool("candidate", "managed")]; },
    }]);
    await runtime.refresh();
    await expect(runtime.activateSource({
      source: "managed",
      async discover() { return [tool("duplicate", "managed", "2.0.0"), tool("duplicate", "managed", "2.0.0")]; },
    })).rejects.toThrow(/duplicate name/);
    expect(runtime.registry.get("candidate")).toMatchObject({ lifecycle: "active", provider: { version: "1.0.0" } });
    await expect(runtime.registry.get("candidate")!.provider.execute({}, {} as never)).resolves.toMatchObject({ status: "succeeded" });
  });
});
