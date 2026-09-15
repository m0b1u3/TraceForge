import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runDesktopMemoryAcceptance } from "./test-fixtures/desktop-memory-acceptance.js";
it("exercises the production reply service across summary, original lookup and restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-model-memory-"));
  try {
    const report = await runDesktopMemoryAcceptance({
      async extractJson(args) { return { entries: JSON.parse(args.user).entries.map((entry: any) => ({ id: entry.id, text: "Earlier discussion remains in originals." })) }; },
      async runTools() { throw new Error("No execution path"); },
      async streamTools(args, handlers) {
        if (args.messages.at(-1)?.role !== "tool") return { text: "", done: false, toolCalls: [{ id: "read", name: "conversation_read", input: { id: "early" } }] };
        const text = JSON.stringify(args.messages).match(/reference-[a-f0-9]{12}/)?.[0] + " " + (JSON.stringify(args.messages).match(/latest-[a-f0-9]{12}/)?.[0] ?? "");
        handlers.onTextDelta?.(text); return { text, done: true, toolCalls: [] };
      },
    }, { outputParent: root, mode: "simulated_harness_test", modelIdentity: { provider: "fixture", name: "neutral" } });
    expect(report, JSON.stringify(report)).toMatchObject({ status: "passed", checks: { firstSummary: true, originalRecall: true, restartNoReplay: true, secondSummary: true, userCorrection: true } });
  } finally { await rm(root, { recursive: true, force: true }); }
});
