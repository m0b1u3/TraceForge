import { describe, it, expect } from "vitest";
import { makeUpdateSessionStateTool, makeRecordHypothesisTool, makeResolveHypothesisTool } from "./cognitive-tools.js";

const facts = { getById: (id: string) => (id === "f1" ? { id: "f1" } : undefined) };

describe("update_session_state tool", () => {
  it("upserts goal/phase/focus", async () => {
    const calls: unknown[] = [];
    const ss = { upsert: (_c: string, p: unknown) => { calls.push(p); return { phase: "analyze" }; } };
    const t = makeUpdateSessionStateTool("c1", ss);
    const r = await t.execute({ currentGoal: "测越权", phase: "analyze" });
    expect(r.ok).toBe(true);
    expect(calls[0]).toMatchObject({ currentGoal: "测越权", phase: "analyze" });
  });
});

describe("record_hypothesis tool", () => {
  it("rejects empty basedOnFactIds", async () => {
    const hyp = { create: () => ({ id: "h1" }), getById: () => undefined, update: () => undefined };
    const t = makeRecordHypothesisTool("c1", hyp, facts);
    const r = await t.execute({ statement: "x", basedOnFactIds: [] });
    expect(r.ok).toBe(false);
    expect(r.content).toContain("基于");
  });
  it("rejects basedOnFactIds referencing non-existent fact", async () => {
    const hyp = { create: () => ({ id: "h1" }), getById: () => undefined, update: () => undefined };
    const t = makeRecordHypothesisTool("c1", hyp, facts);
    const r = await t.execute({ statement: "x", basedOnFactIds: ["nope"] });
    expect(r.ok).toBe(false);
  });
  it("creates when facts exist", async () => {
    const hyp = { create: () => ({ id: "h1" }), getById: () => undefined, update: () => undefined };
    const t = makeRecordHypothesisTool("c1", hyp, facts);
    const r = await t.execute({ statement: "x", basedOnFactIds: ["f1"] });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("h1");
  });
});

describe("resolve_hypothesis tool", () => {
  it("confirmed requires a confirming fact id", async () => {
    const hyp = { create: () => ({ id: "h1" }), getById: () => ({ id: "h1", status: "open" }), update: () => ({ id: "h1", status: "confirmed" }) };
    const t = makeResolveHypothesisTool("c1", hyp, facts);
    const bad = await t.execute({ id: "h1", status: "confirmed" });
    expect(bad.ok).toBe(false);
    const good = await t.execute({ id: "h1", status: "confirmed", confirmingFactId: "f1" });
    expect(good.ok).toBe(true);
  });
  it("refuted does not require a fact", async () => {
    const hyp = { create: () => ({ id: "h1" }), getById: () => ({ id: "h1", status: "open" }), update: () => ({ id: "h1", status: "refuted" }) };
    const t = makeResolveHypothesisTool("c1", hyp, facts);
    const r = await t.execute({ id: "h1", status: "refuted" });
    expect(r.ok).toBe(true);
  });
});
