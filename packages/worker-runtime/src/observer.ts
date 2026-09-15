import { canonicalJson } from "@traceforge/orchestration-core";
import { createHash } from "node:crypto";
import type { WorkerObserver, WorkerObserverDecision, WorkerObserverSnapshot } from "./model.js";

export interface LoopGuardOptions {
  steerAfterRepeats: number;
  stopAfterRepeats: number;
}

export class LoopGuardObserver implements WorkerObserver {
  private readonly fingerprints = new Map<string, { fingerprint: string; repeats: number }>();

  constructor(private readonly options: LoopGuardOptions = { steerAfterRepeats: 2, stopAfterRepeats: 4 }) {
    if (options.steerAfterRepeats < 1 || options.stopAfterRepeats <= options.steerAfterRepeats) {
      throw new Error("Observer stop threshold must be greater than its steering threshold");
    }
  }

  async review(snapshot: WorkerObserverSnapshot): Promise<WorkerObserverDecision> {
    if (snapshot.repeatedFailureCount >= this.options.stopAfterRepeats) {
      return { action: "stop", reason: "Observer stopped a branch with repeated execution failures" };
    }
    if (snapshot.decision.type !== "invoke_tool") return { action: "continue" };
    if (snapshot.repeatableRead) return { action: "continue" };
    const key = `${snapshot.assignment.runId}:${snapshot.assignment.work.id}`;
    const fingerprint = createHash("sha256").update(canonicalJson({ tool: snapshot.decision.invocation.tool, input: snapshot.decision.invocation.input })).digest("hex");
    const previous = snapshot.longTask ? snapshot.longTask.loopGuard : this.fingerprints.get(key);
    const repeats = previous?.fingerprint === fingerprint ? previous.repeats + 1 : 1;
    if (snapshot.longTask) snapshot.longTask.loopGuard = { fingerprint, repeats };
    else this.fingerprints.set(key, { fingerprint, repeats });
    if (repeats >= this.options.stopAfterRepeats) {
      return { action: "stop", reason: `Observer stopped repeated identical action ${snapshot.decision.invocation.tool}` };
    }
    if (repeats >= this.options.steerAfterRepeats) {
      return { action: "steer", instruction: `Do not repeat ${snapshot.decision.invocation.tool} with the same input; reassess facts, evidence gaps, and alternatives.` };
    }
    return { action: "continue" };
  }
}
