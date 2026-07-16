// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { Edge, Node } from "@xyflow/react";
import type { TimelineEntry } from "@traceforge/shared";
import { layeredLayout, type FlowNodeData } from "./GraphView.js";

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
    expect(positions.get("left")?.x).toBe(330);
    expect(positions.get("right")?.x).toBe(330);
    expect(positions.get("left")?.y).not.toBe(positions.get("right")?.y);
    expect(positions.get("end")?.x).toBe(660);
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
