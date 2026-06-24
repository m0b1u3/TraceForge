import { describe, it, expect, vi } from "vitest";
import { ApprovalGate } from "./approval-gate.js";
import type { ToolDescriptor } from "./tool.js";

function tool(risk: "command" | "normal"): ToolDescriptor {
  return { name: "t", description: "d", inputSchema: {}, risk, source: "builtin", execute: async () => ({ ok: true, content: "" }) };
}

describe("ApprovalGate", () => {
  it("auto-approves normal-risk tools without asking", async () => {
    const asker = vi.fn();
    const gate = new ApprovalGate(asker);
    expect(await gate.check(tool("normal"), {})).toBe("auto");
    expect(asker).not.toHaveBeenCalled();
  });

  it("asks the human for command-risk tools", async () => {
    const asker = vi.fn().mockResolvedValue("approved");
    const gate = new ApprovalGate(asker);
    expect(await gate.check(tool("command"), {})).toBe("approved");
    expect(asker).toHaveBeenCalledOnce();
  });

  it("relays a rejection for command-risk tools", async () => {
    const gate = new ApprovalGate(async () => "rejected");
    expect(await gate.check(tool("command"), {})).toBe("rejected");
  });
});
