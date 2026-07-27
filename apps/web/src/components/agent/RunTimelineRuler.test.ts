// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { Fact } from "@traceforge/shared";
import type { AgentUiEvent } from "../../store.js";
import { buildRulerTicks, rulerToolName } from "./RunTimelineRuler.js";

const T0 = "2026-07-27T10:00:00.000Z";
const T1 = "2026-07-27T10:00:10.000Z";
const T2 = "2026-07-27T10:00:20.000Z";

function fact(id: string, createdAt: string, title = id): Fact {
  return {
    id,
    caseId: "case_1",
    type: "finding",
    title,
    value: null,
    source: { type: "ai", ref: "run" },
    confidence: 1,
    tags: [],
    createdAt,
    updateCount: 0,
    updatedAt: "",
    validity: "valid",
  };
}

describe("rulerToolName", () => {
  it("extracts the tool name from call and result text", () => {
    expect(rulerToolName('browser_navigate({"url":"https://x"})')).toBe("browser_navigate");
    expect(rulerToolName("http_replay → 200 OK")).toBe("http_replay");
    expect(rulerToolName("unparseable text")).toBe("unparseable");
  });
});

describe("buildRulerTicks", () => {
  it("creates a tool tick per tool_call positioned along the time axis", () => {
    const events: AgentUiEvent[] = [
      { kind: "reasoning", text: "thinking", createdAt: T0 },
      { kind: "tool_call", text: "browser_navigate({})", createdAt: T0 },
      { kind: "tool_result", text: "browser_navigate → ok", createdAt: T1 },
      { kind: "tool_call", text: "list_traffic({})", createdAt: T2 },
    ];

    const ticks = buildRulerTicks({ events, facts: [] });

    expect(ticks.map((tick) => [tick.kind, tick.label, tick.eventIndex])).toEqual([
      ["tool", "browser_navigate", 1],
      ["tool", "list_traffic", 3],
    ]);
    expect(ticks[0].position).toBe(0);
    expect(ticks[1].position).toBe(1);
  });

  it("falls back to index positions when timestamps are missing", () => {
    const events: AgentUiEvent[] = [
      { kind: "tool_call", text: "a({})" },
      { kind: "text", text: "note" },
      { kind: "tool_call", text: "b({})" },
    ];

    const ticks = buildRulerTicks({ events, facts: [] });

    expect(ticks[0].position).toBe(0);
    expect(ticks[1].position).toBe(1);
  });

  it("interpolates finding ticks by creation time and clamps them to the track", () => {
    const events: AgentUiEvent[] = [
      { kind: "tool_call", text: "a({})", createdAt: T0 },
      { kind: "tool_call", text: "b({})", createdAt: T2 },
    ];
    const facts = [
      fact("fact_mid", T1),
      fact("fact_early", "2026-07-27T09:00:00.000Z"),
      fact("fact_late", "2026-07-27T11:00:00.000Z"),
    ];

    const ticks = buildRulerTicks({ events, facts });
    const findings = ticks.filter((tick) => tick.kind === "finding");

    expect(findings).toHaveLength(3);
    expect(findings.find((tick) => tick.factId === "fact_mid")?.position).toBe(0.5);
    expect(findings.find((tick) => tick.factId === "fact_early")?.position).toBe(0);
    expect(findings.find((tick) => tick.factId === "fact_late")?.position).toBe(1);
    expect(findings.every((tick) => tick.eventIndex === null)).toBe(true);
  });

  it("pins pending approval and scope gates to the right edge", () => {
    const ticks = buildRulerTicks({
      events: [{ kind: "tool_call", text: "a({})", createdAt: T0 }],
      facts: [],
      pendingApproval: { approvalId: "ap_1", tool: "exec_command", input: "{}" },
      pendingScope: { host: "example.com", reason: "out of scope" },
    });

    const gates = ticks.filter((tick) => tick.kind === "approval");
    expect(gates.map((gate) => gate.label)).toEqual(["exec_command", "scope: example.com"]);
    expect(gates.every((gate) => gate.position === 1)).toBe(true);
  });

  it("returns an empty track when there is nothing to show", () => {
    expect(buildRulerTicks({ events: [], facts: [] })).toEqual([]);
  });
});
