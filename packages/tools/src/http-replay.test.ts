import { describe, it, expect } from "vitest";
import { replay, modifyParam, compareResponses, type ReplayResponse } from "./http-replay.js";

const baseResp: ReplayResponse = { status: 200, bodyLength: 100, body: "ok ".repeat(33) + "x", headers: {} };

describe("replay", () => {
  it("uses the injected fetcher", async () => {
    const out = await replay(
      { url: "https://t.com/api", method: "GET" },
      async () => ({ status: 201, bodyLength: 3, body: "abc", headers: { "x-test": "1" } }),
    );
    expect(out.status).toBe(201);
    expect(out.headers["x-test"]).toBe("1");
  });
});

describe("modifyParam", () => {
  it("sets a query param to an arbitrary value, preserving others", () => {
    const out = modifyParam({ url: "https://t.com/a?id=1&page=2", method: "GET" }, "id", "anything-AI-wants");
    expect(out.url).toContain("page=2");
    expect(out.url).toContain("id=anything-AI-wants");
  });

  it("returns the request unchanged when the param is absent", () => {
    const req = { url: "https://t.com/a?page=2", method: "GET" };
    expect(modifyParam(req, "id", "x").url).toBe(req.url);
  });
});

describe("compareResponses", () => {
  it("reports a status code change", () => {
    expect(compareResponses(baseResp, { ...baseResp, status: 500 }).statusChanged).toBe(true);
  });

  it("reports the length delta", () => {
    const variant = { ...baseResp, bodyLength: 180, body: baseResp.body + "y".repeat(80) };
    expect(compareResponses(baseResp, variant).lengthDelta).toBe(80);
  });

  it("returns zero deltas for identical responses (no vuln-specific judgement)", () => {
    const r = compareResponses(baseResp, { ...baseResp });
    expect(r.statusChanged).toBe(false);
    expect(r.lengthDelta).toBe(0);
  });

  it("only exposes raw signals — no errorSignature/verdict keys (LLM reads body itself)", () => {
    const r = compareResponses(baseResp, { ...baseResp, body: "You have an error in your SQL syntax" });
    expect(Object.keys(r).sort()).toEqual(["lengthDelta", "statusChanged"]);
  });
});
