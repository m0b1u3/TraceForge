import { describe, expect, it } from "vitest";
import { makeRecordActionTool } from "@traceforge/extension";
import { createDb } from "./db/client.js";
import { EventBus } from "./event-bus.js";
import { ActionCardStore } from "./stores/action-store.js";
import { DecisionStore } from "./stores/decision-store.js";
import { FactStore } from "./stores/fact-store.js";
import { HypothesisStore } from "./stores/hypothesis-store.js";
import { TaskStore } from "./stores/task-store.js";
import { TimelineStore } from "./stores/timeline-store.js";

describe("action recording with real SQLite stores", () => {
  it("normalizes model priority aliases without losing the action", async () => {
    const db = createDb(":memory:");
    const bus = new EventBus();
    const facts = new FactStore(db);
    const hypotheses = new HypothesisStore(db);
    const tasks = new TaskStore(db);
    const actions = new ActionCardStore(db);
    const evidence = facts.create("case_1", {
      sourceRunId: "run_1",
      type: "observed_behavior",
      title: "Observed candidate behavior",
      value: { differential: "present" },
      source: { type: "traffic", ref: "traffic_1" },
      confidence: 0.7,
      tags: ["observation"],
    });
    const hypothesis = hypotheses.create("case_1", {
      runId: "run_1",
      statement: "The observed behavior may have security impact.",
      basedOnFactIds: [evidence.id],
      status: "active",
    });
    const task = tasks.create("case_1", {
      runId: "run_1",
      title: "Validate the candidate behavior",
      status: "running",
      reason: "",
      blockedBy: [],
      triggerWhen: [],
      relatedFacts: [evidence.id],
      hypothesisIds: [hypothesis.id],
      priority: "high",
      relationshipGate: null,
    });
    const tool = makeRecordActionTool(
      "case_1",
      facts,
      actions,
      new DecisionStore(db),
      new TimelineStore(db),
      (event) => bus.emit(event),
      { hypotheses, tasks },
    );

    const result = await tool.execute({
      title: "Validate candidate",
      goal: "Collect a reproducible differential.",
      evidenceRefs: [evidence.id],
      hypothesisRefs: [hypothesis.id],
      taskRefs: [task.id],
      reasoning: "The candidate needs causal validation.",
      steps: ["Capture a baseline", "Apply one controlled variant"],
      expectedResults: ["A stable differential"],
      riskNotes: ["Authorized scope only"],
      tool: "http_replay",
      priority: "critical",
    });

    expect(result.ok).toBe(true);
    expect(actions.listByCase("case_1")).toEqual([
      expect.objectContaining({ title: "Validate candidate", priority: "high" }),
    ]);
  });
});
