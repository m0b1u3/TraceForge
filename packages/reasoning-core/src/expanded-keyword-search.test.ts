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
    const hits = expandedKeywordSearch(rows, ["zzqqxx"], (r) => r.text, { limit: 10 });

    expect(hits).toEqual([]);
  });
});
