import { describe, expect, it, vi } from "vitest";
import { ModelGateway } from "./model-gateway.js";
import type { ModelAccountConnection } from "./model-account.js";
import { MODEL_PROTOCOLS, MODEL_SUPPLIER_IDS } from "@traceforge/shared/model-protocol";
import { LlmEndpointConfigSchema } from "./config.js";
import { MODEL_SUPPLIERS } from "./connections.js";

function account(): ModelAccountConnection {
  return {
    begin: vi.fn(async () => ({ pendingId: "pending", userCode: "code", verificationUrl: "https://identity.example", expiresAt: 1000, intervalMs: 100 })),
    poll: vi.fn(async () => "connected" as const), cancel: vi.fn(), cancelAll: vi.fn(),
    status: vi.fn(async () => "connected" as const), disconnect: vi.fn(async () => {}),
    resolve: vi.fn(async () => ({ value: "fixture-token", baseUrl: "https://model.example/v1" })),
  };
}

describe("protocol and account boundaries", () => {
  it("dispatches using an injected account without device authorization or token storage", async () => {
    const connection = account();
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Request(input, init).headers.get("authorization")).toBe("Bearer fixture-token");
      return Response.json({ status: "completed", output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok" }] }] });
    });
    const gateway = new ModelGateway([{ id: "first", connection }], { fetch: transport });
    const signal = new AbortController().signal;
    expect((await gateway.beginLogin("first", signal)).pendingId).toBe("pending");
    expect(await gateway.pollLogin("first", "pending", signal)).toBe("connected");
    expect(connection.poll).toHaveBeenCalledWith("pending", "first", signal);
    expect(await gateway.status("first")).toBe("connected");
    const provider = gateway.createProvider({ provider: "responses", model: "fixture", baseUrl: "https://model.example/v1", credentialRef: "first" });
    expect((await provider.runTools({ system: "test", messages: [{ role: "user", content: "hello" }], tools: [] })).text).toBe("ok");
    gateway.cancelLogin("first", "pending");
    expect(connection.cancel).toHaveBeenCalledWith("pending");
    gateway.cancelAllLogins();
    await gateway.disconnect("first");
    expect(connection.cancelAll).toHaveBeenCalledTimes(2);
    expect(connection.disconnect).toHaveBeenCalledWith("first");
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("rejects invalid, duplicate and missing account references", () => {
    const connection = account();
    expect(() => new ModelGateway([{ id: "invalid id", connection }])).toThrow(/Invalid/);
    expect(() => new ModelGateway([{ id: "first", connection }, { id: "first", connection }])).toThrow(/duplicate/);
    expect(() => new ModelGateway([]).beginLogin("missing")).toThrow(/unavailable/);
  });
  it("shares the supported vocabulary without turning supplier presets into protocol restrictions", () => {
    expect(Object.keys(MODEL_SUPPLIERS).sort()).toEqual([...MODEL_SUPPLIER_IDS].sort());
    for (const provider of MODEL_PROTOCOLS) {
      expect(LlmEndpointConfigSchema.parse({ provider, model: "fixture", supplier: "xai" }).provider).toBe(provider);
    }
    expect(LlmEndpointConfigSchema.safeParse({ provider: "unknown", model: "fixture" }).success).toBe(false);
  });
});
