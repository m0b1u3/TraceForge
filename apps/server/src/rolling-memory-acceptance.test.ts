import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runRollingMemoryAcceptance } from "./test-fixtures/rolling-memory-acceptance.js";

it("checks rolling quality, cache restart, withdrawal and window switching without real model calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "rolling-quality-"));
  try {
    const report = await runRollingMemoryAcceptance({ async extractJson(args) {
      const input = JSON.parse(args.user);
      const facts = (text: string) => Object.fromEntries(["failed", "pending", "limit"].map(prefix => [prefix === "limit" ? "limitation" : prefix, text.match(new RegExp(`${prefix}-[a-f0-9]{12}`))?.[0] ?? null]));
      if (input.entries) return { entries: input.entries.map((entry: { id: string; text: string }) => ({ id: entry.id, text: JSON.stringify(facts(entry.text)) })) };
      return facts(args.user);
    } }, { outputParent: root, mode: "simulated_harness_test", modelIdentity: { provider: "fixture", name: "extractive" } });
    expect(report, JSON.stringify(report)).toMatchObject({ status: "passed", checks: { multiMerge: true, incremental: true, restartCache: true, sourceChange: true, modelSwitch: true, originalsIntact: true } });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("does not label a plausible but lossy summary as a quality pass", async () => {
  const root = await mkdtemp(join(tmpdir(), "rolling-loss-"));
  try {
    const report = await runRollingMemoryAcceptance({ async extractJson(args) {
      return args.system.startsWith("Summarize") ? { entries: [{ id: "history", text: "Some progress was made." }] } : { failed: null, pending: null, limitation: null };
    } }, { outputParent: root, mode: "simulated_harness_test", modelIdentity: { provider: "fixture", name: "lossy" } });
    expect(report).toMatchObject({ status: "failed", failure: "key_fact_not_preserved" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("bounds a non-cooperating model and redacts its private error", async () => {
  const root = await mkdtemp(join(tmpdir(), "rolling-timeout-"));
  try {
    const report = await runRollingMemoryAcceptance({ extractJson: () => new Promise(() => {}) }, {
      outputParent: root, mode: "simulated_harness_test", modelIdentity: { provider: "fixture", name: "slow" }, modelCallTimeoutMs: 10,
    });
    expect(report).toMatchObject({ status: "failed", failure: "model_deadline" });
    expect(report.calls).toHaveLength(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
