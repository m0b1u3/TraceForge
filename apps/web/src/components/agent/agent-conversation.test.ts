import { describe, expect, it } from "vitest";
import { buildAgentConversationItems, findAgentEventIndexByRef } from "./agent-conversation.js";

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

describe("tool result refs", () => {
  it("carries refs from the source event onto the conversation item", () => {
    const refs = { factIds: ["fact_1"], taskIds: ["task_1"], timelineEntryIds: ["tl_1"] };
    const items = buildAgentConversationItems({
      events: [{ kind: "tool_result", text: "record_fact → ok", refs }],
      pendingApproval: null,
      pendingScope: null,
      agentBusy: false,
    });
    expect(items[0]).toEqual(expect.objectContaining({
      type: "tool_group",
      activities: [expect.objectContaining({ result: expect.objectContaining({ kind: "tool_result", refs }) })],
    }));
  });

  it("pairs calls with results and groups adjacent executions of the same tool", () => {
    const items = buildAgentConversationItems({
      events: [
        { kind: "tool_call", text: "http_replay({\"path\":\"/first\"})" },
        { kind: "tool_result", text: "http_replay → completed" },
        { kind: "tool_call", text: "http_replay({\"path\":\"/second\"})" },
        { kind: "tool_result", text: "http_replay → completed" },
        { kind: "text", text: "Both observations are consistent." },
      ],
      pendingApproval: null,
      pendingScope: null,
      agentBusy: false,
    });

    expect(items.map((item) => item.type)).toEqual(["tool_group", "event"]);
    const group = items[0];
    expect(group?.type).toBe("tool_group");
    if (group?.type !== "tool_group") return;
    expect(group.tool).toBe("http_replay");
    expect(group.activities).toHaveLength(2);
    expect(group.activities.every((activity) => activity.call && activity.result)).toBe(true);
  });

  it("finds the last console event whose refs mention an entity", () => {
    const events = [
      { kind: "tool_result" as const, text: "a", refs: { factIds: ["fact_1"], taskIds: [], timelineEntryIds: ["tl_1"] } },
      { kind: "tool_result" as const, text: "b", refs: null },
      { kind: "tool_result" as const, text: "c", refs: { factIds: [], taskIds: ["task_1"], timelineEntryIds: ["tl_2"] } },
      { kind: "tool_result" as const, text: "d", refs: { factIds: ["fact_1"], taskIds: [], timelineEntryIds: ["tl_3"] } },
    ];
    expect(findAgentEventIndexByRef(events, "fact_1")).toBe(3);
    expect(findAgentEventIndexByRef(events, "task_1")).toBe(2);
    expect(findAgentEventIndexByRef(events, "tl_1")).toBe(0);
    expect(findAgentEventIndexByRef(events, "missing")).toBe(-1);
  });
});
