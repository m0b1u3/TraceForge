import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProcessWatchdog, prepareProcessLaunch, processWatchdogOptions, writeProcessPipe } from "./process-watchdog.js";

afterEach(() => vi.useRealTimers());
const options = processWatchdogOptions({ startupTimeoutMs: 50, operationTimeoutMs: 30, shutdownTimeoutMs: 40 });

describe("host process watchdog", () => {
  it("rejects invalid deadlines rather than letting Node clamp them to one millisecond", () => {
    for (const value of [0, -1, NaN, Infinity, 0.5, 0x8000_0000]) {
      expect(() => processWatchdogOptions({ shutdownTimeoutMs: value })).toThrow(/timer-safe/);
    }
  });

  it("does not extend shutdown when more shutdown signals arrive", async () => {
    vi.useFakeTimers();
    const failed = vi.fn();
    const watchdog = new ProcessWatchdog(options, 1000, failed);
    watchdog.started(); watchdog.beginShutdown();
    await vi.advanceTimersByTimeAsync(25);
    watchdog.beginShutdown();
    await vi.advanceTimersByTimeAsync(15);
    expect(failed).toHaveBeenCalledOnce();
    expect(failed.mock.calls[0]![0].message).toMatch(/shutdown/);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the execution deadline active even after startup completes", async () => {
    vi.useFakeTimers();
    const failed = vi.fn();
    const watchdog = new ProcessWatchdog(options, 80, failed);
    watchdog.started();
    await vi.advanceTimersByTimeAsync(80);
    expect(failed.mock.calls[0]![0].message).toMatch(/execution deadline/);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects all pending operations and removes pipe listeners on a stalled write", async () => {
    vi.useFakeTimers();
    const stream = new Writable({ write() { /* intentionally never completes */ } });
    const failed = vi.fn();
    const watchdog = new ProcessWatchdog(options, 1000, failed);
    watchdog.started();
    const first = watchdog.operation("write", (signal) => writeProcessPipe(stream, Buffer.alloc(100_000), signal));
    const second = watchdog.operation("control", () => new Promise<void>(() => undefined));
    const outcomes = Promise.allSettled([first, second]);
    await vi.advanceTimersByTimeAsync(30);
    expect((await outcomes).map((entry) => entry.status)).toEqual(["rejected", "rejected"]);
    expect(failed).toHaveBeenCalledOnce();
    expect(stream.listenerCount("close")).toBe(0);
    expect(stream.listenerCount("error")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    stream.destroy();
  });

  it("rejects a write when a pipe closes without drain or an error event", async () => {
    const stream = new Writable({ write() {} });
    const controller = new AbortController();
    const write = writeProcessPipe(stream, Buffer.alloc(32), controller.signal);
    const assertion = expect(write).rejects.toThrow(/closed before write/);
    stream.destroy();
    await assertion;
    expect(stream.listenerCount("close")).toBe(0);
    expect(stream.listenerCount("error")).toBe(0);
  });

  it("clears deadlines on successful disposal and does not fail later", async () => {
    vi.useFakeTimers();
    const failed = vi.fn();
    const watchdog = new ProcessWatchdog(options, 1000, failed);
    watchdog.started(); watchdog.beginShutdown(); watchdog.dispose();
    await vi.advanceTimersByTimeAsync(2000);
    expect(failed).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await expect(watchdog.operation("late write", async () => undefined)).rejects.toThrow(/closed/);
  });

  it("does not dispatch a timed-out preparation when it eventually resolves", async () => {
    vi.useFakeTimers();
    let resolvePreparation!: (value: string) => void;
    const dispatch = vi.fn();
    const prepared = prepareProcessLaunch(() => new Promise<string>((resolve) => { resolvePreparation = resolve; }), 50).then(dispatch);
    const assertion = expect(prepared).rejects.toThrow(/preparation timed out/);
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    resolvePreparation("late launch spec");
    await vi.advanceTimersByTimeAsync(10);
    expect(dispatch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
