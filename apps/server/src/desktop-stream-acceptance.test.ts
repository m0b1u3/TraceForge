import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDesktopStreamAcceptance } from "./test-fixtures/desktop-stream-acceptance.js";
import type { LlmProvider } from "@traceforge/llm";

it("requires observable partial output, real history-tool records, cancellation and replay-free restoration", async () => {
  const root = await mkdtemp(join(tmpdir(), "traceforge-stream-harness-"));
  let calls = 0;
  const provider: LlmProvider = { extractJson: async () => ({}), runTools: async () => { throw new Error("unused"); },
    streamTools: async (args, handlers) => {
      calls++;
      if (calls === 1) return { text: "", done: false, toolCalls: [{ id: "read", name: "conversation_read", input: { id: "early" } }] };
      handlers.onReasoningDelta?.("Public summary");
      const token = JSON.stringify(args.messages).match(/reference-[a-f0-9]+/)![0];
      handlers.onTextDelta?.(token);
      if (calls === 3) return new Promise((_resolve, reject) => handlers.signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
      await new Promise(resolve => setTimeout(resolve, 200));
      handlers.onTextDelta?.(" final");
      return { text: `${token} final`, done: true, toolCalls: [] };
    },
  };
  try {
    const report = await runDesktopStreamAcceptance(provider, { outputParent: root, mode: "simulated_harness_test", modelIdentity: { provider: "fixture", name: "fixture" } });
    expect(report.status).toBe("passed"); expect(Object.values(report.checks).every(Boolean)).toBe(true);
    expect(report.observations.firstVisibleReasoningMs).not.toBeNull(); expect(calls).toBe(3);
  } finally { await rm(root, { recursive: true, force: true }); }
});
