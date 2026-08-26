import { randomUUID } from "node:crypto";

export interface SearchGrant {
  id: string;
  caseId: string;
  allowedDomains: string[];
  maxQueries: number;
  usedQueries: number;
  expiresAt: string;
  createdAt: string;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
}

export class SearchGrantRegistry {
  private readonly grants = new Map<string, SearchGrant>();

  authorize(caseId: string, input: { allowedDomains?: string[]; maxQueries?: number; ttlMinutes?: number }): SearchGrant {
    const now = Date.now();
    const grant: SearchGrant = {
      id: `search_grant_${randomUUID()}`,
      caseId,
      allowedDomains: [...new Set((input.allowedDomains ?? []).map((domain) => domain.trim().toLowerCase()).filter(Boolean))],
      maxQueries: Math.min(100, Math.max(1, Math.trunc(input.maxQueries ?? 10))),
      usedQueries: 0,
      expiresAt: new Date(now + Math.min(24 * 60, Math.max(1, input.ttlMinutes ?? 30)) * 60_000).toISOString(),
      createdAt: new Date(now).toISOString(),
    };
    this.grants.set(caseId, grant);
    return grant;
  }

  current(caseId: string): SearchGrant | undefined {
    const grant = this.grants.get(caseId);
    if (!grant || Date.parse(grant.expiresAt) <= Date.now() || grant.usedQueries >= grant.maxQueries) {
      if (grant) this.grants.delete(caseId);
      return undefined;
    }
    return grant;
  }

  consume(caseId: string): SearchGrant {
    const current = this.current(caseId);
    if (!current) throw new Error("network search is not authorized or its grant is exhausted");
    const updated = { ...current, usedQueries: current.usedQueries + 1 };
    this.grants.set(caseId, updated);
    return updated;
  }

  revoke(caseId: string): boolean { return this.grants.delete(caseId); }
}

export class AuthorizedWebSearch {
  constructor(
    private readonly endpoint: string | undefined,
    private readonly apiKey?: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  configured(): boolean { return Boolean(this.endpoint); }

  async search(query: string, grant: SearchGrant, limit = 8): Promise<WebSearchResult[]> {
    if (!this.endpoint) throw new Error("TRACEFORGE_SEARCH_ENDPOINT is not configured");
    const endpoint = new URL(this.endpoint);
    endpoint.searchParams.set("q", query);
    endpoint.searchParams.set("format", "json");
    const response = await this.fetcher(endpoint, {
      headers: this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`search provider returned HTTP ${response.status}`);
    const payload = await response.json() as { results?: Array<{ title?: unknown; url?: unknown; content?: unknown; engine?: unknown }> };
    return (payload.results ?? []).flatMap((item): WebSearchResult[] => {
      if (typeof item.url !== "string") return [];
      let url: URL;
      try { url = new URL(item.url); } catch { return []; }
      if (!["http:", "https:"].includes(url.protocol) || !domainAllowed(url.hostname, grant.allowedDomains)) return [];
      return [{
        title: typeof item.title === "string" ? item.title : url.hostname,
        url: url.href,
        snippet: typeof item.content === "string" ? item.content.slice(0, 1_000) : "",
        source: typeof item.engine === "string" ? item.engine : url.hostname,
      }];
    }).slice(0, Math.min(20, Math.max(1, limit)));
  }
}

function domainAllowed(hostname: string, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  const host = hostname.toLowerCase();
  return allowed.some((domain) => host === domain || host.endsWith(`.${domain}`));
}
