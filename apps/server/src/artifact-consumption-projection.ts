import type { ArtifactConsumption, TimelineEntry } from "@traceforge/shared";

function fields(detail: string): Map<string, string> {
  const parsed = new Map<string, string>();
  for (const part of detail.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    parsed.set(part.slice(0, separator).trim().toLowerCase(), part.slice(separator + 1).trim());
  }
  return parsed;
}

function list(value?: string): string[] {
  return value ? value.split(",").map((item) => item.trim()).filter(Boolean) : [];
}

export function projectArtifactConsumptions(caseId: string, timeline: TimelineEntry[]): ArtifactConsumption[] {
  const projected = new Map<string, ArtifactConsumption>();
  for (const entry of timeline) {
    if (entry.caseId !== caseId) continue;
    const detail = fields(entry.detail);
    if (entry.eventType === "artifact_evidence_linked") {
      const artifactId = detail.get("artifact");
      const taskId = detail.get("task") ?? entry.refId ?? undefined;
      if (!artifactId || !taskId) continue;
      const key = `${artifactId}:${taskId}`;
      projected.set(key, {
        caseId,
        runId: entry.runId ?? null,
        artifactId,
        taskId,
        factIds: list(detail.get("facts")),
        status: "pending",
        usedByTool: null,
        missedActions: 0,
        updatedAt: entry.createdAt,
        lastEventId: entry.id,
      });
      continue;
    }

    const taskId = detail.get("task") ?? entry.refId ?? undefined;
    if (!taskId) continue;
    const eventFactIds = list(detail.get("facts"));
    const candidates = [...projected.values()].filter((item) =>
      item.taskId === taskId
      && (eventFactIds.length === 0 || eventFactIds.some((factId) => item.factIds.includes(factId))));
    for (const current of candidates) {
      if (entry.eventType === "evidence_consumed") {
        projected.set(`${current.artifactId}:${current.taskId}`, {
          ...current,
          status: "consumed",
          usedByTool: detail.get("tool") ?? null,
          updatedAt: entry.createdAt,
          lastEventId: entry.id,
        });
      } else if (entry.eventType === "evidence_consumption_replan_requested") {
        projected.set(`${current.artifactId}:${current.taskId}`, {
          ...current,
          status: "replan_requested",
          missedActions: Number(detail.get("missedactions") ?? 0) || 0,
          updatedAt: entry.createdAt,
          lastEventId: entry.id,
        });
      } else if (
        entry.eventType === "evidence_consumption_tracking_closed"
        && current.status !== "consumed"
      ) {
        projected.set(`${current.artifactId}:${current.taskId}`, {
          ...current,
          status: "closed",
          updatedAt: entry.createdAt,
          lastEventId: entry.id,
        });
      }
    }
  }
  return [...projected.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}
