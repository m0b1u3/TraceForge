import { describe, it, expect } from "vitest";
import { MockProvider } from "./mock-provider.js";
import type { ExtractJsonArgs } from "./provider.js";

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
