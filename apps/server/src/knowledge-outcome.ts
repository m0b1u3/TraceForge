import type { ToolExecutionReport } from "@traceforge/extension";
import type { KnowledgeRef } from "./stores/knowledge-usage-store.js";

export interface KnowledgeOutcome {
  positive: number;
  negative: number;
  reason: string;
}

const neutral = (reason: string): KnowledgeOutcome => ({ positive: 0, negative: 0, reason });

export function classifyKnowledgeOutcome(report: ToolExecutionReport): KnowledgeOutcome {
  if (!report.ok) {
    if (report.rejected || report.blocked || report.transient || report.failureClass !== "permanent") {
      return neutral("non-conclusive tool result");
    }
    return { positive: 0, negative: 1, reason: "permanent tool failure" };
  }

  const input = (report.input ?? {}) as Record<string, unknown>;
  if (report.name === "assess_validation_experiment" || report.name === "record_validation_conclusion") {
    try {
      const parsed = JSON.parse(report.content) as { verdict?: string; conclusion?: { verdict?: string } };
      const verdict = parsed.verdict ?? parsed.conclusion?.verdict;
      if (verdict === "supports" || verdict === "refutes") {
        return { positive: 2, negative: 0, reason: `validation experiment ${verdict}` };
      }
    } catch {
      return neutral("validation assessment was not structured");
    }
  }
  if (report.name === "record_fact") {
    if (input.type === "finding" && input.findingStatus === "verified") {
      return { positive: 3, negative: 0, reason: "verified finding" };
    }
    if (input.type === "finding" && input.findingStatus === "rejected") {
      return { positive: 1, negative: 0, reason: "rejected finding resolved uncertainty" };
    }
    if (input.observation && typeof input.observation === "object") {
      return { positive: 1, negative: 0, reason: "evidence observation recorded" };
    }
  }
  if (report.name === "record_attack_path" && input.status === "validated") {
    return { positive: 3, negative: 0, reason: "validated attack path" };
  }
  if (report.name === "resolve_hypothesis" && (input.status === "confirmed" || input.status === "refuted")) {
    return { positive: 2, negative: 0, reason: `hypothesis ${String(input.status)}` };
  }
  if (report.name === "record_task" && input.status === "done") {
    return { positive: 1, negative: 0, reason: "investigation task completed" };
  }
  return neutral("no verified investigation outcome");
}

export class KnowledgeOutcomeTracker {
  private readonly pending = new Map<string, KnowledgeRef>();
  private readonly maxPending = 12;

  observeReferences(refs: KnowledgeRef[]): void {
    for (const ref of refs) {
      const key = `${ref.kind}:${ref.id}`;
      this.pending.delete(key);
      this.pending.set(key, ref);
      while (this.pending.size > this.maxPending) {
        const oldest = this.pending.keys().next().value as string | undefined;
        if (!oldest) break;
        this.pending.delete(oldest);
      }
    }
  }

  settle(report: ToolExecutionReport, directlyReferenced: KnowledgeRef[]): {
    refs: KnowledgeRef[];
    outcome: KnowledgeOutcome;
  } {
    this.observeReferences(directlyReferenced);
    const outcome = classifyKnowledgeOutcome(report);
    if (outcome.positive <= 0 && outcome.negative <= 0) return { refs: [], outcome };

    const refs = outcome.negative > 0
      ? directlyReferenced
      : [...this.pending.values()];
    if (outcome.positive > 0) this.pending.clear();
    if (outcome.negative > 0) {
      for (const ref of directlyReferenced) this.pending.delete(`${ref.kind}:${ref.id}`);
    }
    return { refs, outcome };
  }
}
