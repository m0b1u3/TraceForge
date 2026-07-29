import { describe, expect, it } from "vitest";
import { KnowledgeOutcomeTracker, classifyKnowledgeOutcome } from "./knowledge-outcome.js";
import type { KnowledgeRef } from "./stores/knowledge-usage-store.js";

describe("knowledge outcome classification", () => {
  it("rewards verified investigation outcomes but not ordinary tool success", () => {
    expect(classifyKnowledgeOutcome({
      name: "http_replay", input: {}, content: "200", ok: true,
    })).toMatchObject({ positive: 0, negative: 0 });
    expect(classifyKnowledgeOutcome({
      name: "record_fact",
      input: { type: "finding", findingStatus: "verified" },
      content: "saved",
      ok: true,
    })).toMatchObject({ positive: 3, negative: 0 });
    expect(classifyKnowledgeOutcome({
      name: "resolve_hypothesis",
      input: { status: "refuted" },
      content: "resolved",
      ok: true,
    })).toMatchObject({ positive: 2, negative: 0 });
    expect(classifyKnowledgeOutcome({
      name: "assess_validation_experiment",
      input: { baselineTrafficId: "a", variantTrafficId: "b" },
      content: JSON.stringify({ verdict: "supports" }),
      ok: true,
    })).toMatchObject({ positive: 2, negative: 0 });
    expect(classifyKnowledgeOutcome({
      name: "assess_validation_experiment",
      input: { baselineTrafficId: "a", variantTrafficId: "b" },
      content: JSON.stringify({ verdict: "inconclusive" }),
      ok: true,
    })).toMatchObject({ positive: 0, negative: 0 });
    expect(classifyKnowledgeOutcome({
      name: "record_validation_conclusion",
      input: { findingId: "fact_1" },
      content: JSON.stringify({ conclusion: { verdict: "refutes" } }),
      ok: true,
    })).toMatchObject({ positive: 2, negative: 0 });
  });

  it("does not treat operational failures as knowledge outcomes", () => {
    expect(classifyKnowledgeOutcome({
      name: "http_replay", input: {}, content: "timeout", ok: false, transient: true,
      failureClass: "transient",
    })).toMatchObject({ positive: 0, negative: 0 });
    expect(classifyKnowledgeOutcome({
      name: "http_replay", input: {}, content: "invalid request", ok: false,
      failureClass: "permanent",
    })).toMatchObject({ positive: 0, negative: 0 });
  });

  it("links a later verified result to knowledge used earlier in the investigation", () => {
    const tracker = new KnowledgeOutcomeTracker();
    const ref: KnowledgeRef = { id: "identity_alice", kind: "identity" };

    expect(tracker.settle({
      name: "http_replay", input: { identityId: ref.id }, content: "200", ok: true,
    }, [ref]).refs).toEqual([]);

    const settled = tracker.settle({
      name: "record_fact",
      input: { type: "finding", findingStatus: "verified" },
      content: "saved",
      ok: true,
    }, []);
    expect(settled.refs).toEqual([ref]);
    expect(settled.outcome.positive).toBe(3);
  });
});
