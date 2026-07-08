import { describe, it, expect } from "vitest";
import { AgentRunRegistry } from "./agent-runs.js";

describe("AgentRunRegistry", () => {
  it("starts one active run per case and rejects a second active run", () => {
    const reg = new AgentRunRegistry();
    const first = reg.start("case_1", "goal");
    expect(first.run.id).toMatch(/^run_/);
    expect(first.run.status).toBe("running");
    expect(reg.getActiveByCase("case_1")?.run.id).toBe(first.run.id);
    expect(() => reg.start("case_1", "other")).toThrow(/active run/);
  });

  it("queues and consumes steering messages", () => {
    const reg = new AgentRunRegistry();
    const { run } = reg.start("case_1", "goal");
    expect(reg.addSteering(run.id, "look at API")?.status).toBe("running");
    expect(reg.consumeSteering(run.id)).toEqual(["look at API"]);
    expect(reg.consumeSteering(run.id)).toEqual([]);
  });

  it("interrupt is idempotent and aborts the controller", () => {
    const reg = new AgentRunRegistry();
    const active = reg.start("case_1", "goal");
    const run = reg.interrupt(active.run.id, "user stop");
    expect(run?.status).toBe("interrupting");
    expect(run?.interruptReason).toBe("user stop");
    expect(active.abortController.signal.aborted).toBe(true);
    expect(reg.interrupt(active.run.id, "again")?.status).toBe("interrupting");
  });

  it("complete and fail clear the active case run", () => {
    const reg = new AgentRunRegistry();
    const { run } = reg.start("case_1", "goal");
    expect(reg.complete(run.id)?.status).toBe("completed");
    expect(reg.getActiveByCase("case_1")).toBeUndefined();

    const second = reg.start("case_1", "goal 2");
    expect(reg.fail(second.run.id, "boom")?.error).toBe("boom");
    expect(reg.getActiveByCase("case_1")).toBeUndefined();
  });

  it("marks needs_continuation as terminal and records completionReason", () => {
    const reg = new AgentRunRegistry();
    const active = reg.start("case_1", "goal");

    const run = reg.needsContinuation(active.run.id, "run budget exhausted after 2 turns");

    expect(run?.status).toBe("needs_continuation");
    expect(run?.finishedAt).toBeDefined();
    expect(run?.completionReason).toBe("run budget exhausted after 2 turns");
    expect(reg.getActiveByCase("case_1")).toBeUndefined();
  });

  it("allows a later run after a previous run needs continuation", () => {
    const reg = new AgentRunRegistry();
    const first = reg.start("case_1", "goal");

    reg.needsContinuation(first.run.id, "run budget exhausted after 2 turns");
    const second = reg.start("case_1", "continue");

    expect(second.run.status).toBe("running");
    expect(second.run.id).not.toBe(first.run.id);
  });

  it("keeps the latest run available after it is no longer active", () => {
    const reg = new AgentRunRegistry();
    const { run } = reg.start("case_1", "goal");
    reg.addUsage(run.id, { promptTokens: 10, completionTokens: 2, totalTokens: 12 });

    const completed = reg.complete(run.id, "done");

    expect(reg.getActiveByCase("case_1")).toBeUndefined();
    expect(reg.getLatestByCase("case_1")?.run).toEqual(completed);
  });
});
