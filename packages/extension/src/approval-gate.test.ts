import { describe, it, expect } from "vitest";
import { ApprovalGate } from "./approval-gate.js";
import type { ToolDescriptor } from "./tool.js";

function tool(risk: "command" | "normal"): ToolDescriptor {
  return { name: "t", description: "d", inputSchema: {}, risk, source: "builtin", execute: async () => ({ ok: true, content: "" }) };
}

describe("ApprovalGate", () => {
  it("auto-approves normal-risk tools without asking", async () => {
    const calls: unknown[] = [];
    const asker = async (...args: unknown[]) => {
      calls.push(args);
      return "approved" as const;
    };
    const gate = new ApprovalGate(asker);
    expect(await gate.check(tool("normal"), {})).toBe("auto");
    expect(calls).toHaveLength(0);
  });

  it("asks the human for command-risk tools", async () => {
    const calls: unknown[] = [];
    const asker = async (...args: unknown[]) => {
      calls.push(args);
      return "approved" as const;
    };
    const gate = new ApprovalGate(asker);
    expect(await gate.check(tool("command"), {})).toBe("approved");
    expect(calls).toHaveLength(1);
  });

  it("relays a rejection for command-risk tools", async () => {
    const gate = new ApprovalGate(async () => "rejected");
    expect(await gate.check(tool("command"), {})).toBe("rejected");
  });
});
