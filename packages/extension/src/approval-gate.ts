import type { ToolDescriptor } from "./tool.js";

export type ApprovalDecision = "auto" | "approved" | "rejected";
export type ApprovalAsker = (tool: ToolDescriptor, input: unknown) => Promise<"approved" | "rejected">;

export class ApprovalGate {
  constructor(private ask: ApprovalAsker) {}

  async check(tool: ToolDescriptor, input: unknown): Promise<ApprovalDecision> {
    if (tool.risk === "command") {
      return this.ask(tool, input);
    }
    return "auto";
  }
}
