import type { LlmProvider } from "./provider.js";

export interface QueryExpansionInput {
  query: string;
  toolName: string;
  caseId?: string;
  currentGoal?: string;
  maxTerms?: number;
}

export interface QueryExpander {
  expand(input: QueryExpansionInput): Promise<string[]>;
}

const SYSTEM = `You are TraceForge's memory query expansion helper.
Given a red-team investigation search query, generate equivalent or adjacent retrieval keywords.
Include Chinese terms, English terms, acronyms, and common security terminology when useful.
Do not invent target-specific facts.
Do not generate exploit payloads.
Return a JSON array of strings, max 12 items.`;

const SCHEMA = {
  type: "array",
  items: { type: "string" },
};

function normalizeQuery(query: string): string {
  return query.trim();
}

function parseJsonArrayText(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

function sanitizeTerms(originalQuery: string, rawTerms: unknown, maxTerms: number): string[] {
  if (!Array.isArray(rawTerms)) return [normalizeQuery(originalQuery)].filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (value: string) => {
    const term = value.trim();
    if (!term || term.length > 80 || term.includes("\n") || term.includes("\r")) return;
    const key = term.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(term);
  };
  push(originalQuery);
  for (const term of rawTerms) {
    if (typeof term === "string") push(term);
    if (out.length >= maxTerms) break;
  }
  return out.length ? out : [normalizeQuery(originalQuery)].filter(Boolean);
}

export class FallbackQueryExpander implements QueryExpander {
  async expand(input: QueryExpansionInput): Promise<string[]> {
    const q = normalizeQuery(input.query);
    return q ? [q] : [];
  }
}

export class LlmQueryExpander implements QueryExpander {
  private cache = new Map<string, string[]>();

  constructor(private provider: LlmProvider, private defaults: { maxTerms?: number } = {}) {}

  async expand(input: QueryExpansionInput): Promise<string[]> {
    const query = normalizeQuery(input.query);
    if (!query) return [];
    const maxTerms = input.maxTerms ?? this.defaults.maxTerms ?? 12;
    const cacheKey = `${input.toolName}:${query.toLowerCase()}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    try {
      const user = [
        `tool: ${input.toolName}`,
        input.caseId ? `caseId: ${input.caseId}` : undefined,
        input.currentGoal ? `currentGoal: ${input.currentGoal}` : undefined,
        `query: ${query}`,
      ].filter(Boolean).join("\n");
      let raw: unknown;
      try {
        raw = await this.provider.extractJson({ system: SYSTEM, user, schema: SCHEMA });
      } catch {
        const turn = await this.provider.runTools({
          system: `${SYSTEM}\nReturn only the raw JSON array. Do not wrap it in prose.`,
          messages: [{ role: "user", content: user }],
          tools: [],
        });
        raw = parseJsonArrayText(turn.text);
      }
      const terms = sanitizeTerms(query, raw, maxTerms);
      this.cache.set(cacheKey, terms);
      return terms;
    } catch {
      const fallback = [query];
      this.cache.set(cacheKey, fallback);
      return fallback;
    }
  }
}
