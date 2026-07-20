import { createHash } from "node:crypto";
import type { ObserverWarning } from "@traceforge/shared";

export type ObserverActiveStatus = Extract<ObserverWarning["status"], "detected" | "correcting" | "escalated">;

export function observerFingerprint(
  warning: Pick<ObserverWarning, "title" | "relatedFacts" | "relatedTasks">,
): string {
  const material = [
    warning.title.trim().toLowerCase().replace(/\s+/g, " "),
    [...warning.relatedFacts].sort().join(","),
    [...warning.relatedTasks].sort().join(","),
  ].join("|");
  return createHash("sha256").update(material).digest("hex").slice(0, 24);
}

export function validatedObserverLevel(
  warning: Pick<ObserverWarning, "level" | "evidence" | "relatedFacts" | "relatedTasks">,
  validFactIds: ReadonlySet<string>,
  validTaskIds: ReadonlySet<string>,
): ObserverWarning["level"] {
  if (warning.level !== "critical") return warning.level;
  const references = [...warning.relatedFacts, ...warning.relatedTasks];
  const referencesValid = references.length > 0
    && warning.relatedFacts.every((id) => validFactIds.has(id))
    && warning.relatedTasks.every((id) => validTaskIds.has(id));
  return warning.evidence?.trim() && referencesValid ? "critical" : "warning";
}

export function nextObserverStatus(
  current: ObserverWarning["status"],
  level: ObserverWarning["level"],
): ObserverActiveStatus {
  if (current === "escalated") return "escalated";
  if (level !== "critical") return "detected";
  return current === "correcting" ? "escalated" : "correcting";
}

export function observerIntervention(
  warning: Pick<ObserverWarning, "status" | "title" | "suggestedGoal" | "suggestedAction">,
): { steering?: string; pauseReason?: string } {
  if (warning.status === "correcting") {
    return { steering: warning.suggestedGoal || warning.suggestedAction };
  }
  if (warning.status === "escalated") {
    return { pauseReason: `escalated observer warning: ${warning.title}` };
  }
  return {};
}
