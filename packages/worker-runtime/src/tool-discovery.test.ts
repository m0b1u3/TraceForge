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
});
