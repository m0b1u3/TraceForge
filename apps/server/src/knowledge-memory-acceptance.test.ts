import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runKnowledgeMemoryAcceptance } from "./test-fixtures/knowledge-memory-acceptance.js";

it("checks source discovery, corrections and persisted-topic injection through the production loop", async () => {
  const root = await mkdtemp(join(tmpdir(), "tf-knowledge-acceptance-"));
  let revision = 0;
  try {
    const report = await runKnowledgeMemoryAcceptance({
      async extractJson(args) {
        const input = JSON.parse(args.user);
        if (input.records) return { ids: ["source"] };
        return { entries: (input.entries ?? []).map((e: any) => ({ id: e.id, text: "Earlier records are available by original lookup." })) };
      },
      async runTools() { throw new Error("unused"); },
      async streamTools(args, handlers) {
        const tool = (name: string, input: unknown) => ({ text: "", done: false, toolCalls: [{ id: `${name}-${revision}`, name, input }] });
        const last = args.messages.at(-1)!;
        const text = JSON.stringify(args.messages);
        if (last.role !== "tool") {
          if (last.content.includes("CURRENT archive")) {
            const answer = text.match(/revised-[a-f0-9]{12}/)?.[0] + " unverified";
            handlers.onTextDelta?.(answer); return { text: answer, done: true, toolCalls: [] };
          }
          if (last.content.includes("preceding correction")) return tool("conversation_read", { id: "amendment" });
          return tool("memory_recall", { query: "archive", semantic: true });
        }
        const result = JSON.parse(last.content);
        if (result.matches) return tool("conversation_read_sources", { sources: result.matches.filter((m: any) => m.id === "source").map((m: any) => ({ id: m.id, digest: m.digest })) });
        if (result.sources || result.digest) {
          const source = result.sources?.[0] ?? result;
          const identifier = source.text.match(/revised-[a-f0-9]{12}|sample-[a-f0-9]{12}/g)?.at(-1);
          return tool("memory_update", { key: "archive_status", kind: "topic", title: "Archive", text: `${identifier} unverified`, expectedRevision: revision++, status: "active", sources: [{ id: source.id, digest: source.digest }] });
        }
        const answer = (text.match(/revised-[a-f0-9]{12}/)?.[0] ?? text.match(/sample-[a-f0-9]{12}/)?.[0]) + " unverified";
        handlers.onTextDelta?.(answer); return { text: answer, done: true, toolCalls: [] };
      },
    }, { outputParent: root, mode: "simulated_harness_test", modelIdentity: { provider: "fixture", name: "neutral" } });
    expect(report, JSON.stringify(report)).toMatchObject({ status: "passed" });
    expect(Object.values(report.checks).every(Boolean)).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
