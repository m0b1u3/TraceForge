import { describe, expect, it } from "vitest";
import { sandboxEnvironmentArguments } from "./macos-execution-binding.js";

describe("host-only sandbox environment", () => {
  it("produces literal arguments without modifying the input", () => {
    const input = { PATH: "/fixture/bin:/usr/bin", HOME: "/fixture/work" };
    expect(sandboxEnvironmentArguments(input)).toEqual(["HOME=/fixture/work", "PATH=/fixture/bin:/usr/bin"]);
    expect(input.PATH).toBe("/fixture/bin:/usr/bin");
  });
  it.each(["DYLD_INSERT_LIBRARIES", "LD_PRELOAD", "NODE_OPTIONS", "BASH_ENV", "ENV"])("rejects startup injection %s", name => {
    expect(() => sandboxEnvironmentArguments({ [name]: "/fixture" })).toThrow("Invalid host execution environment");
  });
  it.each(["a\u0000b", "a\nb", "a\rb", "a".repeat(8193)])("rejects malformed values", value => {
    expect(() => sandboxEnvironmentArguments({ HOME: value })).toThrow();
  });
});
