import { expect, it, vi } from "vitest";
import { ModelContextOverflowError } from "@traceforge/shared/model-context";
import { normalizeContextOverflow, responseContextOverflow } from "./context-overflow.js";
import { createProvider } from "./factory.js";
import { withContextBudget } from "./context-budget-provider.js";

it.each([
  { status: 400, code: "context_length_exceeded" },
  { status: 400, error: { type: "invalid_request_error", message: "prompt is too long: private details" } },
])("normalizes only explicit request rejection without leaking diagnostic text", error => {
  const normalized = normalizeContextOverflow(error);
  expect(normalized).toBeInstanceOf(ModelContextOverflowError);
  expect(String(normalized)).not.toContain("private");
});
it.each([
  { status: 500, code: "context_length_exceeded" }, { status: 400, message: "context too long" },
  { status: 400, error: { type: "invalid_request_error", message: "Invalid tool schema" } },
  new Error("context_length_exceeded"),
])("does not mistake arbitrary errors for safe input rejection", error => expect(normalizeContextOverflow(error)).toBe(error));
it("bounds error-body reads and does not expose arbitrary HTML or oversized JSON", async () => {
  expect(await responseContextOverflow(new Response("private error page", { status: 400 }))).toBeUndefined();
  expect(await responseContextOverflow(Response.json({ error: { code: "context_length_exceeded", message: "x".repeat(20000) } }, { status: 400 }))).toBeUndefined();
});
it("preserves explicit Responses rejection through its transport catch without automatic retries", async () => {
  const fetch = vi.fn(async () => Response.json({ error: { code: "context_length_exceeded", message: "private upstream" } }, { status: 400 }));
  const provider = createProvider({ provider: "responses", model: "fixture", apiKey: "fixture", baseUrl: "https://model.example/v1" }, { fetch });
  await expect(provider.extractJson({ system: "s", user: "u", schema: {} })).rejects.toBeInstanceOf(ModelContextOverflowError);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("normalizes SDK JSON rejection but never retries model requests itself", async () => {
  const extractJson = vi.fn(async () => { throw { status: 400, code: "context_length_exceeded" }; });
  const provider = withContextBudget({ extractJson, runTools: vi.fn() }, {});
  await expect(provider.extractJson({ system: "s", user: "u", schema: {} })).rejects.toBeInstanceOf(ModelContextOverflowError);
  expect(extractJson).toHaveBeenCalledTimes(1);
});
