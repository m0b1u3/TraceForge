import { describe, expect, it } from "vitest";
import { PendingInterventionRegistry } from "./pending-interventions.js";

describe("PendingInterventionRegistry", () => {
  it("restores current scope and approval for a case", () => {
    const registry = new PendingInterventionRegistry();
    registry.setScope("case_1", { host: "target.example", reason: "user target" });
    registry.setApproval("case_1", { approvalId: "approval_1", tool: "list_dir", input: "{}" });

    expect(registry.get("case_1")).toEqual({
      scope: { host: "target.example", reason: "user target" },
      approval: { approvalId: "approval_1", tool: "list_dir", input: "{}" },
    });
  });

  it("does not let an old response clear a newer intervention", () => {
    const registry = new PendingInterventionRegistry();
    registry.setScope("case_1", { host: "new.example", reason: "new" });
    registry.setApproval("case_1", { approvalId: "approval_new", tool: "write_file", input: "{}" });

    registry.clearScope("case_1", "old.example");
    registry.clearApproval("case_1", "approval_old");

    expect(registry.get("case_1")).toEqual({
      scope: { host: "new.example", reason: "new" },
      approval: { approvalId: "approval_new", tool: "write_file", input: "{}" },
    });
  });
});
