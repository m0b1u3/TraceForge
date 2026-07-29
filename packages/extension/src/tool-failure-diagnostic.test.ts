import { describe, expect, it } from "vitest";
import { diagnoseToolFailure } from "./tool-failure-diagnostic.js";

describe("tool failure diagnostics", () => {
  it("distinguishes execution, environment, and transport failures", () => {
    expect(diagnoseToolFailure("exit=2\ninvalid flag")).toEqual(expect.objectContaining({
      category: "command_exit",
      retryable: false,
    }));
    expect(diagnoseToolFailure("command rejected before execution: unsupported platform")).toEqual(expect.objectContaining({
      category: "incompatible_environment",
      retryable: false,
    }));
    expect(diagnoseToolFailure("request timed out after 45000ms")).toEqual(expect.objectContaining({
      category: "timeout",
      retryable: true,
    }));
    expect(diagnoseToolFailure("socket hang up: ECONNRESET")).toEqual(expect.objectContaining({
      category: "network",
      retryable: true,
    }));
  });

  it("uses lifecycle hints when raw text cannot express the control decision", () => {
    expect(diagnoseToolFailure("execution stopped", "rejected")).toEqual(expect.objectContaining({
      category: "rejected",
      retryable: false,
    }));
    expect(diagnoseToolFailure("execution stopped", "policy_block")).toEqual(expect.objectContaining({
      category: "policy_block",
      retryable: false,
    }));
  });

  it("does not turn an application response status into a dependency diagnosis", () => {
    expect(diagnoseToolFailure("HTTP 404 Not Found")).toEqual(expect.objectContaining({
      category: "unknown",
      retryable: false,
    }));
  });
});
