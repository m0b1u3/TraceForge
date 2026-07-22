import { describe, expect, it } from "vitest";
import { unavailableKnowledgeTarget, validationRefreshFailed } from "./validation-feedback.js";

describe("validation feedback", () => {
  it("uses one semantic response for unavailable navigation targets", () => {
    expect(unavailableKnowledgeTarget("task")).toEqual({ message: "Related task is no longer available.", tone: "info" });
    expect(unavailableKnowledgeTarget("finding")).toEqual({ message: "Related finding is no longer available.", tone: "info" });
  });

  it("normalizes refresh failures without assuming an Error instance", () => {
    expect(validationRefreshFailed(new Error("Gateway unavailable"))).toEqual({
      message: "Validation state could not be refreshed. Gateway unavailable",
      tone: "error",
    });
    expect(validationRefreshFailed("offline").message).toBe("Validation state could not be refreshed.");
  });
});
