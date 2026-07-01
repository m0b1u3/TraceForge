import { describe, expect, it } from "vitest";
import { isRetryableError, withRetry } from "./retry.js";

describe("withRetry", () => {
  it("retries transient failures and returns the successful result", async () => {
    let attempts = 0;
    const result = await withRetry("unit", async () => {
      attempts += 1;
      if (attempts < 3) {
        const err = new Error("temporarily unavailable") as Error & { status?: number };
        err.status = 503;
        throw err;
      }
      return "ok";
    }, { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 });

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("stops after max attempts and rethrows the final error", async () => {
    let attempts = 0;
    await expect(withRetry("unit", async () => {
      attempts += 1;
      const err = new Error("rate limited") as Error & { status?: number };
      err.status = 429;
      throw err;
    }, { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 })).rejects.toThrow("rate limited");

    expect(attempts).toBe(2);
  });

  it("does not retry non-retryable client failures", async () => {
    let attempts = 0;
    await expect(withRetry("unit", async () => {
      attempts += 1;
      const err = new Error("bad request") as Error & { status?: number };
      err.status = 400;
      throw err;
    }, { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 })).rejects.toThrow("bad request");

    expect(attempts).toBe(1);
  });

  it("does not retry aborted operations", async () => {
    const controller = new AbortController();
    controller.abort();
    let attempts = 0;

    await expect(withRetry("unit", async () => {
      attempts += 1;
      throw new DOMException("aborted", "AbortError");
    }, { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, signal: controller.signal })).rejects.toThrow("aborted");

    expect(attempts).toBe(0);
  });
});

describe("isRetryableError", () => {
  it("classifies retryable HTTP and network failures", () => {
    expect(isRetryableError(Object.assign(new Error("fetch failed"), { status: 503 }))).toBe(true);
    expect(isRetryableError(Object.assign(new Error("bad auth"), { status: 401 }))).toBe(false);
    expect(isRetryableError(new Error("ECONNRESET while reading"))).toBe(true);
    expect(isRetryableError(new SyntaxError("Unexpected token"))).toBe(false);
  });
});
