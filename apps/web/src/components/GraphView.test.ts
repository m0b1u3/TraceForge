// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { Edge, Node } from "@xyflow/react";
import type { TimelineEntry } from "@traceforge/shared";
import { GRAPH_NODE_WINDOW_SIZE, buildTimelineGraph, graphNodeSelection, graphTimelineWindow, layeredLayout, type FlowNodeData } from "./GraphView.js";

const entry = {} as TimelineEntry;

function node(id: string): Node<FlowNodeData> {
  return {
    id,
    position: { x: 0, y: 0 },
    data: { entry, kind: "note", title: id, body: id, meta: "" },
  };
}

function edge(source: string, target: string): Edge {
  return { id: `${source}-${target}`, source, target };
}

describe("layeredLayout", () => {
  it("places dependencies in successive horizontal layers", () => {
    const result = layeredLayout(
      [node("root"), node("left"), node("right"), node("end")],
      [edge("root", "left"), edge("root", "right"), edge("left", "end"), edge("right", "end")],
      "RIGHT",
    );

    const positions = new Map(result.map((item) => [item.id, item.position]));
    expect(positions.get("root")?.x).toBe(0);
    expect(positions.get("left")?.x).toBe(372);
    expect(positions.get("right")?.x).toBe(372);
    expect(positions.get("left")?.y).not.toBe(positions.get("right")?.y);
    expect(positions.get("end")?.x).toBe(744);
  });

  it("returns a usable deterministic layout for cyclic imported data", () => {
    const nodes = [node("a"), node("b")];
    const edges = [edge("a", "b"), edge("b", "a")];
    const first = layeredLayout(nodes, edges, "DOWN");
    const second = layeredLayout(nodes, edges, "DOWN");

    expect(second).not.toBe(first);
    expect(second.map((item) => item.position)).toEqual(first.map((item) => item.position));
    expect(first.every((item) => Number.isFinite(item.position.x) && Number.isFinite(item.position.y))).toBe(true);
  });

  it("reuses coordinates without returning stale node content", () => {
    const original = [node("a")];
    layeredLayout(original, [], "RIGHT");
    const updated = [{ ...node("a"), data: { ...node("a").data, body: "updated evidence" } }];

    const result = layeredLayout(updated, [], "RIGHT");

    expect(result[0].data.body).toBe("updated evidence");
  });
});

describe("graphTimelineWindow", () => {
  const timeline: TimelineEntry[] = Array.from({ length: 500 }, (_, index) => ({
    id: `event_${index}`,
    caseId: "case_1",
    eventType: "timeline_appended",
    refId: null,
    detail: `event ${index}`,
    createdAt: String(index),
  }));

  it("bounds the mounted graph while preserving the latest replay position", () => {
    const window = graphTimelineWindow(timeline, 500);

    expect(window.entries).toHaveLength(GRAPH_NODE_WINDOW_SIZE);
    expect(window.entries[0]?.id).toBe("event_260");
    expect(window.entries.at(-1)?.id).toBe("event_499");
    expect(window.truncated).toBe(true);
  });

  it("keeps early replay steps complete", () => {
    const window = graphTimelineWindow(timeline, 20);

    expect(window.entries).toHaveLength(20);
    expect(window.start).toBe(0);
    expect(window.truncated).toBe(false);
  });

  it("leaves the window untouched when the pinned entry is already visible", () => {
    const window = graphTimelineWindow(timeline, 500, GRAPH_NODE_WINDOW_SIZE, "event_300");

    expect(window.entries).toHaveLength(GRAPH_NODE_WINDOW_SIZE);
    expect(window.start).toBe(260);
  });

  it("expands the window backwards to include a pinned entry outside it", () => {
    const window = graphTimelineWindow(timeline, 500, GRAPH_NODE_WINDOW_SIZE, "event_100");

    expect(window.start).toBe(100);
    expect(window.entries[0]?.id).toBe("event_100");
    expect(window.entries.at(-1)?.id).toBe("event_499");
    expect(window.truncated).toBe(true);
  });

  it("ignores a pinned id that does not exist in the timeline", () => {
    const window = graphTimelineWindow(timeline, 500, GRAPH_NODE_WINDOW_SIZE, "event_missing");

    expect(window.start).toBe(260);
    expect(window.entries).toHaveLength(GRAPH_NODE_WINDOW_SIZE);
  });
});

describe("graphNodeSelection", () => {
  const base = { id: "tl_1", caseId: "case_1", detail: "d", createdAt: "0" };

  it("maps fact nodes with a referenced fact to a finding selection", () => {
    expect(graphNodeSelection({ ...base, eventType: "fact_created", refId: "fact_9" })).toEqual({ type: "fact", id: "fact_9" });
    expect(graphNodeSelection({ ...base, eventType: "fact_updated", refId: "fact_9" })).toEqual({ type: "fact", id: "fact_9" });
  });

  it("maps task nodes with a referenced task to a task selection", () => {
    expect(graphNodeSelection({ ...base, eventType: "task_updated", refId: "task_3" })).toEqual({ type: "task", id: "task_3" });
    expect(graphNodeSelection({ ...base, eventType: "task_reopened", refId: "task_3" })).toEqual({ type: "task", id: "task_3" });
  });

  it("falls back to a timeline selection for other nodes or missing refs", () => {
    expect(graphNodeSelection({ ...base, eventType: "context_built", refId: null })).toEqual({ type: "timeline", id: "tl_1" });
    expect(graphNodeSelection({ ...base, eventType: "fact_created", refId: null })).toEqual({ type: "timeline", id: "tl_1" });
    expect(graphNodeSelection({ ...base, eventType: "action_recorded", refId: "act_1" })).toEqual({ type: "timeline", id: "tl_1" });
  });
});

describe("buildTimelineGraph hypothesis nodes", () => {
  const timeline: TimelineEntry[] = [
    { id: "tl_1", caseId: "case_1", eventType: "fact_created", refId: "fact_1", detail: "API exposes stack traces", createdAt: "2026-07-27T10:00:00.000Z" },
    { id: "tl_2", caseId: "case_1", eventType: "context_built", refId: null, detail: "context", createdAt: "2026-07-27T10:00:05.000Z" },
  ];
  const hypothesis = {
    id: "hyp_1",
    caseId: "case_1",
    statement: "Debug mode is enabled in production",
    status: "candidate" as const,
    basedOnFactIds: ["fact_1"],
    relatedTaskIds: [],
    createdAt: "2026-07-27T10:00:06.000Z",
    updatedAt: "2026-07-27T10:00:06.000Z",
    updateCount: 0,
  };

  it("appends hypothesis nodes linked to their supporting facts", () => {
    const graph = buildTimelineGraph(timeline, null, [], [], [], [hypothesis]);

    const node = graph.nodes.find((item) => item.id === "hyp-hyp_1");
    expect(node?.data.kind).toBe("hypothesis");
    expect(node?.data.title).toBe("Hypothesis");
    expect(node?.data.body).toBe("Debug mode is enabled in production");
    expect(graph.edges.some((edge) => edge.source === "tl_1" && edge.target === "hyp-hyp_1" && edge.label === "supports")).toBe(true);
  });

  it("omits hypothesis nodes while replaying history", () => {
    const graph = buildTimelineGraph(timeline, null, [], [], [], []);

    expect(graph.nodes.some((item) => item.id.startsWith("hyp-"))).toBe(false);
  });
});
