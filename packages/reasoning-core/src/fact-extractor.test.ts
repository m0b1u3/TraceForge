import { describe, it, expect } from "vitest";
import { MockProvider, type ExtractJsonArgs } from "@traceforge/llm";
import type { TrafficEntry } from "@traceforge/shared";
import { FactExtractor, EXTRACTION_SYSTEM_PROMPT } from "./fact-extractor.js";

const entry: TrafficEntry = {
  id: "traf_1", caseId: "case_1", url: "https://t.com/api/order?id=1", method: "GET",
  requestHeaders: {}, responseStatus: 200, responseBody: null, createdAt: "now",
};

describe("FactExtractor", () => {
  it("turns provider candidates into validated CandidateFacts with sourceRef and ids", async () => {
    const provider = new MockProvider({
      candidates: [
        { type: "api_endpoint", title: "order detail", value: { url: entry.url }, reasoning: "REST-looking", confidence: 0.7 },
      ],
    });
    const out = await new FactExtractor(provider).extract("case_1", entry);
    expect(out).toHaveLength(1);
    expect(out[0].id).toMatch(/^cand_/);
    expect(out[0].caseId).toBe("case_1");
    expect(out[0].sourceRef).toBe("traf_1");
    expect(out[0].type).toBe("api_endpoint");
  });

  it("drops hallucinated candidates with an invalid type", async () => {
    const provider = new MockProvider({
      candidates: [
        { type: "api_endpoint", title: "good", value: {}, reasoning: "r", confidence: 0.6 },
        { type: "totally_made_up", title: "bad", value: {}, reasoning: "r", confidence: 0.9 },
      ],
    });
    const out = await new FactExtractor(provider).extract("case_1", entry);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("good");
  });

  it("returns [] when provider returns malformed payload", async () => {
    const provider = new MockProvider({ not_candidates: true });
    const out = await new FactExtractor(provider).extract("case_1", entry);
    expect(out).toEqual([]);
  });

  it("embeds untrusted target data inside data-boundary markers in the user prompt", async () => {
    let seenUser = "";
    const provider = new MockProvider((args: ExtractJsonArgs) => {
      seenUser = args.user;
      return { candidates: [] };
    });
    await new FactExtractor(provider).extract("case_1", entry);
    expect(seenUser).toContain("<untrusted_data>");
    expect(seenUser).toContain("</untrusted_data>");
    expect(seenUser).toContain(entry.url);
  });

  it("system prompt declares the data/instruction isolation rule", () => {
    expect(EXTRACTION_SYSTEM_PROMPT.toLowerCase()).toMatch(/instruction|指令/);
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("<untrusted_data>");
  });
});
