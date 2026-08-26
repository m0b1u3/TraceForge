import { describe, expect, it, vi } from "vitest";
import { AuthorizedWebSearch, SearchGrantRegistry } from "./authorized-web-search.js";

describe("authorized network search", () => {
  it("enforces per-Case expiry and query budgets", () => {
    const grants = new SearchGrantRegistry();
    grants.authorize("case_1", { maxQueries: 1, ttlMinutes: 5 });
    expect(grants.consume("case_1").usedQueries).toBe(1);
    expect(() => grants.consume("case_1")).toThrow(/not authorized|exhausted/);
  });

  it("filters provider results to explicitly allowed domains", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ results: [
      { title: "Advisory", url: "https://security.example/advisory", content: "details", engine: "test" },
      { title: "Noise", url: "https://untrusted.test/noise", content: "noise" },
      { title: "Child", url: "https://docs.security.example/guide", content: "guide" },
    ] }), { status: 200, headers: { "content-type": "application/json" } }));
    const grant = new SearchGrantRegistry().authorize("case_1", { allowedDomains: ["security.example"] });
    const search = new AuthorizedWebSearch("https://search.local/search", undefined, fetcher as unknown as typeof fetch);
    const results = await search.search("generic issue", grant);
    expect(results.map((result) => new URL(result.url).hostname)).toEqual(["security.example", "docs.security.example"]);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
