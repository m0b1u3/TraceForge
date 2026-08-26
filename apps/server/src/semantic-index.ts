import { createHash } from "node:crypto";
import type { LlmProvider } from "@traceforge/llm";
import type { SemanticDocumentStore } from "./stores/semantic-document-store.js";

export interface SemanticCandidate { id: string; text: string }
export interface SemanticHit { id: string; score: number }

const hash = (text: string): string => createHash("sha256").update(text).digest("hex");

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) return -1;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : -1;
}

export class SemanticIndex {
  constructor(
    private readonly provider: LlmProvider,
    private readonly store: SemanticDocumentStore,
    private readonly modelName: () => string | undefined,
  ) {}

  async search(caseId: string | null, kind: string, query: string, candidates: SemanticCandidate[], limit = 10): Promise<SemanticHit[]> {
    if (!this.provider.embed) throw new Error("embedding provider unavailable");
    const model = this.modelName();
    if (!model) throw new Error("embeddingModel is not configured");
    const stale = candidates.filter((candidate) => {
      const current = this.store.get(kind, candidate.id);
      return !current || current.textHash !== hash(candidate.text) || current.model !== model;
    });
    if (stale.length) {
      const vectors = await this.provider.embed({ inputs: stale.map((candidate) => candidate.text) });
      if (vectors.length !== stale.length) throw new Error("embedding provider returned an unexpected vector count");
      stale.forEach((candidate, index) => this.store.save({
        id: `${kind}:${candidate.id}`,
        caseId,
        kind,
        sourceId: candidate.id,
        textHash: hash(candidate.text),
        content: candidate.text,
        model,
        dimensions: vectors[index].length,
        vector: vectors[index],
        updatedAt: new Date().toISOString(),
      }));
    }
    const [queryVector] = await this.provider.embed({ inputs: [query] });
    if (!queryVector) throw new Error("embedding provider returned no query vector");
    const allowed = new Set(candidates.map((candidate) => candidate.id));
    return this.store.list(caseId, kind)
      .filter((document) => allowed.has(document.sourceId) && document.model === model)
      .map((document) => ({ id: document.sourceId, score: cosineSimilarity(queryVector, document.vector) }))
      .filter((hit) => Number.isFinite(hit.score))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}
