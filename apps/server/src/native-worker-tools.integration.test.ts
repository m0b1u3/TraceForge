import { expect, it } from "vitest";
import { foundationHost, eventually } from "./test-fixtures/foundation-host.js";

it("executes a native Worker function call through the durable Host gateway and completes from its receipt", async () => {
  const observation = "observation-native-worker";
  const turns: string[] = [];
  const host = await foundationHost({ observationToken: observation, workerNative: async (args, handlers) => {
    const context = JSON.parse(args.messages[0]!.content) as { transcript: Array<{ kind: string; summary: string }> };
    const seen = context.transcript.some(entry => entry.kind === "tool" && entry.summary.includes(observation));
    const name = seen ? "tf_complete" : args.tools.find(tool => tool.description.startsWith("fixture.read:"))?.name;
    if (!name) throw new Error("Expected current native tool catalog");
    turns.push(name);
    handlers.onUsage?.({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    return { text: seen ? "" : "Read the assigned record", done: !seen,
      toolCalls: [{ id: seen ? "native-complete" : "native-read", name,
        input: seen ? { summary: `Observed ${observation}`, outputs: [] } : { candidate: "first candidate" } }] };
  } });
  try {
    await host.start();
    await eventually(async () => (await host.state()).workItems[0]?.status === "completed", 12000);
    expect(host.calls()).toBe(1);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatch(/^tf_fixture_read_[a-f0-9]{12}$/);
    expect(turns[1]).toBe("tf_complete");
    expect((await host.state()).workItems[0].resultSummary).toContain(observation);
    expect((host.sqlite.prepare("SELECT count(*) AS n FROM worker_tool_receipts").get() as { n: number }).n).toBe(1);
  } finally { await host.close(); }
});
