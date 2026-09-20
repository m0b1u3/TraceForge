import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDesktopStreamAcceptance } from "./test-fixtures/desktop-stream-acceptance.js";
import type { LlmProvider } from "@traceforge/llm";

it.each([undefined, null])("requires partial output, tool records, cancellation and replay-free restoration (call limit %s)", async maximumModelCalls => {
  const root = await mkdtemp(join(tmpdir(), "traceforge-stream-harness-"));
  let calls = 0;
  const reads = maximumModelCalls === null ? 5 : 1;
  const provider: LlmProvider = { extractJson: async () => ({}), runTools: async () => { throw new Error("unused"); },
    streamTools: async (args, handlers) => {
      calls++;
      if (calls <= reads) return { text: "", done: false, toolCalls: [{ id: `read-${calls}`, name: "conversation_read", input: { id: "early" } }] };
      handlers.onReasoningDelta?.("Public summary");
      const token = JSON.stringify(args.messages).match(/reference-[a-f0-9]+/)![0];
      handlers.onTextDelta?.(token);
      if (calls === reads + 2) return new Promise((_resolve, reject) => handlers.signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
      await new Promise(resolve => setTimeout(resolve, 200));
      handlers.onTextDelta?.(" final");
      return { text: `${token} final`, done: true, toolCalls: [] };
    },
  };
  try {
    const report = await runDesktopStreamAcceptance(provider, { outputParent: root, mode: "simulated_harness_test", modelIdentity: { provider: "fixture", name: "fixture" }, maximumModelCalls });
    expect(report.status).toBe("passed"); expect(Object.values(report.checks).every(Boolean)).toBe(true);
    expect(report.observations.firstVisibleReasoningMs).not.toBeNull(); expect(calls).toBe(reads + 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
