import { describe, it, expect } from "vitest";
import type { TimelineEntry } from "@traceforge/shared";
import { collectToolRefs } from "./agent-event-refs.js";

const entry = (id: string, eventType: string, refId: string | null = null): TimelineEntry => ({
  id, caseId: "c1", eventType, refId, detail: `${eventType} detail`, createdAt: "2026-07-27T00:00:00.000Z",
});

describe("collectToolRefs", () => {
  it("maps fact and task entries to their ref ids and keeps every timeline id", () => {
    const refs = collectToolRefs([
      entry("tl_1", "fact_created", "fact_1"),
      entry("tl_2", "fact_updated", "fact_2"),
      entry("tl_3", "task_created", "task_1"),
      entry("tl_4", "task_updated", "task_1"),
    ]);
    expect(refs).toEqual({
      factIds: ["fact_1", "fact_2"],
      taskIds: ["task_1"],
      timelineEntryIds: ["tl_1", "tl_2", "tl_3", "tl_4"],
    });
  });

  it("keeps non-entity entries as timeline refs only", () => {
    const refs = collectToolRefs([
      entry("tl_1", "action_recorded", "act_1"),
      entry("tl_2", "validation_started"),
    ]);
    expect(refs).toEqual({ factIds: [], taskIds: [], timelineEntryIds: ["tl_1", "tl_2"] });
  });

  it("dedupes repeated entity ids while preserving order", () => {
    const refs = collectToolRefs([
      entry("tl_1", "fact_created", "fact_1"),
      entry("tl_2", "fact_updated", "fact_1"),
    ]);
    expect(refs?.factIds).toEqual(["fact_1"]);
  });

  it("returns null when the tool produced nothing", () => {
    expect(collectToolRefs([])).toBeNull();
  });
});
