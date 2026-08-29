import { describe, expect, it } from "vitest";
import { CognitiveLoopScheduler, type CognitiveLoopTimerPort } from "./loop.js";

class ManualTimers implements CognitiveLoopTimerPort {
  private sequence = 0;
  private readonly entries = new Map<number, { callback: () => void; delayMs: number }>();
  readonly unrefed: number[] = [];

  set(callback: () => void, delayMs: number): unknown {
    const handle = ++this.sequence;
    this.entries.set(handle, { callback, delayMs });
    return handle;
  }

  clear(handle: unknown): void {
    this.entries.delete(handle as number);
  }

  unref(handle: unknown): void {
    this.unrefed.push(handle as number);
  }

  delays(): number[] {
    return [...this.entries.values()].map((entry) => entry.delayMs);
  }

  fireNext(): void {
    const entry = this.entries.entries().next().value as [number, { callback: () => void; delayMs: number }] | undefined;
    if (!entry) throw new Error("No scheduled timer");
    this.entries.delete(entry[0]);
    entry[1].callback();
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

describe("CognitiveLoopScheduler", () => {
  it("coalesces wakes during an active tick and never overlaps ticks", async () => {
    const timers = new ManualTimers();
    const first = deferred();
    let calls = 0;
    let active = 0;
    let maximumActive = 0;
    const scheduler = new CognitiveLoopScheduler({
      timers,
      errorBackoffMs: 500,
      nextPollDelayMs: () => 75,
      tick: async () => {
        calls += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        if (calls === 1) await first.promise;
        active -= 1;
      },
    });

    scheduler.start();
    expect(timers.delays()).toEqual([0]);
    timers.fireNext();
    await settle();
    scheduler.wake();
    scheduler.wake();
    scheduler.wake();
    expect(timers.delays()).toEqual([]);

    first.resolve();
    await settle();
    expect(timers.delays()).toEqual([0]);
    timers.fireNext();
    await settle();

    expect(calls).toBe(2);
    expect(maximumActive).toBe(1);
    expect(timers.delays()).toEqual([75]);
    await scheduler.stop();
  });

  it("replaces a pending poll with one immediate wake", () => {
    const timers = new ManualTimers();
    const scheduler = new CognitiveLoopScheduler({
      timers,
      errorBackoffMs: 500,
      nextPollDelayMs: () => 75,
      tick: () => undefined,
    });

    scheduler.start();
    scheduler.wake();
    scheduler.wake();

    expect(timers.delays()).toEqual([0]);
    expect(timers.unrefed).toHaveLength(3);
  });

  it("drains an active tick on stop without scheduling queued work", async () => {
    const timers = new ManualTimers();
    const active = deferred();
    const scheduler = new CognitiveLoopScheduler({
      timers,
      errorBackoffMs: 500,
      nextPollDelayMs: () => 75,
      tick: () => active.promise,
    });

    scheduler.start();
    timers.fireNext();
    await settle();
    scheduler.wake();
    const stopped = scheduler.stop();
    active.resolve();
    await stopped;

    expect(timers.delays()).toEqual([]);
    scheduler.wake();
    expect(timers.delays()).toEqual([]);
  });

  it("backs off after tick and poll-delay failures", async () => {
    const timers = new ManualTimers();
    const errors: unknown[] = [];
    let calls = 0;
    const scheduler = new CognitiveLoopScheduler({
      timers,
      errorBackoffMs: 400,
      nextPollDelayMs: () => {
        if (calls === 2) throw new Error("poll unavailable");
        return 75;
      },
      onError: (error) => { errors.push(error); },
      tick: () => {
        calls += 1;
        if (calls === 1) throw new Error("tick failed");
      },
    });

    scheduler.start();
    timers.fireNext();
    await settle();
    expect(timers.delays()).toEqual([400]);
    timers.fireNext();
    await settle();

    expect(errors.map((error) => (error as Error).message)).toEqual(["tick failed", "poll unavailable"]);
    expect(timers.delays()).toEqual([400]);
    await scheduler.stop();
  });

  it("rejects invalid backoff and poll delays", async () => {
    expect(() => new CognitiveLoopScheduler({
      tick: () => undefined,
      nextPollDelayMs: () => 1,
      errorBackoffMs: -1,
    })).toThrow("non-negative finite");

    const timers = new ManualTimers();
    const errors: unknown[] = [];
    const scheduler = new CognitiveLoopScheduler({
      timers,
      tick: () => undefined,
      nextPollDelayMs: () => Number.NaN,
      errorBackoffMs: 25,
      onError: (error) => { errors.push(error); },
    });
    scheduler.start();
    timers.fireNext();
    await settle();
    expect((errors[0] as Error).message).toContain("non-negative finite");
    expect(timers.delays()).toEqual([25]);
    await scheduler.stop();
  });
});
