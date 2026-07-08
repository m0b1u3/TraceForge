import { describe, expect, it } from "vitest";
import {
  buildAgentConversationItems,
  shouldStickToBottomAfterUpdate,
  scopeApprovalContinuationEventText,
  scopeApprovalContinuationGoal,
  isStopButtonDisabled,
} from "./AgentPanel.js";

describe("scopeApprovalContinuationGoal", () => {
  it("asks the agent to continue after scope approval", () => {
    expect(scopeApprovalContinuationGoal("10.0.13.192:8080")).toBe(
      "Approved 10.0.13.192:8080. Continue testing this target. Start the shared browser and visit the homepage, record real observations, and do not fabricate conclusions.",
    );
  });
});

describe("scopeApprovalContinuationEventText", () => {
  it("matches steering event text when approval continues an active run", () => {
    expect(scopeApprovalContinuationEventText("10.0.13.192:8080", true)).toBe(
      "[steering] Approved 10.0.13.192:8080. Continue testing this target. Start the shared browser and visit the homepage, record real observations, and do not fabricate conclusions.",
    );
  });

  it("keeps ordinary user text when approval starts a new run", () => {
    expect(scopeApprovalContinuationEventText("10.0.13.192:8080", false)).toBe(
      "Approved 10.0.13.192:8080. Continue testing this target. Start the shared browser and visit the homepage, record real observations, and do not fabricate conclusions.",
    );
  });
});

describe("buildAgentConversationItems", () => {
  it("keeps a scope approval card after the latest visible agent message", () => {
    const items = buildAgentConversationItems({
      events: [
        { kind: "user", text: "Test http://10.0.13.192:8080/" },
        { kind: "started", text: "Started: Test http://10.0.13.192:8080/" },
        { kind: "text", text: "I need to request scope expansion first." },
      ],
      pendingApproval: null,
      pendingScope: { host: "10.0.13.192:8080", reason: "User requested testing this target." },
      agentBusy: false,
    });

    expect(items.map((item) => item.type)).toEqual(["event", "event", "scope"]);
    expect(items[1]).toMatchObject({ type: "event", label: "Agent", text: "I need to request scope expansion first." });
    expect(items[2]).toMatchObject({ type: "scope" });
  });

  it("hides duplicate user messages and terminal text already shown by streaming", () => {
    const items = buildAgentConversationItems({
      events: [
        { kind: "user", text: "Continue testing" },
        { kind: "user", text: "Continue testing" },
        { kind: "text", text: "Checking the homepage." },
        { kind: "done", text: "Checking the homepage." },
      ],
      pendingApproval: null,
      pendingScope: null,
      agentBusy: false,
    });

    expect(items).toHaveLength(2);
    expect(items.map((item) => item.text)).toEqual(["Continue testing", "Checking the homepage."]);
  });

  it("shortens verbose tool results in the chat stream", () => {
    const items = buildAgentConversationItems({
      events: [
        { kind: "tool_result", text: `browser_observe → ${"page content".repeat(80)}` },
      ],
      pendingApproval: null,
      pendingScope: null,
      agentBusy: false,
    });

    expect(items[0]?.type).toBe("event");
    expect(items[0]?.label).toBe("Tool");
    expect(items[0]?.text?.length).toBeLessThan(220);
    expect(items[0]?.text?.endsWith("...")).toBe(true);
  });

  it("hides noisy terminal and empty tool events from the chat stream", () => {
    const items = buildAgentConversationItems({
      events: [
        { kind: "started", text: "Started: test target" },
        { kind: "tool_call", text: "list_traffic({})" },
        { kind: "tool_result", text: "list_traffic → (暂无流量)" },
        { kind: "done", text: "done" },
        { kind: "text", text: "I found the login page." },
      ],
      pendingApproval: null,
      pendingScope: null,
      agentBusy: false,
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: "event", label: "Agent", text: "I found the login page." });
  });
});

describe("shouldStickToBottomAfterUpdate", () => {
  it("keeps following when the user is already near the bottom", () => {
    expect(shouldStickToBottomAfterUpdate({ scrollTop: 860, clientHeight: 120, scrollHeight: 1000 })).toBe(true);
  });

  it("does not force-scroll when the user has pulled the conversation upward", () => {
    expect(shouldStickToBottomAfterUpdate({ scrollTop: 200, clientHeight: 120, scrollHeight: 1000 })).toBe(false);
  });
});

describe("isStopButtonDisabled", () => {
  it("returns true while the API call is in flight", () => {
    expect(isStopButtonDisabled(true, "running")).toBe(true);
  });

  it("returns true when the run is already interrupting", () => {
    expect(isStopButtonDisabled(false, "interrupting")).toBe(true);
  });

  it("returns false during a normal running run", () => {
    expect(isStopButtonDisabled(false, "running")).toBe(false);
  });
});
