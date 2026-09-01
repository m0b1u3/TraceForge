import { afterEach, describe, expect, it } from "vitest";
import type { ToolExecutionResult } from "@traceforge/worker-runtime";
import { foundationHost, eventually, type FoundationHost } from "./test-fixtures/foundation-host.js";

const hosts: FoundationHost[] = [];
afterEach(async () => { for (const h of hosts.splice(0).reverse()) if (h.sqlite.open) await h.close(); });

describe("Foundation cancellation ownership", () => {
  it.each(["cancel", "pause", "revoke"])("propagates HTTP %s into an in-flight tool without committing its late result", async (action) => {
    let signal: AbortSignal | undefined, calls = 0, release!: (value: ToolExecutionResult) => void;
    const h = await foundationHost({ foundation: { toolDiscoverySources: [{ source: "fixture.host", async discover() { return [{
      name: "fixture.read", source: "fixture.host", version: "1", priority: 1, description: "Observe", inputSchema: {},
      providedCapabilities: ["fixture.read"], dependencyCapabilities: [], permissionRequirements: {}, risk: "read_only", timeoutMs: 60000,
      execute(_input, context) { calls++; signal = context.signal; return new Promise<ToolExecutionResult>((resolve) => { release = resolve; }); },
    }]; } }] } }); hosts.push(h);
    await h.start(); await eventually(async () => calls === 1);
    const state = await h.state();
    if (action === "revoke") await h.request("/api/scenarios/authorizations/run%3Ascope/revoke", {});
    else await h.request(`/api/scenarios/runs/run/${action}`, { commandId: `operator-${action}`, expectedRevision: state.revision, reason: "Operator requested stop" });
    await eventually(async () => signal?.aborted === true);
    await eventually(async () => (h.sqlite.prepare("SELECT status FROM tool_invocation_executions").get() as { status: string })?.status === "uncertain");
    release({ status: "succeeded", summary: "Late observation", raw: "late", refs: [], retryable: false });
    await eventually(async () => (await h.request("/api/security-tools/runtime")).sources.every((s: { inFlightInvocations: number }) => s.inFlightInvocations === 0));
    expect((await h.state()).status).toBe(action === "pause" ? "paused" : "cancelled");
    expect(h.sqlite.prepare("SELECT count(*) AS n FROM worker_tool_receipts").get()).toEqual({ n: 0 }); expect(calls).toBe(1);
    await h.close(false);
    const restarted = await foundationHost({ root: h.root, ready: () => false }); hosts.push(restarted);
    expect(restarted.sqlite.prepare("SELECT status FROM tool_invocation_executions").get()).toEqual({ status: "uncertain" });
    expect(restarted.calls()).toBe(0);
  });
  it("cancels a noncooperative model via HTTP without applying its late completion", async () => {
    let signal: AbortSignal | undefined, release!: (value: unknown) => void;
    const h = await foundationHost({ modelTimeoutMs: 60000, model: async (args) => { signal = args.signal; return new Promise((resolve) => { release = resolve; }); } }); hosts.push(h);
    await h.start(); await eventually(async () => !!signal);
    const state = await h.state(); await h.request("/api/scenarios/runs/run/cancel", { commandId: "stop", expectedRevision: state.revision, reason: "Operator stopped" });
    await eventually(async () => signal!.aborted);
    release({ type: "complete", summary: "Late completion", outputs: [] });
    await eventually(async () => (h.sqlite.prepare("SELECT count(*) AS n FROM scenario_model_calls WHERE status='running'").get() as { n: number }).n === 0);
    expect((await h.state()).status).toBe("cancelled"); expect(h.calls()).toBe(0);
  });
});
