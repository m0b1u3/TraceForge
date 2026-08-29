export interface CognitiveLoopTimerPort {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
  unref?(handle: unknown): void;
}

export interface CognitiveLoopSchedulerOptions {
  tick: () => Promise<void> | void;
  nextPollDelayMs: () => number;
  errorBackoffMs: number;
  onError?: (error: unknown) => void;
  timers?: CognitiveLoopTimerPort;
}

const systemTimers: CognitiveLoopTimerPort = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  unref: (handle) => (handle as ReturnType<typeof setTimeout>).unref(),
};

/**
 * Owns the timing and concurrency lifecycle of one cognitive consumer. Run
 * discovery, evaluation and decision policy remain inside the injected tick.
 */
export class CognitiveLoopScheduler {
  private readonly timers: CognitiveLoopTimerPort;
  private timer: unknown;
  private running = false;
  private activeTick: Promise<void> | undefined;
  private wakeRequested = false;

  constructor(private readonly options: CognitiveLoopSchedulerOptions) {
    if (!Number.isFinite(options.errorBackoffMs) || options.errorBackoffMs < 0) {
      throw new Error("Cognitive loop error backoff must be a non-negative finite number");
    }
    this.timers = options.timers ?? systemTimers;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  wake(): void {
    if (!this.running) return;
    if (this.activeTick) {
      this.wakeRequested = true;
      return;
    }
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wakeRequested = false;
    this.cancelTimer();
    await this.activeTick;
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    this.cancelTimer();
    const handle = this.timers.set(() => {
      if (this.timer !== handle) return;
      this.timer = undefined;
      this.executeTick();
    }, this.delay(delayMs));
    this.timer = handle;
    this.timers.unref?.(handle);
  }

  private executeTick(): void {
    if (!this.running || this.activeTick) return;
    let failed = false;
    this.activeTick = Promise.resolve()
      .then(this.options.tick)
      .catch((error) => {
        failed = true;
        this.report(error);
      })
      .finally(() => {
        this.activeTick = undefined;
        if (!this.running) return;
        if (this.wakeRequested) {
          this.wakeRequested = false;
          this.schedule(0);
          return;
        }
        if (failed) {
          this.schedule(this.options.errorBackoffMs);
          return;
        }
        try {
          this.schedule(this.options.nextPollDelayMs());
        } catch (error) {
          this.report(error);
          this.schedule(this.options.errorBackoffMs);
        }
      });
  }

  private cancelTimer(): void {
    if (this.timer === undefined) return;
    this.timers.clear(this.timer);
    this.timer = undefined;
  }

  private delay(value: number): number {
    if (!Number.isFinite(value) || value < 0) throw new Error("Cognitive loop delay must be a non-negative finite number");
    return value;
  }

  private report(error: unknown): void {
    try {
      this.options.onError?.(error);
    } catch {
      // Error reporting cannot break scheduler ownership or draining.
    }
  }
}
