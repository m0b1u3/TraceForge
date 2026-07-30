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

function correctionStrategyTokens(value: string): Set<string> {
  const normalized = value
    .replace(/^\s*\[Observer correction\]\s*/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9_\u4e00-\u9fff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tokens = normalized.match(/[a-z0-9_]+|[\u4e00-\u9fff]+/g) ?? [];
  const result = new Set<string>();
  for (const token of tokens) {
    if (/^[\u4e00-\u9fff]+$/.test(token)) {
      if (token.length === 1) result.add(token);
      for (let index = 0; index < token.length - 1; index += 1) {
        result.add(token.slice(index, index + 2));
      }
    } else if (token.length > 2) {
      result.add(token);
    }
  }
  return result;
}

export function observerCorrectionStrategyIsNovel(previous: string, proposed: string): boolean {
  const left = previous.trim();
  const right = proposed.trim();
  if (!right) return false;
  if (!left) return true;
  const comparable = (value: string) => value
    .toLowerCase()
    .replace(/[^a-z0-9_\u4e00-\u9fff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const normalizedLeft = comparable(left);
  const normalizedRight = comparable(right);
  if (normalizedLeft === normalizedRight) return false;
  if (
    Math.min(normalizedLeft.length, normalizedRight.length) >= 12
    && (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft))
  ) return false;
  const leftTokens = correctionStrategyTokens(left);
  const rightTokens = correctionStrategyTokens(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return true;
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return intersection / Math.max(1, union) < 0.72;
}

export function observerCorrectionStallDecision(
  warning: Pick<ObserverWarning, "level" | "title" | "correctionCount">,
  previous: string,
  proposed: string,
): { stalled: boolean; pauseReason?: string } {
  if (warning.correctionCount === 0 || observerCorrectionStrategyIsNovel(previous, proposed)) {
    return { stalled: false };
  }
  if (warning.level === "critical") {
    return {
      stalled: true,
      pauseReason: `observer requires human direction: no materially new correction is available for ${warning.title}`,
    };
  }
  return { stalled: true };
}

export function observerHumanRecoveryWindowIsOpen(
  warning: Pick<ObserverWarning, "lastCorrectionTrigger" | "correctionOutcome">,
): boolean {
  return warning.lastCorrectionTrigger === "human_direction"
    && warning.correctionOutcome === "pending";
}
