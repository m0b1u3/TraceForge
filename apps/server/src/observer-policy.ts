import { createHash } from "node:crypto";
import type { ObserverIssueType, ObserverWarning } from "@traceforge/shared";

export type ObserverActiveStatus = Extract<ObserverWarning["status"], "detected" | "correcting" | "escalated">;

export function observerFingerprint(
  warning: Pick<ObserverWarning, "issueType" | "subject" | "title" | "relatedFacts" | "relatedTasks">,
): string {
  const normalize = (value: string) => value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_\u4e00-\u9fff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const issueType = warning.issueType || "other";
  const subject = normalize(warning.subject) || normalize(warning.title);
  const references = [
    ...warning.relatedFacts.map((id) => `fact:${id}`),
    ...warning.relatedTasks.map((id) => `task:${id}`),
  ].sort();
  const material = JSON.stringify({ issueType, subject, references });
  return createHash("sha256").update(material).digest("hex").slice(0, 24);
}

export function initialObserverStatus(level: ObserverWarning["level"]): ObserverActiveStatus {
  return level === "critical" ? "correcting" : "detected";
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
  warning: Pick<ObserverWarning, "level" | "status" | "title" | "suggestedGoal" | "suggestedAction">,
  options: { allowPause?: boolean } = {},
): { steering?: string; pauseReason?: string } {
  if (warning.level === "info") return {};
  const steering = (warning.suggestedGoal || warning.suggestedAction)
    .replace(/^\s*\[Observer correction\]\s*/i, "")
    .trim();
  if (warning.status === "detected") {
    return steering ? { steering } : {};
  }
  if (warning.status === "correcting") {
    return steering ? { steering } : {};
  }
  if (warning.status === "escalated") {
    if (options.allowPause === false) {
      return steering ? { steering } : {};
    }
    return { pauseReason: `escalated observer warning: ${warning.title}` };
  }
  return {};
}
