import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runDesktopMemoryAcceptance } from "./test-fixtures/desktop-memory-acceptance.js";
it.each([0, 24])("exercises production summary, original lookup and restart with %s additional rounds", async continuationRounds => {
  const root = await mkdtemp(join(tmpdir(), "desktop-model-memory-"));
  try {
    const report = await runDesktopMemoryAcceptance({
      async extractJson(args) { return { entries: JSON.parse(args.user).entries.map((entry: any) => ({ id: entry.id, text: "Earlier discussion remains in originals." })) }; },
      async runTools() { throw new Error("No execution path"); },
      async streamTools(args, handlers) {
        if (args.messages.at(-1)?.role !== "tool") return { text: "", done: false, toolCalls: [{ id: "read", name: "conversation_read", input: { id: "early" } }, { id: "current", name: "conversation_read", input: { id: "correction" } }] };
        const text = JSON.stringify(args.messages).match(/reference-[a-f0-9]{12}/)?.[0] + " " + (JSON.stringify(args.messages).match(/latest-[a-f0-9]{12}/)?.[0] ?? "");
        handlers.onTextDelta?.(text); return { text, done: true, toolCalls: [] };
      },
    }, { outputParent: root, mode: "simulated_harness_test", modelIdentity: { provider: "fixture", name: "neutral" }, continuationRounds });
    expect(report.continuationRoundsCompleted).toBe(continuationRounds);
    expect(report, JSON.stringify(report)).toMatchObject({ status: "passed", checks: { firstSummary: true, originalRecall: true, restartNoReplay: true, secondSummary: true, userCorrection: true } });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("does not pass endurance on correct remembered answers without the requested fresh reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-model-memory-negative-"));
  let known = "";
  try {
    const report = await runDesktopMemoryAcceptance({
      async extractJson(args) { return { entries: JSON.parse(args.user).entries.map((entry: any) => ({ id: entry.id, text: "Earlier records remain in originals." })) }; },
      async runTools() { throw new Error("No execution path"); },
      async streamTools(args, handlers) {
        const last = args.messages.at(-1)!;
        if (last.role !== "tool" && !last.content.startsWith("Use conversation_read to read original message early and correction now."))
          return { text: "", done: false, toolCalls: [{ id: "read", name: "conversation_read", input: { id: "early" } }, { id: "current", name: "conversation_read", input: { id: "correction" } }] };
        if (last.role === "tool") known = (JSON.stringify(args.messages).match(/reference-[a-f0-9]{12}/)?.[0] ?? "") + " " + (JSON.stringify(args.messages).match(/latest-[a-f0-9]{12}/)?.[0] ?? "");
        handlers.onTextDelta?.(known); return { text: known, done: true, toolCalls: [] };
      },
    }, { outputParent: root, mode: "simulated_harness_test", modelIdentity: { provider: "fixture", name: "neutral" }, continuationRounds: 2 });
    expect(report.continuationRoundsCompleted).toBe(2);
    expect(report).toMatchObject({ status: "failed", failure: "fresh_read_not_exercised" });
    expect(report.endurance.every(round => round.answerCorrect && !round.requestedOriginalsRead)).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
