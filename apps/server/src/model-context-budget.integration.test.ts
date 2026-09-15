import { expect, it } from "vitest";
import { foundationHost, eventually } from "./test-fixtures/foundation-host.js";

it("uses a real route's input budget instead of mixing incompatible window and output maxima", async () => {
  const budgets: unknown[] = [];
  const host = await foundationHost({
    contextLimits: { contextWindowTokens: 16000, maxOutputTokens: 512 },
    foundation: { modelRoutes: new Map([["large", {
      contextLimits: { contextWindowTokens: 128000, maxOutputTokens: 32768 },
      async extractJson() { throw new Error("Unneeded fallback must not run"); },
      async runTools() { throw new Error("No effect path"); },
    }]]), modelPolicies: { worker: { routeIds: ["primary", "large"], maximumAttemptsPerRoute: 1 } } },
    model: async request => {
      const context = JSON.parse(request.user);
      expect(context.manifest.contextCompaction.timeoutMs).toBe(120000);
      budgets.push(context.manifest.contextCompaction.budget);
      return context.transcript.some((entry: { kind: string }) => entry.kind === "tool") ? { type: "complete", summary: "Observation preserved", outputs: [] }
        : { type: "invoke_tool", invocation: { id: "read", tool: "fixture.read", input: { candidate: "first" }, rationale: "Read assigned item" } };
    },
  });
  try {
    await host.start();
    await eventually(async () => (await host.state()).workItems[0]?.status === "completed", 10000);
    expect(host.calls()).toBe(1);
    expect(budgets).toHaveLength(2);
    expect(budgets[0]).toMatchObject({ window: 16000, output: 512, input: 14688, source: "configured" });
  } finally { await host.close(); }
});
