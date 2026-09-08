import { expect, it, vi } from "vitest";
import { ResourceBudgetSupervisor } from "./resource-budget-supervisor.js";
const limits = { cpuTimeMs: 100, memoryBytes: 1000, maximumProcesses: 2, writeBytes: 100 };
it("terminates on budget and reports confirmation only after the cleanup barrier", async () => {
  const cleanup = vi.fn(async () => {});
  const supervisor = new ResourceBudgetSupervisor(limits, { now: () => 1,
    sample: async () => [{ identity: "birth", cpuTimeMs: 101, residentBytes: 0, writeBytes: 0 }], terminateAndConfirm: cleanup });
  expect(await supervisor.run(new AbortController().signal)).toMatchObject({ reason: "budget", cleanupConfirmed: true, decision: { exceeded: "cpu_time" } });
  expect(cleanup).toHaveBeenCalledOnce();
  await expect(supervisor.run(new AbortController().signal)).rejects.toThrow("single-use");
});
it("sampling failure and hanging cleanup retain an unknown result", async () => {
  const supervisor = new ResourceBudgetSupervisor(limits, { now: () => 1, sample: async () => { throw Error("native failure"); },
    terminateAndConfirm: async () => new Promise(() => {}) }, 1, 20);
  expect(await supervisor.run(new AbortController().signal)).toEqual({ reason: "sampling_failed", cleanupConfirmed: false });
});
it("cancels an in-flight sampler and runs cleanup with a fresh signal", async () => {
  const abort = new AbortController();
  const supervisor = new ResourceBudgetSupervisor(limits, { now: () => 1,
    sample: async () => { abort.abort(); return new Promise(() => {}); },
    terminateAndConfirm: async signal => { expect(signal.aborted).toBe(false); } }, 1, 20);
  expect(await supervisor.run(abort.signal)).toEqual({ reason: "cancelled", cleanupConfirmed: true });
});
it("bounds a stalled native sampler rather than treating silence as zero consumption", async () => {
  const supervisor = new ResourceBudgetSupervisor(limits, { now: () => 1, sample: async () => new Promise(() => {}), terminateAndConfirm: async () => {} }, 1, 20);
  expect(await supervisor.run(new AbortController().signal)).toEqual({ reason: "sampling_failed", cleanupConfirmed: true });
});
