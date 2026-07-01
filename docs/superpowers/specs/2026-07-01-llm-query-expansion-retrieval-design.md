# LLM Query Expansion Retrieval Design

## 1. Goal

Improve TraceForge memory retrieval recall without introducing embeddings yet.

The current `search_facts` and `recall_conversation` tools use `keywordScore`, a deterministic bigram keyword matcher. This is fast and robust for exact terms, URLs, endpoint names, and Chinese partial matches, but it misses cross-language or security-term equivalents. Example: a Fact recorded as `IDOR` or `BOLA` will not be found when the agent searches `越权`.

This iteration adds an LLM-powered query expansion step before keyword search:

```text
query: "越权"
  -> ["越权", "未授权访问", "水平越权", "垂直越权", "IDOR", "BOLA", "broken access control", ...]
  -> run existing keyword search for each term
  -> merge, dedupe, rank, return results with matched terms
```

This is the first phase of backlog item #0. It does not add embedding models, vector storage, or a vector database.

## 2. Non-Goals

- Do not introduce embedding models.
- Do not add a vector table or vector database.
- Do not hardcode vulnerability synonym dictionaries in TypeScript.
- Do not generate payloads or target-specific assumptions during expansion.
- Do not replace `keywordScore`; keep it as the deterministic retrieval primitive.
- Do not force every memory lookup to call the LLM if expansion is unavailable or unnecessary.

## 3. Architecture

Add a small query expansion layer between memory tools and `keywordScore`.

```text
search_facts(query)
  -> QueryExpander.expand(query, context)
  -> KeywordMultiSearch.search(expandedQueries)
  -> result merge + score aggregation
  -> formatted tool_result
```

### 3.1 QueryExpander

`QueryExpander` is a provider-backed service that asks the configured LLM to produce related search terms.

Responsibilities:

- Accept the original query and a lightweight retrieval context.
- Return a bounded list of search terms.
- Always include the original query.
- Parse strict JSON output.
- Deduplicate and normalize terms.
- Fall back to `[originalQuery]` on any failure.

The expansion prompt must be domain-generic:

```text
You are TraceForge's memory query expansion helper.
Given a red-team investigation search query, generate equivalent or adjacent retrieval keywords.
Include Chinese terms, English terms, acronyms, and common security terminology when useful.
Do not invent target-specific facts.
Do not generate exploit payloads.
Return a JSON array of strings, max 12 items.
```

This keeps security knowledge in LLM reasoning instead of TypeScript dictionaries.

### 3.2 Retrieval Context

The first version only needs a minimal context:

- `caseId`
- tool name, such as `search_facts` or `recall_conversation`
- original query
- optional current goal or session phase if already available at the call site

It should not inject large Fact lists into the expansion prompt. The expander only expands the query; it does not inspect the database.

### 3.3 KeywordMultiSearch

Use existing data readers and `keywordScore`.

For every candidate record:

1. Build the same searchable text currently used by the tool.
2. Score it against each expanded query.
3. Keep positive matches.
4. Aggregate:

```text
finalScore = bestKeywordScore + matchedTermCountBonus + originalQueryBonus
```

The exact score can stay simple and deterministic. The key requirement is explainability: each result should remember which expanded terms matched.

### 3.4 Tool Output

`search_facts` should keep its current concise format, with one useful addition:

```text
fact_1 [finding] Possible IDOR on /api/user/:id
  matched: IDOR, broken access control
```

If there are no hits, return the expanded terms so the agent can decide whether to try a different angle:

```text
没有匹配"越权"的 Fact
已尝试扩展词：越权, 未授权访问, IDOR, BOLA, broken access control
```

`recall_conversation` can use the same expansion flow but keep output compact, because conversation snippets are longer.

`search_traffic` should remain keyword-first in this phase. URLs, methods, and status codes are mostly exact-match retrieval. It can optionally accept the shared helper later if real testing shows value.

## 4. Caching and Cost Control

Add a small in-memory cache:

```text
cache key = provider/model + toolName + normalizedQuery
value = expanded query list
ttl = current process lifetime
```

This avoids repeated LLM calls when the agent searches the same concept multiple times during one run.

If LLM expansion fails because of network errors, provider errors, invalid JSON, or timeout:

- emit or log a non-fatal warning if the current event path supports it;
- continue with original keyword search;
- never fail the memory tool solely because expansion failed.

## 5. Configuration

Reuse the existing chat LLM provider for the first implementation.

Reasoning:

- The user explicitly wants to avoid embeddings for now.
- Query expansion is a short natural-language task and fits chat models.
- Reusing existing provider configuration avoids a new model/config surface.

Future config can add:

```json
{
  "retrieval": {
    "queryExpansion": {
      "enabled": true,
      "maxTerms": 12,
      "timeoutMs": 8000
    }
  }
}
```

For the first iteration, a conservative default can be enabled in code for `search_facts` and `recall_conversation`, with tests using a fake expander.

## 6. Error Handling

Query expansion is best-effort.

- Empty query: keep existing validation and return `缺少 query`.
- LLM unavailable: use `[query]`.
- Invalid JSON: use `[query]`.
- Too many terms: truncate to max terms.
- Duplicate terms: remove duplicates case-insensitively.
- Expansion returns unsafe payload-like strings: filter obvious multi-line payloads and very long strings.

Filtering is structural, not vulnerability-semantic:

- max term length, for example 80 chars;
- no newlines;
- non-empty after trim.

## 7. Testing Strategy

### Unit Tests

- `QueryExpander` includes the original query.
- Invalid provider output falls back to original query.
- Duplicate and overlong terms are removed.
- Keyword multi-search can find a Fact containing `IDOR` when original query is `越权` and fake expander returns `IDOR`.
- `search_facts` output includes matched expanded terms.
- `recall_conversation` can hit expanded terms.

### Integration Tests

- Register memory tools with a fake expander.
- Store a Fact titled `Possible IDOR on /api/user/:id`.
- Call `search_facts({ query: "越权" })`.
- Assert the Fact is returned.

### Real LLM E2E

Use the configured real OpenAI-compatible LLM.

Required scenario:

1. Create a Case.
2. Record a Fact whose visible text only contains `IDOR` or `BOLA`, not `越权`.
3. Ask the agent to search or reason about `越权`.
4. Verify a real LLM expansion occurs and the Fact is retrieved.

This E2E must not use mock conclusions for LLM behavior.

## 8. Rollout

Phase 1:

- Add `QueryExpander` abstraction.
- Add keyword multi-search helper.
- Inject expander into `search_facts` and `recall_conversation`.
- Keep `search_traffic` unchanged.
- Document that this is not embedding retrieval.

Phase 2, only if real tests show remaining recall gaps:

- Add embedding provider.
- Add persisted semantic index.
- Blend embedding similarity with keyword and query-expansion scores.

## 9. Acceptance Criteria

- Searching `越权` can retrieve a Fact containing `IDOR` when the expander supplies that term.
- Expansion failure does not break existing keyword search.
- No vulnerability synonym list is hardcoded in TypeScript.
- No embedding model or vector table is introduced.
- Existing memory-tool tests still pass.
- Full test suite and build pass.
- A real LLM E2E verifies expansion behavior with the configured provider.
