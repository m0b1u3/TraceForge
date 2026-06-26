import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("./api.js", () => ({
  listTraffic: vi.fn(async () => []),
  listFacts: vi.fn(async () => []),
  listTasks: vi.fn(async () => []),
  listTimeline: vi.fn(async () => []),
  listMcpTools: vi.fn(async () => []),
  listWarnings: vi.fn(async () => []),
  listAgentEvents: vi.fn(async () => [
    { id: "ae_1", caseId: "c1", kind: "started", text: "开始：找接口", tool: null, createdAt: "t1" },
    { id: "ae_2", caseId: "c1", kind: "tool_call", text: "record_fact(...)", tool: "record_fact", createdAt: "t2" },
  ]),
}));

import { useStore } from "./store.js";

beforeEach(() => {
  useStore.setState({ caseId: null, agentEvents: [] });
});

describe("enterCase agent history hydration", () => {
  it("fills agentEvents from the history endpoint as AgentUiEvents", async () => {
    await useStore.getState().enterCase("c1");
    const events = useStore.getState().agentEvents;
    expect(events.map((e) => e.kind)).toEqual(["started", "tool_call"]);
    expect(events[0].text).toBe("开始：找接口");
    expect(events[1].text).toContain("record_fact");
  });
});
