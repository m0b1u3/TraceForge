import { randomUUID } from "node:crypto";
import type { AgentRun } from "@traceforge/shared";

export interface ActiveAgentRun {
  run: AgentRun;
  abortController: AbortController;
  steeringQueue: string[];
}

function now(): string {
  return new Date().toISOString();
}

function terminal(status: AgentRun["status"]): boolean {
  return status === "completed" || status === "failed" || status === "interrupted";
}

export class AgentRunRegistry {
  private runs = new Map<string, ActiveAgentRun>();
  private activeByCase = new Map<string, string>();

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
        error: null,
      },
      abortController: new AbortController(),
      steeringQueue: [],
    };
    this.runs.set(active.run.id, active);
    this.activeByCase.set(caseId, active.run.id);
    return active;
  }

  get(runId: string): ActiveAgentRun | undefined {
    return this.runs.get(runId);
  }

  getActiveByCase(caseId: string): ActiveAgentRun | undefined {
    const id = this.activeByCase.get(caseId);
    return id ? this.runs.get(id) : undefined;
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

  interrupt(runId: string, reason = "user interrupted"): AgentRun | undefined {
    const active = this.runs.get(runId);
    if (!active) return undefined;
    if (terminal(active.run.status)) return active.run;
    active.run = { ...active.run, status: "interrupting", interruptReason: reason };
    active.abortController.abort(reason);
    active.run = active.run;
    return active.run;
  }

  markInterrupted(runId: string, reason = "user interrupted"): AgentRun | undefined {
    const active = this.runs.get(runId);
    if (!active) return undefined;
    active.run = { ...active.run, status: "interrupted", interruptReason: reason, finishedAt: now() };
    this.activeByCase.delete(active.run.caseId);
    return active.run;
  }

  complete(runId: string): AgentRun | undefined {
    const active = this.runs.get(runId);
    if (!active) return undefined;
    active.run = { ...active.run, status: "completed", finishedAt: now() };
    this.activeByCase.delete(active.run.caseId);
    return active.run;
  }

  fail(runId: string, error: string): AgentRun | undefined {
    const active = this.runs.get(runId);
    if (!active) return undefined;
    active.run = { ...active.run, status: "failed", error, finishedAt: now() };
    this.activeByCase.delete(active.run.caseId);
    return active.run;
  }
}
