import type { KnowledgeRef, KnowledgeUsageScore } from "./stores/knowledge-usage-store.js";

export interface ExplorationAdviceInput {
  tool: string;
  input: unknown;
  referencedKnowledge: KnowledgeRef[];
  usageScores: Map<string, KnowledgeUsageScore>;
  alternatives: string[];
}

const META_TOOLS = new Set([
  "record_fact",
  "record_task",
  "record_action",
  "record_hypothesis",
  "resolve_hypothesis",
  "record_identity",
  "record_attack_path",
  "update_session_state",
  "recall_case_knowledge",
]);

export function buildExplorationAdvisory(input: ExplorationAdviceInput): string | undefined {
  if (META_TOOLS.has(input.tool)) return undefined;
  const reasons: string[] = [];

  const lowYield = input.referencedKnowledge.filter((ref) => {
    const score = input.usageScores.get(ref.id);
    if (!score) return false;
    const samples = score.positiveOutcome + score.negativeOutcome;
    return samples >= 2 && score.negativeOutcome >= score.positiveOutcome;
  });
  if (lowYield.length) {
    reasons.push(`Referenced knowledge has repeatedly produced low-yield outcomes: ${lowYield.map((ref) => ref.id).join(", ")}.`);
  }

  if (!reasons.length) return undefined;
  const alternatives = input.alternatives.filter(Boolean).slice(0, 3);
  return [
    "This call is allowed, but it resembles a low-yield exploration path.",
    ...reasons.map((reason) => `- ${reason}`),
    alternatives.length
      ? `Consider pivoting after this result: ${alternatives.join(" | ")}`
      : "If this result adds no new evidence, change identity, endpoint, parameter, or attack-path breakpoint before retrying.",
    "Do not repeat the same strategy unless you can state what changed.",
  ].join("\n");
}
