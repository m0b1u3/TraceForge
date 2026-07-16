import { describe, expect, it } from "vitest";
import { deriveRunPhase } from "./RunPhase.js";

describe("deriveRunPhase", () => {
  it("starts with scope before the Agent runs", () => {
    expect(deriveRunPhase({ events: [], trafficCount: 0, factCount: 0, busy: false })).toBe("scoping");
  });

  it("moves from discovery through evidence validation using real state", () => {
    expect(deriveRunPhase({ events: [{ kind: "tool_call", text: "browser.navigate" }], trafficCount: 0, factCount: 0, busy: true })).toBe("discovering");
    expect(deriveRunPhase({ events: [], trafficCount: 2, factCount: 0, busy: true })).toBe("capturing");
    expect(deriveRunPhase({ events: [{ kind: "reasoning", text: "correlating" }], trafficCount: 2, factCount: 0, busy: true })).toBe("analyzing");
    expect(deriveRunPhase({ events: [], trafficCount: 2, factCount: 1, busy: true })).toBe("validating");
  });

  it("reports completion from the persisted event stream", () => {
    expect(deriveRunPhase({ events: [{ kind: "done", text: "complete" }], trafficCount: 2, factCount: 1, busy: false })).toBe("reporting");
  });
});
