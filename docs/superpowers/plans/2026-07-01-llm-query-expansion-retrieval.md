# LLM Query Expansion Retrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add LLM-powered query expansion to memory retrieval so searches like `越权` can find Facts recorded as `IDOR` or `BOLA`, without adding embeddings or vector storage.

**Architecture:** Keep `keywordScore` as the deterministic primitive. Add a pure expanded-keyword search helper in `reasoning-core`, add an LLM-backed `QueryExpander` in `extension`, then inject it into `search_facts` and `recall_conversation`. Query expansion is best-effort and always falls back to the original query.

**Tech Stack:** TypeScript, Vitest, existing `LlmProvider.extractJson`, existing `ToolDescriptor` memory tools, Fastify route wiring.

---

## File Map

- Create `packages/reasoning-core/src/expanded-keyword-search.ts`: pure multi-query keyword scoring, dedupe, matched-term tracking.
- Create `packages/reasoning-core/src/expanded-keyword-search.test.ts`: pure tests for semantic-equivalent retrieval via fake expanded terms.
- Modify `packages/reasoning-core/src/index.ts`: export expanded keyword search helpers.
- Create `packages/extension/src/query-expander.ts`: `QueryExpander` interface, fallback expander, LLM-backed expander, in-memory cache, JSON parsing and term sanitization.
- Create `packages/extension/src/query-expander.test.ts`: tests for fallback, JSON parsing, dedupe, cache, invalid output.
- Modify `packages/extension/src/memory-tools.ts`: accept optional expander, use expanded-keyword search in `search_facts` and `recall_conversation`, keep `search_traffic` unchanged.
- Modify `packages/extension/src/memory-tools.test.ts`: tests for expanded-term matching and fallback.
- Modify `packages/extension/src/index.ts`: export query-expander types/classes.
- Modify `apps/server/src/routes.ts`: instantiate one `LlmQueryExpander` from the existing LLM provider and inject into memory tools.
- Modify `docs/agent-gap-backlog.md`, `README.md`, `TraceForge_design.md`, and this plan after verification.

---

## Task 1: Expanded Keyword Search Helper

**Files:**
- Create: `packages/reasoning-core/src/expanded-keyword-search.ts`
- Create: `packages/reasoning-core/src/expanded-keyword-search.test.ts`
- Modify: `packages/reasoning-core/src/index.ts`

- [ ] **Step 1: Write failing pure helper tests**

Create `packages/reasoning-core/src/expanded-keyword-search.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { expandedKeywordSearch } from "./expanded-keyword-search.js";

interface Row {
  id: string;
  text: string;
}

describe("expandedKeywordSearch", () => {
  const rows: Row[] = [
    { id: "f1", text: "Possible IDOR on /api/user/:id" },
    { id: "f2", text: "login endpoint /api/login" },
    { id: "f3", text: "static asset logo" },
  ];

  it("finds semantic equivalents supplied as expanded terms", () => {
    const hits = expandedKeywordSearch(rows, ["越权", "IDOR", "BOLA"], (r) => r.text, { limit: 10 });

    expect(hits.map((h) => h.item.id)).toEqual(["f1"]);
    expect(hits[0].matchedTerms).toContain("IDOR");
  });

  it("deduplicates expanded query terms case-insensitively", () => {
    const hits = expandedKeywordSearch(rows, ["IDOR", "idor", " IDOR "], (r) => r.text, { limit: 10 });

    expect(hits).toHaveLength(1);
    expect(hits[0].matchedTerms).toEqual(["IDOR"]);
  });

  it("boosts direct original-query matches over expansion-only matches", () => {
    const mixedRows: Row[] = [
      { id: "direct", text: "越权 finding" },
      { id: "expanded", text: "IDOR finding" },
    ];

    const hits = expandedKeywordSearch(mixedRows, ["越权", "IDOR"], (r) => r.text, { originalQuery: "越权", limit: 10 });

    expect(hits.map((h) => h.item.id)).toEqual(["direct", "expanded"]);
  });

  it("returns an empty array when no expanded term matches", () => {
    const hits = expandedKeywordSearch(rows, ["ssrf"], (r) => r.text, { limit: 10 });

    expect(hits).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
node_modules\.bin\vitest.cmd run packages/reasoning-core/src/expanded-keyword-search.test.ts
```

Expected: FAIL because `expanded-keyword-search.ts` does not exist.

- [ ] **Step 3: Implement expanded keyword search**

Create `packages/reasoning-core/src/expanded-keyword-search.ts`:

```ts
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
```

Modify `packages/reasoning-core/src/index.ts`:

```ts
export * from "./expanded-keyword-search.js";
```

Keep the existing exports unchanged.

- [ ] **Step 4: Run tests to verify GREEN**

Run:

```bash
node_modules\.bin\vitest.cmd run packages/reasoning-core/src/expanded-keyword-search.test.ts packages/reasoning-core/src/keyword-search.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/reasoning-core/src/expanded-keyword-search.ts packages/reasoning-core/src/expanded-keyword-search.test.ts packages/reasoning-core/src/index.ts
git commit -m "feat(retrieval): add expanded keyword search"
```

---

## Task 2: QueryExpander Abstraction and LLM Implementation

**Files:**
- Create: `packages/extension/src/query-expander.ts`
- Create: `packages/extension/src/query-expander.test.ts`
- Modify: `packages/extension/src/index.ts`

- [ ] **Step 1: Write failing QueryExpander tests**

Create `packages/extension/src/query-expander.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FallbackQueryExpander, LlmQueryExpander } from "./query-expander.js";
import type { LlmProvider } from "./provider.js";

function provider(result: unknown): LlmProvider {
  return {
    extractJson: async () => result,
    runTools: async () => ({ text: "", toolCalls: [], done: true }),
  };
}

describe("FallbackQueryExpander", () => {
  it("returns only the original query", async () => {
    const terms = await new FallbackQueryExpander().expand({ query: "越权", toolName: "search_facts" });

    expect(terms).toEqual(["越权"]);
  });
});

describe("LlmQueryExpander", () => {
  it("includes original query and sanitized LLM terms", async () => {
    const expander = new LlmQueryExpander(provider(["IDOR", "BOLA", "broken access control"]));

    const terms = await expander.expand({ query: "越权", toolName: "search_facts" });

    expect(terms).toEqual(["越权", "IDOR", "BOLA", "broken access control"]);
  });

  it("deduplicates terms case-insensitively", async () => {
    const expander = new LlmQueryExpander(provider(["IDOR", "idor", " 越权 "]));

    const terms = await expander.expand({ query: "越权", toolName: "search_facts" });

    expect(terms).toEqual(["越权", "IDOR"]);
  });

  it("filters empty, multiline, and overlong terms", async () => {
    const expander = new LlmQueryExpander(provider(["", "line1\nline2", "x".repeat(81), "BOLA"]));

    const terms = await expander.expand({ query: "越权", toolName: "search_facts" });

    expect(terms).toEqual(["越权", "BOLA"]);
  });

  it("falls back to original query on invalid provider result", async () => {
    const expander = new LlmQueryExpander(provider({ terms: ["IDOR"] }));

    const terms = await expander.expand({ query: "越权", toolName: "search_facts" });

    expect(terms).toEqual(["越权"]);
  });

  it("falls back to original query when provider throws", async () => {
    const throwing: LlmProvider = {
      extractJson: async () => { throw new Error("network"); },
      runTools: async () => ({ text: "", toolCalls: [], done: true }),
    };
    const expander = new LlmQueryExpander(throwing);

    const terms = await expander.expand({ query: "越权", toolName: "search_facts" });

    expect(terms).toEqual(["越权"]);
  });

  it("caches expansion by tool and normalized query", async () => {
    let calls = 0;
    const counting: LlmProvider = {
      extractJson: async () => {
        calls += 1;
        return ["IDOR"];
      },
      runTools: async () => ({ text: "", toolCalls: [], done: true }),
    };
    const expander = new LlmQueryExpander(counting);

    await expander.expand({ query: " 越权 ", toolName: "search_facts" });
    await expander.expand({ query: "越权", toolName: "search_facts" });

    expect(calls).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
node_modules\.bin\vitest.cmd run packages/extension/src/query-expander.test.ts
```

Expected: FAIL because `query-expander.ts` does not exist.

- [ ] **Step 3: Implement QueryExpander**

Create `packages/extension/src/query-expander.ts`:

```ts
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
      const raw = await this.provider.extractJson({ system: SYSTEM, user, schema: SCHEMA });
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
```

Modify `packages/extension/src/index.ts`:

```ts
export * from "./query-expander.js";
```

Keep existing exports unchanged.

- [ ] **Step 4: Run tests to verify GREEN**

Run:

```bash
node_modules\.bin\vitest.cmd run packages/extension/src/query-expander.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/query-expander.ts packages/extension/src/query-expander.test.ts packages/extension/src/index.ts
git commit -m "feat(retrieval): add llm query expander"
```

---

## Task 3: Wire Expanded Retrieval into Memory Tools

**Files:**
- Modify: `packages/extension/src/memory-tools.ts`
- Modify: `packages/extension/src/memory-tools.test.ts`

- [ ] **Step 1: Write failing memory-tool tests**

Append these tests to `packages/extension/src/memory-tools.test.ts`:

```ts
describe("search_facts query expansion", () => {
  it("finds IDOR facts when original query is 越权 and expander supplies IDOR", async () => {
    const facts = {
      listByCase: () => [
        fact({ id: "f1", type: "finding", title: "Possible IDOR on /api/user/:id", value: {} }),
      ],
    };
    const expander = {
      expand: async () => ["越权", "IDOR", "BOLA", "broken access control"],
    };
    const t = makeSearchFactsTool("c", facts, { expander });

    const r = await t.execute({ query: "越权" });

    expect(r.ok).toBe(true);
    expect(r.content).toContain("f1");
    expect(r.content).toContain("matched: IDOR");
  });

  it("falls back to original keyword behavior when no expander is provided", async () => {
    const facts = {
      listByCase: () => [
        fact({ id: "f1", type: "finding", title: "Possible IDOR on /api/user/:id", value: {} }),
      ],
    };
    const t = makeSearchFactsTool("c", facts);

    const r = await t.execute({ query: "越权" });

    expect(r.ok).toBe(true);
    expect(r.content).toContain("没有匹配");
  });
});

describe("recall_conversation query expansion", () => {
  it("finds earlier conversation text through expanded terms", async () => {
    const events = {
      listByCase: (): AgentEvent[] => [
        { id: "e1", caseId: "c", kind: "done", text: "Earlier note: possible BOLA in profile API", tool: null, createdAt: "t" },
      ],
    };
    const summaries = { latest: () => undefined };
    const expander = {
      expand: async () => ["越权", "BOLA"],
    };
    const t = makeRecallConversationTool("c", events, summaries, { expander });

    const r = await t.execute({ query: "越权" });

    expect(r.ok).toBe(true);
    expect(r.content).toContain("possible BOLA");
  });
});
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
node_modules\.bin\vitest.cmd run packages/extension/src/memory-tools.test.ts
```

Expected: FAIL because memory tool factories do not accept an expander and do not report matched expanded terms.

- [ ] **Step 3: Implement memory tool integration**

Modify the imports in `packages/extension/src/memory-tools.ts`:

```ts
import { expandedKeywordSearch } from "@traceforge/reasoning-core";
import type { QueryExpander } from "./query-expander.js";
```

Keep the existing `keywordScore` import for `search_traffic`, or replace only the fact/conversation paths with `expandedKeywordSearch`.

Add options:

```ts
export interface MemoryToolOptions {
  expander?: QueryExpander;
}

async function expandQuery(options: MemoryToolOptions | undefined, caseId: string, toolName: string, query: string): Promise<string[]> {
  return options?.expander?.expand({ caseId, toolName, query }) ?? [query];
}
```

Change `makeSearchFactsTool` signature:

```ts
export function makeSearchFactsTool(caseId: string, facts: FactSearchReader, options: MemoryToolOptions = {}): ToolDescriptor {
```

Inside `execute`, replace the current `keywordScore` map/filter block with:

```ts
const terms = await expandQuery(options, caseId, "search_facts", query);
const hits = expandedKeywordSearch(
  facts.listByCase(caseId),
  terms,
  (f) => `${f.type} ${f.title} ${JSON.stringify(f.value)} ${f.tags.join(" ")}`,
  { originalQuery: query, limit },
);
if (hits.length === 0) return { ok: true, content: `没有匹配"${query}"的 Fact\n已尝试扩展词：${terms.join(", ")}` };
return {
  ok: true,
  content: `${hits.map((h) => {
    const matched = h.matchedTerms.length ? `\n  matched: ${h.matchedTerms.join(", ")}` : "";
    return `${h.item.id} [${h.item.type}] ${h.item.title}${matched}`;
  }).join("\n")}\n（用 get_fact_detail(id) 看完整内容）`,
};
```

Change `makeRecallConversationTool` signature:

```ts
export function makeRecallConversationTool(caseId: string, events: ConvoSearchReader, summaries: SummaryReader, options: MemoryToolOptions = {}): ToolDescriptor {
```

Inside `execute`, replace event hit scoring with:

```ts
const terms = await expandQuery(options, caseId, "recall_conversation", query);
const hits = expandedKeywordSearch(
  events.listByCase(caseId).filter((e) => e.kind === "user" || e.kind === "text" || e.kind === "done"),
  terms,
  (e) => e.text,
  { originalQuery: query, limit },
);
const parts: string[] = [];
if (hits.length) parts.push(hits.map((h) => `[${h.item.kind}] ${clip(h.item.text)}`).join("\n"));
const sum = summaries.latest(caseId);
if (sum && expandedKeywordSearch([sum], terms, (s) => s.content, { originalQuery: query, limit: 1 }).length > 0) {
  parts.push(`远期摘要相关段：${clip(sum.content, 200)}`);
}
if (parts.length === 0) return { ok: true, content: `没有匹配"${query}"的历史对话\n已尝试扩展词：${terms.join(", ")}` };
return { ok: true, content: parts.join("\n\n") };
```

Do not change `makeSearchTrafficTool`.

- [ ] **Step 4: Run tests to verify GREEN**

Run:

```bash
node_modules\.bin\vitest.cmd run packages/extension/src/memory-tools.test.ts packages/reasoning-core/src/expanded-keyword-search.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/memory-tools.ts packages/extension/src/memory-tools.test.ts
git commit -m "feat(retrieval): expand memory search queries"
```

---

## Task 4: Server Route Wiring and Agent Integration Test

**Files:**
- Modify: `apps/server/src/routes.ts`
- Modify: `apps/server/src/routes-cognitive.test.ts`

- [ ] **Step 1: Write failing integration test**

Append this test to `apps/server/src/routes-cognitive.test.ts`, adapting only local setup names if the file already has helpers for `createDb`, `EventBus`, and `registerRoutes`:

```ts
it("agent can retrieve an IDOR fact when searching 越权 through query expansion", async () => {
  const db = createDb(":memory:");
  const bus = new EventBus();
  const app = Fastify();
  let extractCalls = 0;
  const provider = new MockProvider(
    () => {
      extractCalls += 1;
      return ["IDOR", "BOLA", "broken access control"];
    },
    [
      { text: "", done: false, toolCalls: [{ id: "call_1", name: "search_facts", input: { query: "越权" } }] },
      { text: "找到了 IDOR 相关事实", done: true, toolCalls: [] },
    ],
  );
  registerRoutes(app, db, bus, provider);
  await app.ready();

  const created = await app.inject({
    method: "POST",
    url: "/api/cases",
    payload: { name: "c", allowHosts: ["example.com"] },
  });
  const caseId = JSON.parse(created.body).id;

  await app.inject({
    method: "POST",
    url: `/api/cases/${caseId}/facts`,
    payload: {
      type: "finding",
      title: "Possible IDOR on /api/user/:id",
      value: { endpoint: "/api/user/:id" },
      confidence: 0.8,
      tags: ["access-control"],
    },
  });

  await app.inject({
    method: "POST",
    url: `/api/cases/${caseId}/agent/run`,
    payload: { goal: "检索越权相关历史发现" },
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  const events = await app.inject({ method: "GET", url: `/api/cases/${caseId}/agent/events` });
  const body = JSON.parse(events.body);

  expect(extractCalls).toBeGreaterThan(0);
  expect(JSON.stringify(body)).toContain("Possible IDOR");
  expect(JSON.stringify(body)).toContain("matched: IDOR");

  await app.close();
});
```

If `routes-cognitive.test.ts` does not expose `createDb`, `EventBus`, `Fastify`, or `MockProvider` in scope, import the same modules already used at the top of that file instead of inventing new helpers.

- [ ] **Step 2: Run integration test to verify RED**

Run:

```bash
node_modules\.bin\vitest.cmd run apps/server/src/routes-cognitive.test.ts
```

Expected: FAIL because routes do not yet inject `LlmQueryExpander` into memory tools.

- [ ] **Step 3: Wire expander in routes**

Modify the extension imports in `apps/server/src/routes.ts` to include `LlmQueryExpander`:

```ts
import {
  ToolRegistry, ApprovalGate, AgentRuntime,
  makeListTrafficTool, makeGetTrafficTool,
  makeRecordFactTool, makeRecordTaskTool, makeRecordActionTool,
  makeReopenTaskTool, makeRevertDoneTaskTool,
  makeHttpReplayTool, makeProposeScopeExpansionTool, makeBrowserTools,
  McpManager, mcpToolToDescriptor, Observer,
  LlmQueryExpander,
} from "@traceforge/extension";
```

Inside `registerRoutes`, after `const llm: LlmProvider = ...`, add:

```ts
const queryExpander = new LlmQueryExpander(llm);
```

Change memory tool registration:

```ts
registry.register(makeSearchFactsTool(id, factStore, { expander: queryExpander }));
registry.register(makeGetFactDetailTool(id, factStore));
registry.register(makeSearchTrafficTool(id, traffic));
registry.register(makeRecallConversationTool(id, agentEventStore, contextSummaryStore, { expander: queryExpander }));
```

Do not inject the expander into `search_traffic` in this phase.

- [ ] **Step 4: Run integration tests to verify GREEN**

Run:

```bash
node_modules\.bin\vitest.cmd run apps/server/src/routes-cognitive.test.ts packages/extension/src/memory-tools.test.ts packages/extension/src/query-expander.test.ts packages/reasoning-core/src/expanded-keyword-search.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes.ts apps/server/src/routes-cognitive.test.ts
git commit -m "feat(retrieval): wire query expansion into agent memory"
```

---

## Task 5: Verification, Real LLM E2E, and Docs

**Files:**
- Modify: `docs/agent-gap-backlog.md`
- Modify: `README.md`
- Modify: `TraceForge_design.md`
- Modify: `docs/superpowers/plans/2026-07-01-llm-query-expansion-retrieval.md`

- [ ] **Step 1: Run focused tests**

Run:

```bash
node_modules\.bin\vitest.cmd run packages/reasoning-core/src/expanded-keyword-search.test.ts packages/extension/src/query-expander.test.ts packages/extension/src/memory-tools.test.ts apps/server/src/routes-cognitive.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run full tests**

Run:

```bash
pnpm test
```

Expected: PASS.

- [ ] **Step 3: Run build**

Run:

```bash
pnpm -r build
```

Expected: PASS. Existing Vite warnings about `undici` browser externalization and large chunks may remain.

- [ ] **Step 4: Run real OpenAI-compatible LLM E2E**

Use current `config/llm.json` and `.env`. Do not print API keys.

Required scenario:

1. Create a Case.
2. Record a Fact with title `Possible IDOR on /api/user/:id`; do not include `越权` in title/value/tags.
3. Start `/agent/run` with a goal that asks the agent to search/reason about `越权`.
4. Confirm the tool result contains the IDOR Fact and `matched: IDOR` or another real expanded equivalent.
5. Confirm no `agent_error`.

Record:

- provider
- model
- baseUrl host only if useful, no key
- runId
- whether `extractJson` expansion happened, inferred from retrieved expanded-term match or provider instrumentation
- stream start/delta/end counts
- final terminal event
- relevant tool result excerpt
- errors

- [ ] **Step 5: Update docs**

Update:

- `docs/agent-gap-backlog.md`: mark #0 first phase complete, but keep embedding/vector semantic retrieval as a possible later phase if real tests show gaps.
- `README.md`: add LLM Query Expansion Retrieval to current progress and keep wording explicit that this is not embedding.
- `TraceForge_design.md`: add route item after Tool Parallelism for query-expansion retrieval.
- This plan: append `## Result Log` with focused tests, full tests, build, and real LLM E2E.

- [ ] **Step 6: Commit**

```bash
git add docs/agent-gap-backlog.md README.md TraceForge_design.md docs/superpowers/plans/2026-07-01-llm-query-expansion-retrieval.md
git commit -m "docs: record query expansion retrieval validation"
```

---

## Result Log

- Task 1 RED: `node_modules\.bin\vitest.cmd run packages/reasoning-core/src/expanded-keyword-search.test.ts` failed because `expanded-keyword-search.ts` did not exist.
- Task 1 GREEN: `node_modules\.bin\vitest.cmd run packages/reasoning-core/src/expanded-keyword-search.test.ts packages/reasoning-core/src/keyword-search.test.ts` passed 2 files / 9 tests. The original no-hit query in the plan (`ssrf`) was adjusted to `zzqqxx` because current bigram matching legitimately collides with `ss` in existing fixture text.
- Task 2 RED: `node_modules\.bin\vitest.cmd run packages/extension/src/query-expander.test.ts` failed because `query-expander.ts` did not exist.
- Task 2 GREEN: `node_modules\.bin\vitest.cmd run packages/extension/src/query-expander.test.ts` passed. After real DeepSeek validation showed `400 This response_format type is unavailable now` for `json_schema`, `LlmQueryExpander` gained a plain `runTools` JSON-text fallback and the query-expander test suite passed 8 tests.
- Task 3 RED: `node_modules\.bin\vitest.cmd run packages/extension/src/memory-tools.test.ts` failed the new expansion cases because memory tools were still using only the original query.
- Task 3 GREEN: `node_modules\.bin\vitest.cmd run packages/extension/src/memory-tools.test.ts packages/reasoning-core/src/expanded-keyword-search.test.ts` passed 2 files / 17 tests.
- Task 4 RED: `node_modules\.bin\vitest.cmd run apps/server/src/routes-cognitive.test.ts` timed out waiting for the IDOR hit because routes had not injected `LlmQueryExpander`.
- Task 4 GREEN: `node_modules\.bin\vitest.cmd run apps/server/src/routes-cognitive.test.ts packages/extension/src/memory-tools.test.ts packages/extension/src/query-expander.test.ts packages/reasoning-core/src/expanded-keyword-search.test.ts` passed 4 files / 29 tests.
- Final focused verification after DeepSeek fallback fix: `node_modules\.bin\vitest.cmd run packages/reasoning-core/src/expanded-keyword-search.test.ts packages/extension/src/query-expander.test.ts packages/extension/src/memory-tools.test.ts apps/server/src/routes-cognitive.test.ts` passed 4 files / 30 tests.
- Full verification: `pnpm test` passed 68 files / 283 tests.
- Build verification: `pnpm -r build` passed. Existing Vite warnings about `undici` browser externalization and large chunks remain.
- Real OpenAI-compatible E2E: used current `config/llm.json` and `.env` without printing API keys. Provider `openai`, model `deepseek-v4-flash`, baseUrl `https://api.deepseek.com`, native `streamTools=true`. Run id `run_baa8a081-988f-47ab-b9dc-117aa49038d1`; `extractCalls=2`; `expansionRunToolsCalls=1` because DeepSeek rejected `json_schema` and the plain JSON-text fallback was used; stream events start=2, delta=165, end=2; terminal event `agent_run_completed`; tool call was `search_facts({"query":"越权"})`; tool result returned `Possible IDOR on /api/user/:id` with matched terms including `IDOR`; errors=[].
