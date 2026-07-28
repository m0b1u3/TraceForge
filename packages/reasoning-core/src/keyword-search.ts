// Lightweight lexical retrieval with a minimum coverage threshold.
// Direct substrings rank highest; fuzzy bigram matches must cover most of a token.
export function keywordScore(query: string, text: string): number {
  const normalizedQuery = query.toLowerCase().trim();
  const normalizedText = text.toLowerCase();
  if (!normalizedQuery || !normalizedText) return 0;

  const tokens = normalizedQuery.split(/[\s,，、;；|/]+/).filter(Boolean);
  let best = 0;
  for (const token of tokens) best = Math.max(best, tokenScore(token, normalizedText));
  return best;
}

function tokenScore(query: string, text: string): number {
  if (query.length === 1) return text.includes(query) ? 1 : 0;
  if (text.includes(query)) return Math.max(2, query.length);

  const grams = new Set<string>();
  for (let index = 0; index < query.length - 1; index += 1) {
    grams.add(query.slice(index, index + 2));
  }
  let hits = 0;
  for (const gram of grams) if (text.includes(gram)) hits += 1;
  const minimumCoverage = Math.max(2, Math.ceil(grams.size * 0.6));
  return hits >= minimumCoverage ? hits : 0;
}
