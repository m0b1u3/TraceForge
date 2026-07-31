import { assessArtifactCoverage, type ArtifactRecord, type Fact, type RuntimeEvent, type Task, type TimelineEntry } from "@traceforge/shared";
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
  if (!["analyzed", "unsupported", "failed"].includes(artifact.status) || artifactFacts.length === 0) {
    return { facts: artifactFacts };
  }

  const runningTasks = input.tasks.listByCase(artifact.caseId).filter((task) =>
    task.runId === input.runId && task.status === "running");
  if (runningTasks.length !== 1) return { facts: artifactFacts };
  const runningTask = runningTasks[0];

  const assessment = assessArtifactCoverage(artifact);
  const factIds = artifactFacts.map((fact) => fact.id);
  const nextRelatedFacts = [...new Set([...runningTask.relatedFacts, ...factIds])];
  const coveragePrefix = `[Artifact coverage ${artifact.id}]`;
  const retainedTriggers = runningTask.triggerWhen.filter((trigger) => !trigger.startsWith(coveragePrefix));
  const nextTriggerWhen = assessment.followUpRequired
    ? [...retainedTriggers, `${coveragePrefix} ${assessment.nextAction}`]
    : retainedTriggers;
  const taskChanged = nextRelatedFacts.length !== runningTask.relatedFacts.length
    || nextTriggerWhen.length !== runningTask.triggerWhen.length
    || nextTriggerWhen.some((trigger, index) => trigger !== runningTask.triggerWhen[index]);
  const linkedTask = !taskChanged
    ? runningTask
    : input.tasks.update(runningTask.id, {
      relatedFacts: nextRelatedFacts,
      triggerWhen: nextTriggerWhen,
    });
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
    `Artifact=${artifact.id}; task=${linkedTask.id}; facts=${factIds.join(",")}; findings=${artifact.analysis?.findings.length ?? 0}; coverage=${assessment.quality}; missing=${assessment.missingDimensions.join(",") || "none"}; followUp=${assessment.followUpRequired}`,
    linkedTask.id,
    input.runId,
  );
  input.emit({ type: "timeline_appended", entry: timelineEntry });
  if (assessment.followUpRequired) {
    const gapEntry = input.timeline.append(
      artifact.caseId,
      "artifact_coverage_gap_recorded",
      `Artifact=${artifact.id}; Task=${linkedTask.id}; quality=${assessment.quality}; missing=${assessment.missingDimensions.join(",") || "none"}; limitations=${assessment.limitations.join(" | ") || "none"}`,
      linkedTask.id,
      input.runId,
    );
    input.emit({ type: "timeline_appended", entry: gapEntry });
  }

  const findingCount = assessment.findingCount;
  const runtimeMessage = [
    `Artifact ${artifact.id} analysis state is attached to the current Task ${linkedTask.id}.`,
    `Evidence Facts: ${factIds.join(", ")}. Recovered candidates: ${findingCount}.`,
    `Coverage quality: ${assessment.quality}. Missing dimensions: ${assessment.missingDimensions.join(", ") || "none"}. Limitations: ${assessment.limitations.join(" | ") || "none"}.`,
    findingCount > 0
      ? "Continue this same Task using the recovered values and their relationship evidence. Do not start another queued Task until this Task is completed, blocked, rejected, or explicitly released."
      : "No recovered candidate is not proof of absence. Continue this same Task by addressing the remaining evidence gap or explicitly retain the limitation before releasing it and moving on.",
  ].join("\n");
  return { task: linkedTask, facts: linkedFacts, timelineEntry, runtimeMessage };
}
