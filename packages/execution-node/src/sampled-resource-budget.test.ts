import { expect, it } from "vitest";
import { SampledResourceBudget } from "./sampled-resource-budget.js";
const limits = { cpuTimeMs: 100, memoryBytes: 1000, maximumProcesses: 2, writeBytes: 100 };
const sample = (identity = "pid:1:birth:1") => ({ identity, cpuTimeMs: 10, residentBytes: 100, writeBytes: 10 });
it("retains departed-process totals, counts PID reuse separately and latches an exceeded budget", () => {
  const budget = new SampledResourceBudget(limits);
  budget.observe(1, [{ ...sample(), cpuTimeMs: 80 }]);
  expect(budget.observe(2, [{ ...sample("pid:1:birth:2"), cpuTimeMs: 30 }])).toMatchObject({ cpuTimeMs: 110, processCount: 1, exceeded: "cpu_time" });
  expect(budget.observe(3, [])).toMatchObject({ cpuTimeMs: 110, residentBytes: 0, exceeded: "cpu_time" });
});
it.each(["memory", "process_count", "write_bytes"] as const)("detects %s budget", kind => {
  const values = kind === "memory" ? [{ ...sample(), residentBytes: 1001 }]
    : kind === "write_bytes" ? [{ ...sample(), writeBytes: 101 }]
    : [sample("a"), sample("b"), sample("c")];
  expect(new SampledResourceBudget(limits).observe(1, values).exceeded).toBe(kind);
});
it("rejects stale, duplicate and regressed measurements without mutating accepted state", () => {
  const budget = new SampledResourceBudget(limits); budget.observe(1, [sample()]);
  expect(() => budget.observe(1, [])).toThrow("Stale");
  expect(() => budget.observe(2, [sample(), sample()])).toThrow("identity");
  expect(() => budget.observe(2, [{ ...sample(), cpuTimeMs: 1 }])).toThrow("regressed");
  expect(budget.observe(2, [sample()]).cpuTimeMs).toBe(10);
});
it("bounds retained identities and rejects invalid budgets and counter values", () => {
  const budget = new SampledResourceBudget(limits, 1); budget.observe(1, [sample("a")]);
  expect(() => budget.observe(2, [sample("b")])).toThrow("history exhausted");
  expect(() => new SampledResourceBudget({ ...limits, memoryBytes: 0 })).toThrow("Invalid");
  expect(() => budget.observe(2, [{ ...sample("a"), residentBytes: NaN }])).toThrow("counter");
});
