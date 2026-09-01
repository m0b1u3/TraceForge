import { describe, expect, it } from "vitest";
import { createScenarioHostCapabilities } from "./index.js";

describe("Scenario host capabilities", () => {
  it("resolves opaque versioned ports without teaching the SDK their domain", () => {
    const port = Object.freeze({ inspect: () => "ok" });
    const capabilities = createScenarioHostCapabilities({ "fixture.inspect@1": port });
    expect(capabilities.require<typeof port>("fixture.inspect@1")).toBe(port);
    expect(capabilities.optional("fixture.absent@1")).toBeUndefined();
    expect(() => capabilities.require("fixture.inspect@2")).toThrow("unavailable");
  });
});
