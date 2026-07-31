import type { ArtifactRecord, Fact, RuntimeEvent, Task, TimelineEntry } from "@traceforge/shared";
import type { FactStore } from "./stores/fact-store.js";
import type { TaskStore } from "./stores/task-store.js";
import type { TimelineStore } from "./stores/timeline-store.js";

type LifecycleEvent =
  | Extract<RuntimeEvent, { type: "fact_updated" }>
  | Extract<RuntimeEvent, { type: "task_updated" }>
  | Extract<RuntimeEvent, { type: "timeline_appended" }>;

export interface ArtifactEvidenceLifecycleResult {
  task?: Task;
  facts: Fact[];
  timelineEntry?: TimelineEntry;
  runtimeMessage?: string;
}

export function connectArtifactEvidenceLifecycle(input: {
  runId: string;
  artifact: ArtifactRecord;
  artifactFacts: Fact[];
  facts: FactStore;
  tasks: TaskStore;
  timeline: TimelineStore;
  emit: (event: LifecycleEvent) => void;
}): ArtifactEvidenceLifecycleResult {
  const { artifact } = input;
  const artifactFacts = input.artifactFacts.filter((fact) =>
    fact.caseId === artifact.caseId
    && fact.source.type === "artifact_analysis"
    && fact.source.ref === artifact.id);
  if (artifact.status !== "analyzed" || artifactFacts.length === 0) {
    return { facts: artifactFacts };
  }

  const runningTasks = input.tasks.listByCase(artifact.caseId).filter((task) =>
    task.runId === input.runId && task.status === "running");
  if (runningTasks.length !== 1) return { facts: artifactFacts };
  const runningTask = runningTasks[0];

  const factIds = artifactFacts.map((fact) => fact.id);
  const nextRelatedFacts = [...new Set([...runningTask.relatedFacts, ...factIds])];
  const linkedTask = nextRelatedFacts.length === runningTask.relatedFacts.length
    ? runningTask
    : input.tasks.update(runningTask.id, { relatedFacts: nextRelatedFacts });
  if (!linkedTask) return { facts: artifactFacts };

  const linkedFacts = artifactFacts.map((fact) => {
    if (fact.taskIds?.includes(linkedTask.id)) return fact;
    const updated = input.facts.update(fact.id, {
      taskIds: [...new Set([...(fact.taskIds ?? []), linkedTask.id])],
    });
    if (updated) input.emit({ type: "fact_updated", fact: updated });
    return updated ?? fact;
  });

  const changed = linkedTask.updateCount !== runningTask.updateCount
    || linkedFacts.some((fact, index) => fact.updateCount !== artifactFacts[index]?.updateCount);
  if (!changed) return { task: linkedTask, facts: linkedFacts };

  if (linkedTask.updateCount !== runningTask.updateCount) {
    input.emit({ type: "task_updated", task: linkedTask });
  }
  const timelineEntry = input.timeline.append(
    artifact.caseId,
    "artifact_evidence_linked",
    `Artifact=${artifact.id}; task=${linkedTask.id}; facts=${factIds.join(",")}; findings=${artifact.analysis?.findings.length ?? 0}`,
    linkedTask.id,
    input.runId,
  );
  input.emit({ type: "timeline_appended", entry: timelineEntry });

  const findingCount = artifact.analysis?.findings.length ?? 0;
  const runtimeMessage = [
    `Artifact ${artifact.id} analysis is complete and its evidence is attached to the current Task ${linkedTask.id}.`,
    `Evidence Facts: ${factIds.join(", ")}. Recovered candidates: ${findingCount}.`,
    findingCount > 0
      ? "Continue this same Task using the recovered values and their relationship evidence. Do not start another queued Task until this Task is completed, blocked, rejected, or explicitly released."
      : "The analysis coverage and limitations are evidence, but no recovered candidate is not proof of absence. Continue this same Task by addressing the remaining evidence gap or explicitly release/block it before moving on.",
  ].join("\n");
  return { task: linkedTask, facts: linkedFacts, timelineEntry, runtimeMessage };
}
