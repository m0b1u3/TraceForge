import type { WorkerRunResult } from "./runtime.js";
import type { ScenarioRunState } from "@traceforge/orchestration-core";

export interface PollableLeaseWorker {
  register(): Promise<void>;
  pollOnce(): Promise<WorkerRunResult | undefined>;
  cancelAll?(reason?: string): void;
  reconcileRun?(run: ScenarioRunState): void;
}

export type WorkerSupervisorEvent =
  | { type: "started" }
  | { type: "idle" }
  | { type: "work_finished"; result: WorkerRunResult }
  | { type: "poll_failed"; error: string }
  | { type: "stopped" };

export interface WorkerSupervisorOptions {
  pollIntervalMs: number;
  errorBackoffMs: number;
  onEvent?: (event: WorkerSupervisorEvent) => void;
}

export class WorkerSupervisor {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private activePoll: Promise<void> | undefined;

  constructor(
    private readonly runtime: PollableLeaseWorker,
    private readonly options: WorkerSupervisorOptions,
  ) {
    if (options.pollIntervalMs < 100 || options.errorBackoffMs < options.pollIntervalMs) {
      throw new Error("Worker supervisor requires a poll interval of at least 100ms and an equal or longer error backoff");
    }
  }

  async start(): Promise<void> {
    if (this.running) return;
    await this.runtime.register();
    this.running = true;
    this.options.onEvent?.({ type: "started" });
    this.schedule(0);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.runtime.cancelAll?.("Worker supervisor stopping");
    await this.activePoll;
    this.options.onEvent?.({ type: "stopped" });
  }

  isRunning(): boolean {
    return this.running;
  }

  reconcileRun(run: ScenarioRunState): void { this.runtime.reconcileRun?.(run); }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.activePoll = this.poll().finally(() => { this.activePoll = undefined; });
    }, delayMs);
    this.timer.unref();
  }

  private async poll(): Promise<void> {
    let delay = this.options.pollIntervalMs;
    try {
      const result = await this.runtime.pollOnce();
      this.options.onEvent?.(result ? { type: "work_finished", result } : { type: "idle" });
    } catch (error) {
      delay = this.options.errorBackoffMs;
      this.options.onEvent?.({ type: "poll_failed", error: error instanceof Error ? error.message : "Unknown worker poll failure" });
    } finally {
      this.schedule(delay);
    }
  }
}
