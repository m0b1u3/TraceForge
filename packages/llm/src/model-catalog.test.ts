import { describe, expect, it, vi } from "vitest";
import { discoverModels } from "./model-catalog.js";

const config = { provider: "responses" as const, model: "unused", baseUrl: "https://models.example/v1", credentialRef: "first", authMode: "bearer" as const };
describe("model discovery", () => {
  it.each(["https://models.example/coding", "https://models.example/anthropic"])("preserves Messages API prefix %s",async baseUrl=>{
    await discoverModels({provider:"anthropic",model:"unused",baseUrl,apiKey:"fixture"},{fetch:async input=>{
      expect(new Request(input).url).toBe(`${baseUrl}/v1/models`);
      return Response.json({data:[]});
    }});
  });
  it("does not send a cancelled discovery or guess models", async () => {
    const abort = new AbortController(); abort.abort(); const fetch = vi.fn();
    await expect(discoverModels(config, { fetch }, abort.signal)).rejects.toMatchObject({code:"unavailable"});
    expect(fetch).not.toHaveBeenCalled();
  });
  it("resolves bound credentials, only reads metadata and deduplicates IDs", async () => {
    const requests: Request[] = [];
    const result = await discoverModels(config, { credentials: { resolve: async () => ({ value: "fixture-token", baseUrl: config.baseUrl }) }, fetch: async (input, init) => {
      requests.push(new Request(input, init)); return Response.json({ data: [{ id: "second" }, { id: "first" }, { id: "second" }] });
    } });
    expect(result).toEqual({ models: [{ id: "first" }, { id: "second" }], truncated: false });
    expect(requests).toHaveLength(1); expect(requests[0].method).toBe("GET"); expect(requests[0].url).toBe(config.baseUrl + "/models");
    expect(requests[0].headers.get("authorization")).toBe("Bearer fixture-token"); expect(await requests[0].text()).toBe("");
    expect(JSON.stringify(result)).not.toContain("fixture-token");
  });
  it("uses protocol-specific headers and root path without changing origins", async () => {
    await discoverModels({ provider: "anthropic", model: "unused", baseUrl: "https://models.example", apiKey: "fixture-key" }, { fetch: async input => {
      const request = new Request(input); expect(request.url).toBe("https://models.example/v1/models");
      expect(request.headers.get("x-api-key")).toBe("fixture-key"); expect(request.headers.get("anthropic-version")).toBe("2023-06-01");
      return Response.json({ data: [], has_more: true });
    } }).then(result => expect(result).toEqual({ models: [], truncated: true }));
  });
  it("rejects endpoint escape before transmitting a credential", async () => {
    const fetch = vi.fn();
    await expect(discoverModels(config, { fetch, credentials: { resolve: async () => ({ value: "secret", baseUrl: "https://other.example/v1" }) } })).rejects.toMatchObject({ code: "unavailable" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([[401, "unauthorized"], [403, "unauthorized"], [404, "unsupported"], [429, "rate_limited"], [500, "unavailable"], [302, "unavailable"]])("sanitizes HTTP %s without retry or redirect", async (status, code) => {
    const fetch = vi.fn(async () => new Response("private upstream details", { status: Number(status), headers: { location: "https://other.example" } }));
    await expect(discoverModels({ ...config, credentialRef: undefined, apiKey: "fixture" }, { fetch })).rejects.toMatchObject({ code, message: code });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([{ wrong: [] }, { data: [{ id: "bad\nmodel" }] }, { data: [{ id: "a".repeat(201) }] }])("rejects malformed directory", async value => {
    await expect(discoverModels({ ...config, credentialRef: undefined, apiKey: "fixture" }, { fetch: async () => Response.json(value) })).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("bounds response bytes and flags partial lists", async () => {
    await expect(discoverModels({ ...config, credentialRef: undefined, apiKey: "fixture" }, { fetch: async () => new Response("x".repeat(1024 * 1024 + 1)) })).rejects.toMatchObject({ code: "invalid_response" });
    const result = await discoverModels({ ...config, credentialRef: undefined, apiKey: "fixture" }, { fetch: async () => Response.json({ data: Array.from({ length: 1001 }, (_, i) => ({ id: `model-${i}` })) }) });
    expect(result.models).toHaveLength(1000); expect(result.truncated).toBe(true);
  });
});
