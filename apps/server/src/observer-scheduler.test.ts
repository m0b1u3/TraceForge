import { describe, expect, it } from "vitest";
import { ObserverScheduler } from "./observer-scheduler.js";

describe("ObserverScheduler event policy", () => {
  it("does not review ordinary successful tool turns", () => {
    const scheduler = new ObserverScheduler();
    scheduler.observe({ name: "list_traffic", input: {}, content: "[]", ok: true, risk: "normal" });
    expect(scheduler.consume()).toBeNull();
  });

  it("waits for repeated permanent failures instead of interrupting on the first failure", () => {
    const scheduler = new ObserverScheduler();
    scheduler.observe({
      name: "probe",
      input: { path: "/a" },
      content: "invalid payload",
      ok: false,
      failureClass: "permanent",
    });
    expect(scheduler.consume()).toBeNull();

    scheduler.observe({
      name: "probe",
      input: { path: "/b" },
      content: "invalid payload",
      ok: false,
      failureClass: "permanent",
    });
    expect(scheduler.consume()).toBe("repeated_failure");
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

  it("marks successful command execution as a high-risk review event", () => {
    const scheduler = new ObserverScheduler();
    scheduler.observe({ name: "exec_command", input: {}, content: "done", ok: true, risk: "command" });
    expect(scheduler.consume()).toBe(null);
  });

  it("reviews validated and invalidated attack paths as evidence events", () => {
    const scheduler = new ObserverScheduler();
    scheduler.observe({ name: "record_attack_path", input: {}, content: JSON.stringify({ status: "validated" }), ok: true });
    expect(scheduler.consume()).toBe("finding_verification");
    scheduler.observe({ name: "record_attack_path", input: {}, content: JSON.stringify({ status: "invalidated" }), ok: true });
    expect(scheduler.consume()).toBe("evidence_conflict");
  });
});
