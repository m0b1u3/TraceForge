import { describe, expect, it } from "vitest";
import { ApprovalRegistry } from "./agent-approvals.js";

describe("ApprovalRegistry", () => {
  it("resolves an explicit approval exactly once", async () => {
    const registry = new ApprovalRegistry();
    const decision = registry.request("approval_1");

    expect(registry.resolve("approval_1", "approved")).toBe(true);
    await expect(decision).resolves.toBe("approved");
    expect(registry.resolve("approval_1", "rejected")).toBe(false);
  });

  it("rejects and removes a pending approval when its run is interrupted", async () => {
    const registry = new ApprovalRegistry();
    const controller = new AbortController();
    const decision = registry.request("approval_1", controller.signal);

    controller.abort("user stopped the run");

    await expect(decision).resolves.toBe("rejected");
    expect(registry.resolve("approval_1", "approved")).toBe(false);
  });

  it("does not retain an approval requested with an already aborted signal", async () => {
    const registry = new ApprovalRegistry();
    const controller = new AbortController();
    controller.abort();

    await expect(registry.request("approval_1", controller.signal)).resolves.toBe("rejected");
    expect(registry.resolve("approval_1", "approved")).toBe(false);
  });
});
