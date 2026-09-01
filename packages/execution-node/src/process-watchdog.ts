import type { Writable } from "node:stream";
import { setMaxListeners } from "node:events";

export interface ProcessWatchdogOptions {
  startupTimeoutMs: number;
  operationTimeoutMs: number;
  shutdownTimeoutMs: number;
}

export function processWatchdogOptions(options: Partial<ProcessWatchdogOptions> = {}): ProcessWatchdogOptions {
  const result = { startupTimeoutMs: 10_000, operationTimeoutMs: 5_000, shutdownTimeoutMs: 10_000, ...options };
  for (const [key, value] of Object.entries(result)) validateDeadline(value, key);
  return result;
}

export function validateDeadline(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 0x7fff_ffff) {
    throw new Error(`${label} must be a positive timer-safe integer`);
  }
}

/** Bounds policy preparation too. Late resolution never causes the caller to dispatch a process. */
export async function prepareProcessLaunch<T>(prepare: () => T | Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(prepare),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Process launch preparation timed out")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Host-side liveness protection. A deadline failure is never proof of OS process-tree cleanup. */
export class ProcessWatchdog {
  private readonly controller = new AbortController();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly startupTimer: ReturnType<typeof setTimeout>;
  private shutdownStarted = false;
  private settled = false;
  private operations = 0;

  constructor(
    private readonly options: ProcessWatchdogOptions,
    executionTimeoutMs: number,
    private readonly onFailure: (error: Error) => void,
  ) {
    validateDeadline(executionTimeoutMs, "Execution timeout");
    // At most three abort listeners per tracked PTY operation, plus lifecycle listeners.
    setMaxListeners(196, this.controller.signal);
    this.startupTimer = this.arm(options.startupTimeoutMs, "Process startup timed out");
    this.arm(executionTimeoutMs, "Process execution deadline exceeded");
  }

  started(): void { this.cancel(this.startupTimer); }

  beginShutdown(): void {
    if (this.settled || this.shutdownStarted) return;
    this.shutdownStarted = true;
    this.arm(this.options.shutdownTimeoutMs, "Process shutdown or pipe drain timed out");
  }

  async operation<T>(label: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const signal = this.controller.signal;
    signal.throwIfAborted();
    if (this.operations >= 64) throw new Error("Process control capacity is exhausted");
    this.operations++;
    const timer = this.arm(this.options.operationTimeoutMs, `Process ${label} timed out`);
    let onAbort: () => void = () => undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(() => { signal.throwIfAborted(); return operation(signal); }),
        new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(signal.reason);
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      this.operations--;
      this.cancel(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }

  fail(error: Error): void {
    if (this.settled) return;
    this.dispose(error);
    this.onFailure(error);
  }

  dispose(reason = new Error("Process transport closed")): void {
    if (this.settled) return;
    this.settled = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.controller.abort(reason);
  }

  private arm(ms: number, message: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => this.fail(new Error(message)), ms);
    this.timers.add(timer);
    return timer;
  }

  private cancel(timer: ReturnType<typeof setTimeout>): void {
    clearTimeout(timer);
    this.timers.delete(timer);
  }
}

/** Waits for the actual write callback; cancellation removes all per-operation listeners. */
export function writeProcessPipe(stream: Writable, data: Buffer | null, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error | null) => {
      cleanup();
      if (error) reject(error); else resolve();
    };
    const onAbort = () => finish(signal.reason);
    const onClose = () => finish(new Error("Process input pipe closed before write completion"));
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
      stream.off("error", finish);
      stream.off("close", onClose);
    };
    if (signal.aborted) { finish(signal.reason); return; }
    if (stream.destroyed || !stream.writable) { finish(new Error("Process input pipe is closed")); return; }
    signal.addEventListener("abort", onAbort, { once: true });
    stream.once("error", finish);
    stream.once("close", onClose);
    try {
      if (data === null) stream.end(() => finish());
      else stream.write(data, finish);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
