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

  it("groups only adjacent validation transitions for the same target", () => {
    const items = buildAgentConversationItems({
      events: [
        { kind: "validation", tool: "validation_task_claimed", text: "Task=task_1; consensus=insufficient", createdAt: "1" },
        { kind: "validation", tool: "validation_task_completion_blocked", text: "Task=task_1; missing=independent replay", createdAt: "2" },
        { kind: "text", text: "Testing another hypothesis" },
        { kind: "validation", tool: "validation_task_released", text: "Task=task_1; reason=exploration", createdAt: "3" },
      ],
      pendingApproval: null,
      pendingScope: null,
      agentBusy: false,
    });

    expect(items[0]).toEqual(expect.objectContaining({ type: "validation_group", target: { kind: "task", id: "task_1" } }));
    expect(items[0]?.type === "validation_group" ? items[0].events : []).toHaveLength(2);
    expect(items.map((item) => item.type)).toEqual(["validation_group", "event", "event"]);
  });
});
