import { describe, expect, it } from "vitest";
import { buildAgentConversationItems, scopeApprovalContinuationEventText, scopeApprovalContinuationGoal } from "./AgentPanel.js";

describe("scopeApprovalContinuationGoal", () => {
  it("asks the agent to continue after scope approval", () => {
    expect(scopeApprovalContinuationGoal("10.0.13.192:8080")).toBe(
      "已批准将 10.0.13.192:8080 纳入授权范围。请继续测试该目标，优先启动共享浏览器并访问目标首页，记录真实观察结果，不要编造结论。",
    );
  });
});

describe("scopeApprovalContinuationEventText", () => {
  it("matches steering event text when approval continues an active run", () => {
    expect(scopeApprovalContinuationEventText("10.0.13.192:8080", true)).toBe(
      "[steering] 已批准将 10.0.13.192:8080 纳入授权范围。请继续测试该目标，优先启动共享浏览器并访问目标首页，记录真实观察结果，不要编造结论。",
    );
  });

  it("keeps ordinary user text when approval starts a new run", () => {
    expect(scopeApprovalContinuationEventText("10.0.13.192:8080", false)).toBe(
      "已批准将 10.0.13.192:8080 纳入授权范围。请继续测试该目标，优先启动共享浏览器并访问目标首页，记录真实观察结果，不要编造结论。",
    );
  });
});

describe("buildAgentConversationItems", () => {
  it("keeps a scope approval card after the latest visible agent message", () => {
    const items = buildAgentConversationItems({
      events: [
        { kind: "user", text: "测试一下 http://10.0.13.192:8080/" },
        { kind: "started", text: "开始：测试一下 http://10.0.13.192:8080/" },
        { kind: "text", text: "我需要先申请授权范围扩展。" },
      ],
      pendingApproval: null,
      pendingScope: { host: "10.0.13.192:8080", reason: "用户要求测试该目标。" },
      agentBusy: false,
    });

    expect(items.map((item) => item.type)).toEqual(["event", "event", "scope"]);
    expect(items[1]).toMatchObject({ type: "event", label: "Agent", text: "我需要先申请授权范围扩展。" });
    expect(items[2]).toMatchObject({ type: "scope" });
  });

  it("hides duplicate user messages and terminal text already shown by streaming", () => {
    const items = buildAgentConversationItems({
      events: [
        { kind: "user", text: "继续测试" },
        { kind: "user", text: "继续测试" },
        { kind: "text", text: "正在检查首页。" },
        { kind: "done", text: "正在检查首页。" },
      ],
      pendingApproval: null,
      pendingScope: null,
      agentBusy: false,
    });

    expect(items).toHaveLength(2);
    expect(items.map((item) => item.text)).toEqual(["继续测试", "正在检查首页。"]);
  });

  it("shortens verbose tool results in the chat stream", () => {
    const items = buildAgentConversationItems({
      events: [
        { kind: "tool_result", text: `browser_observe → ${"页面内容".repeat(80)}` },
      ],
      pendingApproval: null,
      pendingScope: null,
      agentBusy: false,
    });

    expect(items[0]?.type).toBe("event");
    expect(items[0]?.label).toBe("工具结果");
    expect(items[0]?.text?.length).toBeLessThan(220);
    expect(items[0]?.text?.endsWith("...")).toBe(true);
  });
});
