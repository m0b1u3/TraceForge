import { describe, it, expect } from "vitest";
import { keywordScore } from "./keyword-search.js";

describe("keywordScore", () => {
  it("empty query or text returns 0", () => {
    expect(keywordScore("", "abc")).toBe(0);
    expect(keywordScore("abc", "")).toBe(0);
  });
  it("single-char query uses includes", () => {
    expect(keywordScore("a", "banana")).toBe(1);
    expect(keywordScore("z", "banana")).toBe(0);
  });
  it("multi-char query counts bigram hits", () => {
    expect(keywordScore("login", "the login endpoint")).toBeGreaterThan(0);
    expect(keywordScore("login", "unrelated text")).toBe(0);
  });
  it("matches chinese continuous string", () => {
    expect(keywordScore("登录越权", "登录接口")).toBeGreaterThan(0);
  });
  it("is case-insensitive", () => {
    expect(keywordScore("LOGIN", "login here")).toBeGreaterThan(0);
  });
});
