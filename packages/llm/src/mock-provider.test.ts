import { describe, it, expect } from "vitest";
import { MockProvider } from "./mock-provider.js";
import type { ExtractJsonArgs, RunTurn } from "./provider.js";

describe("MockProvider", () => {
  it("returns the configured static result", async () => {
    const mock = new MockProvider({ candidates: [{ title: "x" }] });
    expect(await mock.extractJson({ system: "s", user: "u", schema: {} })).toEqual({ candidates: [{ title: "x" }] });
  });

  it("supports a function result that sees the args", async () => {
    const mock = new MockProvider((args: ExtractJsonArgs) => ({ echoedUser: args.user }));
    expect(await mock.extractJson({ system: "s", user: "hello", schema: {} })).toEqual({ echoedUser: "hello" });
  });
});

describe("MockProvider runTools", () => {
  it("returns preset turns in order", async () => {
    const turns: RunTurn[] = [
      { text: "calling tool", toolCalls: [{ id: "c1", name: "http_replay", input: { url: "x" } }], done: false },
      { text: "done", toolCalls: [], done: true },
    ];
    const mock = new MockProvider({}, turns);
    const t1 = await mock.runTools({ system: "s", messages: [], tools: [] });
    expect(t1.toolCalls[0].name).toBe("http_replay");
    expect(t1.done).toBe(false);
    const t2 = await mock.runTools({ system: "s", messages: [], tools: [] });
    expect(t2.done).toBe(true);
  });

  it("defaults to a done turn when no turns configured", async () => {
    const mock = new MockProvider({});
    const t = await mock.runTools({ system: "s", messages: [], tools: [] });
    expect(t.done).toBe(true);
    expect(t.toolCalls).toEqual([]);
  });
});
