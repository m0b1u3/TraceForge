import { describe, expect, it } from "vitest";
import { buildAgentConversationItems } from "./agent-conversation.js";

describe("Agent validation conversation events", () => {
  it("renders a concise validation event with its semantic label", () => {
    const items = buildAgentConversationItems({
      events: [{ kind: "validation", tool: "validation_task_completion_blocked", text: "Task=task_1; missing=independent reproduction" }],
      pendingApproval: null,
      pendingScope: null,
      agentBusy: false,
    });
    expect(items).toEqual([expect.objectContaining({ type: "event", kind: "validation", label: "Evidence gate", text: "Blocked task_1 · missing independent reproduction" })]);
  });
});
