import { keywordScore } from "./keyword-search.js";

export interface ExpandedKeywordHit<T> {
  item: T;
  score: number;
  matchedTerms: string[];
}

export interface ExpandedKeywordSearchOptions {
  limit?: number;
  originalQuery?: string;
}

function normalizeTerm(term: string): string {
  return term.trim();
}

export function uniqueTerms(terms: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of terms) {
    const term = normalizeTerm(raw);
    if (!term) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  return out;
}

export function expandedKeywordSearch<T>(
  items: T[],
  terms: string[],
  textOf: (item: T) => string,
  options: ExpandedKeywordSearchOptions = {},
): ExpandedKeywordHit<T>[] {
  const queries = uniqueTerms(terms);
  const original = options.originalQuery?.trim().toLowerCase();
  const limit = options.limit ?? 10;

  return items
    .map((item) => {
      const text = textOf(item);
      const matchedTerms: string[] = [];
      let bestScore = 0;
      let totalScore = 0;
      for (const term of queries) {
        const score = keywordScore(term, text);
        if (score <= 0) continue;
        matchedTerms.push(term);
        bestScore = Math.max(bestScore, score);
        totalScore += score;
      }
      const directBoost = original && matchedTerms.some((term) => term.toLowerCase() === original) ? 1000 : 0;
      const score = directBoost + bestScore * 10 + totalScore + matchedTerms.length;
      return { item, score, matchedTerms };
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
