import { describe, expect, it } from "vitest";
import type { ToolExecutionReport } from "@traceforge/extension";
import { ObserverScheduler } from "./observer-scheduler.js";

const failureDiagnostic = {
  category: "invalid_input" as const,
  retryable: false,
  summary: "The input is invalid.",
  recommendation: "Change the input.",
};

function failure(
  input: unknown,
  executionScopeKey = "task:first",
  extra: Partial<ToolExecutionReport> = {},
): ToolExecutionReport {
  return {
    name: "probe",
    input,
    content: "invalid input",
    ok: false,
    executionScopeKey,
    failureDiagnostic,
    ...extra,
  };
}

describe("ObserverScheduler event policy", () => {
  it("does not review ordinary successful tool turns", () => {
    const scheduler = new ObserverScheduler();
    scheduler.observe({ name: "list_traffic", input: {}, content: "[]", ok: true, risk: "normal" });
    expect(scheduler.consume()).toBeNull();
  });

  it("reviews only after the same task repeats an identical failed call three times", () => {
    const scheduler = new ObserverScheduler();
    scheduler.observe(failure({ candidate: "first" }));
    scheduler.observe(failure({ candidate: "first" }, "task:first", { blocked: true }));
    expect(scheduler.consume()).toBeNull();

    scheduler.observe(failure({ candidate: "first" }, "task:first", { blocked: true }));
    expect(scheduler.consume()).toBe("repeated_failure");
    expect(scheduler.consume()).toBeNull();
  });

  it("allows changed inputs and tools to pivot before unresolved work is reviewed", () => {
    const scheduler = new ObserverScheduler();
    scheduler.observe(failure({ candidate: "first" }));
    scheduler.observe(failure({ candidate: "second" }));
    scheduler.observe({ ...failure({ path: "artifact" }), name: "analyze" });
    expect(scheduler.consume()).toBeNull();
  });

  it("reviews a task after five unresolved failures even when calls changed", () => {
    const scheduler = new ObserverScheduler();
    for (let index = 0; index < 4; index += 1) {
      scheduler.observe(failure({ candidate: index }));
    }
    expect(scheduler.consume()).toBeNull();
    scheduler.observe(failure({ candidate: 4 }));
    expect(scheduler.consume()).toBe("repeated_failure");

    scheduler.observe(failure({ candidate: "new strategy" }));
    expect(scheduler.consume()).toBeNull();
  });

  it("isolates failure sequences by task and clears them after recovery", () => {
    const scheduler = new ObserverScheduler();
    scheduler.observe(failure({ candidate: "first" }, "task:first"));
    scheduler.observe(failure({ candidate: "first" }, "task:first", { blocked: true }));
    scheduler.observe(failure({ candidate: "second" }, "task:second"));
    scheduler.observe(failure({ candidate: "second" }, "task:second", { blocked: true }));
    expect(scheduler.consume()).toBeNull();

    scheduler.observe({
      name: "probe",
      input: { candidate: "first" },
      content: "recovered",
      ok: true,
      executionScopeKey: "task:first",
    });
    scheduler.observe(failure({ candidate: "first" }, "task:first"));
    expect(scheduler.consume()).toBeNull();
  });

  it("does not turn authorization decisions into repeated execution failures", () => {
    const scheduler = new ObserverScheduler();
    const authorization = {
      category: "authorization" as const,
      retryable: false,
      summary: "Authorization required.",
      recommendation: "Resolve authorization.",
    };
    for (let index = 0; index < 6; index += 1) {
      scheduler.observe(failure({ candidate: index }, "task:first", {
        blocked: true,
        failureDiagnostic: authorization,
      }));
    }
    expect(scheduler.consume()).toBeNull();
  });

  it("prioritizes evidence conflict over lower priority events in the same turn", () => {
    const scheduler = new ObserverScheduler();
    scheduler.observe({
      name: "record_fact",
      input: { type: "finding", findingStatus: "validating" },
      content: "recorded",
      ok: true,
      risk: "normal",
    });
    scheduler.observe({
      name: "compare_identity_traffic",
      input: { baselineIdentityId: "guest", comparisonIdentityId: "admin" },
      content: JSON.stringify({ statusDifferent: true, bodyDifferent: true }),
      ok: true,
      risk: "normal",
    });
    expect(scheduler.consume()).toBe("evidence_conflict");
    expect(scheduler.consume()).toBeNull();
  });

  it("reviews validated and invalidated attack paths as evidence events", () => {
    const scheduler = new ObserverScheduler();
    scheduler.observe({ name: "record_attack_path", input: {}, content: JSON.stringify({ status: "validated" }), ok: true });
    expect(scheduler.consume()).toBe("finding_verification");
    scheduler.observe({ name: "record_attack_path", input: {}, content: JSON.stringify({ status: "invalidated" }), ok: true });
    expect(scheduler.consume()).toBe("evidence_conflict");
  });

  it("reviews a completion attempt rejected by an evidence gate without reviewing an ordinary Task update", () => {
    const scheduler = new ObserverScheduler();
    scheduler.observe({
      name: "record_task",
      input: { id: "task_1", status: "running" },
      content: "Task task_1 updated.",
      ok: true,
    });
    expect(scheduler.consume()).toBeNull();

    scheduler.observe({
      name: "record_task",
      input: { id: "task_1", status: "done" },
      content: "Task task_1 remains blocked. Missing completion evidence: cumulative artifact coverage",
      ok: true,
    });
    expect(scheduler.consume()).toBe("evidence_conflict");
  });
});
