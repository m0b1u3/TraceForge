import { describe, expect, it } from "vitest";
import { WorkerSupervisor, type WorkerSupervisorEvent } from "./supervisor.js";

describe("WorkerSupervisor", () => {
  it("registers, polls without overlap, and stops cleanly", async () => {
    let registered = 0;
    let polls = 0;
    let active = 0;
    let maximumActive = 0;
    const events: WorkerSupervisorEvent[] = [];
    const supervisor = new WorkerSupervisor({
      async register() { registered += 1; },
      async pollOnce() {
        polls += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return undefined;
      },
    }, { pollIntervalMs: 100, errorBackoffMs: 200, onEvent: (event) => events.push(event) });
    await supervisor.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await supervisor.stop();
    expect(registered).toBe(1);
    expect(polls).toBeGreaterThanOrEqual(1);
    expect(maximumActive).toBe(1);
    expect(supervisor.isRunning()).toBe(false);
    expect(events.map((event) => event.type)).toContain("stopped");
  });
});
