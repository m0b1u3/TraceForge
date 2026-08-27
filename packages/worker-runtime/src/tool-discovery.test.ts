import { describe, expect, it } from "vitest";
import type { ExecutionToolAdapter } from "./tool-gateway.js";
import { ExecutionToolDiscoveryRuntime } from "./tool-discovery.js";

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
