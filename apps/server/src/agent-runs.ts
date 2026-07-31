import { randomUUID } from "node:crypto";
import type { AgentRun, AgentRunUsage } from "@traceforge/shared";
import type { AgentRunStore } from "./stores/agent-run-store.js";

export interface ActiveAgentRun {
  run: AgentRun;
  abortController: AbortController;
  steeringQueue: string[];
  runtimeMessageQueue: string[];
}

function now(): string {
  return new Date().toISOString();
}

function terminal(status: AgentRun["status"]): boolean {
  return status === "completed" || status === "failed" || status === "interrupted" || status === "needs_continuation";
}

export function isContinuationGoal(goal: string): boolean {
  return /^(?:继续|继续执行|继续调查|continue|resume|go on)[.!。！\s]*$/i.test(goal.trim());
}

export class AgentRunRegistry {
  private runs = new Map<string, ActiveAgentRun>();
  private activeByCase = new Map<string, string>();
  private latestByCase = new Map<string, string>();
  private usageByRun = new Map<string, AgentRunUsage[]>();

  constructor(private store?: AgentRunStore) {
    this.restorePersistedRuns();
  }

  start(caseId: string, goal: string): ActiveAgentRun {
    const existing = this.getActiveByCase(caseId);
    if (existing && !terminal(existing.run.status)) throw new Error(`case ${caseId} already has an active run`);
    const createdAt = now();
    const active: ActiveAgentRun = {
      run: {
        id: `run_${randomUUID()}`,
        caseId,
        goal,
        status: "running",
        createdAt,
        startedAt: createdAt,
        finishedAt: null,
        interruptReason: null,
        completionReason: null,
        error: null,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      },
      abortController: new AbortController(),
      steeringQueue: [],
      runtimeMessageQueue: [],
    };
    this.runs.set(active.run.id, active);
    this.activeByCase.set(caseId, active.run.id);
    this.latestByCase.set(caseId, active.run.id);
    this.store?.save(active.run);
    return active;
  }

  get(runId: string): ActiveAgentRun | undefined {
    return this.runs.get(runId);
  }

  getActiveByCase(caseId: string): ActiveAgentRun | undefined {
    const id = this.activeByCase.get(caseId);
    return id ? this.runs.get(id) : undefined;
  }

  getLatestByCase(caseId: string): ActiveAgentRun | undefined {
    const id = this.latestByCase.get(caseId);
    return id ? this.runs.get(id) : undefined;
  }

  getLatestSubstantiveGoal(caseId: string): string | undefined {
    return [...this.runs.values()]
      .filter((entry) => entry.run.caseId === caseId && !isContinuationGoal(entry.run.goal))
      .sort((left, right) => left.run.createdAt.localeCompare(right.run.createdAt))
      .at(-1)?.run.goal;
  }

  addSteering(runId: string, text: string): AgentRun | undefined {
    const active = this.runs.get(runId);
    if (!active || terminal(active.run.status)) return undefined;
    active.steeringQueue.push(text);
    return active.run;
  }

  consumeSteering(runId: string): string[] {
    const active = this.runs.get(runId);
    if (!active) return [];
    const queued = active.steeringQueue.splice(0);
    return queued;
  }

  addRuntimeMessage(runId: string, text: string): AgentRun | undefined {
    const active = this.runs.get(runId);
    if (!active || terminal(active.run.status)) return undefined;
    const message = text.trim();
    if (!message || active.runtimeMessageQueue.includes(message)) return active.run;
    active.runtimeMessageQueue.push(message);
    return active.run;
  }

  consumeRuntimeMessages(runId: string): string[] {
    const active = this.runs.get(runId);
    if (!active) return [];
    return active.runtimeMessageQueue.splice(0);
  }

  addUsage(
    runId: string,
    usage: Pick<AgentRunUsage, "promptTokens" | "completionTokens" | "totalTokens">
      & Partial<Pick<AgentRunUsage, "source" | "currency" | "inputCostMicros" | "outputCostMicros" | "totalCostMicros">>,
  ): { run: AgentRun; usage: AgentRunUsage } | undefined {
    const active = this.runs.get(runId);
    if (!active) return undefined;
    active.run = {
      ...active.run,
      promptTokens: active.run.promptTokens + usage.promptTokens,
      completionTokens: active.run.completionTokens + usage.completionTokens,
      totalTokens: active.run.totalTokens + usage.totalTokens,
    };
    this.store?.save(active.run);
    const entries = this.usageByRun.get(runId) ?? [];
    const usageWithCost = {
      ...usage,
      source: usage.source ?? "agent",
      currency: usage.currency ?? null,
      inputCostMicros: usage.inputCostMicros ?? null,
      outputCostMicros: usage.outputCostMicros ?? null,
      totalCostMicros: usage.totalCostMicros ?? null,
    };
    const entry = this.store?.appendUsage(active.run, usageWithCost) ?? {
      id: `usage_${randomUUID()}`,
      runId,
      caseId: active.run.caseId,
      turn: entries.length + 1,
      ...usageWithCost,
      createdAt: now(),
    };
    entries.push(entry);
    this.usageByRun.set(runId, entries);
    return { run: active.run, usage: entry };
  }

  interrupt(runId: string, reason = "user interrupted"): AgentRun | undefined {
    const active = this.runs.get(runId);
    if (!active) return undefined;
    if (terminal(active.run.status)) return active.run;
    active.run = { ...active.run, status: "interrupting", interruptReason: reason };
    active.abortController.abort(reason);
    active.run = active.run;
    this.store?.save(active.run);
    return active.run;
  }

  markInterrupted(runId: string, reason = "user interrupted"): AgentRun | undefined {
    return this.finish(runId, { status: "interrupted", interruptReason: reason, completionReason: reason });
  }

  needsContinuation(runId: string, reason: string): AgentRun | undefined {
    return this.finish(runId, { status: "needs_continuation", completionReason: reason });
  }

  complete(runId: string, reason = "completed normally"): AgentRun | undefined {
    return this.finish(runId, { status: "completed", completionReason: reason });
  }

  fail(runId: string, error: string): AgentRun | undefined {
    return this.finish(runId, { status: "failed", error, completionReason: error });
  }

  getUsage(runId: string): AgentRunUsage[] {
    return [...(this.usageByRun.get(runId) ?? [])];
  }

  clearCase(caseId: string): void {
    for (const [runId, active] of this.runs) {
      if (active.run.caseId === caseId) {
        this.runs.delete(runId);
        this.usageByRun.delete(runId);
      }
    }
    this.activeByCase.delete(caseId);
    this.latestByCase.delete(caseId);
    this.store?.deleteByCase(caseId);
  }

  private finish(
    runId: string,
    patch: Partial<Pick<AgentRun, "error" | "interruptReason" | "completionReason">> & Pick<AgentRun, "status">,
  ): AgentRun | undefined {
    const active = this.runs.get(runId);
    if (!active) return undefined;
    active.run = {
      ...active.run,
      ...patch,
      finishedAt: now(),
      completionReason: patch.completionReason ?? active.run.completionReason,
    };
    if (terminal(active.run.status)) this.activeByCase.delete(active.run.caseId);
    this.store?.save(active.run);
    return active.run;
  }

  private restorePersistedRuns(): void {
    if (!this.store) return;
    for (const persisted of this.store.listAll()) {
      let run = persisted;
      if (!terminal(run.status)) {
        const reason = "server restarted before the run completed";
        run = {
          ...run,
          status: "interrupted",
          finishedAt: now(),
          interruptReason: reason,
          completionReason: reason,
        };
        this.store.save(run);
      }
      this.runs.set(run.id, {
        run,
        abortController: new AbortController(),
        steeringQueue: [],
        runtimeMessageQueue: [],
      });
      this.usageByRun.set(run.id, this.store.listUsage(run.id));
      const previousId = this.latestByCase.get(run.caseId);
      const previous = previousId ? this.runs.get(previousId)?.run : undefined;
      if (!previous || previous.createdAt <= run.createdAt) this.latestByCase.set(run.caseId, run.id);
    }
  }
}
