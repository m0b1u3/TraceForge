import { describe, expect, it, vi } from "vitest";
import { createProvider } from "./factory.js";
import { responsesInput } from "./responses-provider.js";
import { createDeviceModelGateway } from "./device-model-gateway.js";
import type { OAuthTokenRecord } from "./device-authorization.js";

const message = (text: string) => ({ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] });
const completed = (output: unknown[]) => ({ status: "completed", output, usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } });
const call = { type: "function_call", status: "completed", call_id: "call-1", name: "inspect", arguments: '{"value":1}' };
const args = { system: "system", messages: [{ role: "user" as const, content: "inspect" }], tools: [{ name: "inspect", description: "inspect data", input_schema: { type: "object" } }] };
const config = { provider: "responses" as const, model: "explicit-model", apiKey: "fixture-only", baseUrl: "https://model.example/v1" };

describe("Responses protocol through the model gateway", () => {
  it("serializes structured output, parameters, headers and usage without supplier coupling", async () => {
    let request: Request | undefined; const usage = vi.fn();
    const provider = createProvider({ ...config, supplier: "xai", maxOutputTokens: 500, requestOptions: { reasoningEffort: "low" } }, {
      fetch: async (input, init) => { request = new Request(input, init); return Response.json(completed([message('{"ok":true}')])); },
    });
    expect(await provider.extractJson({ system: "JSON", user: "ping", schema: { type: "object" }, onUsage: usage })).toEqual({ ok: true });
    expect(request!.url).toBe("https://model.example/v1/responses");
    expect(request!.headers.get("authorization")).toBe("Bearer fixture-only");
    expect(await request!.json()).toMatchObject({ store: false, max_output_tokens: 500, reasoning: { effort: "low" }, text: { format: { type: "json_schema" } } });
    expect(usage).toHaveBeenCalledWith({ promptTokens: 2, completionTokens: 3, totalTokens: 5 });
  });
  it("round-trips function calls and results without executing tools", async () => {
    const bodies: unknown[] = [];
    const provider = createProvider(config, { fetch: async (input, init) => {
      bodies.push(await new Request(input, init).json());
      return Response.json(completed(bodies.length === 1 ? [call] : [message("finished")]));
    } });
    const first = await provider.runTools(args);
    expect(first).toMatchObject({ done: false, toolCalls: [{ id: "call-1", name: "inspect", input: { value: 1 } }] });
    const second = await provider.runTools({ ...args, messages: [...args.messages,
      { role: "assistant", content: first.text, toolCalls: first.toolCalls }, { role: "tool", toolCallId: "call-1", content: "result" }] });
    expect(second).toMatchObject({ text: "finished", done: true, toolCalls: [] });
    expect(bodies[1]).toMatchObject({ input: [{ role: "user", content: "inspect" },
      { type: "function_call", call_id: "call-1", name: "inspect", arguments: '{"value":1}' },
      { type: "function_call_output", call_id: "call-1", output: "result" }] });
    expect(() => responsesInput([{ role: "tool", toolCallId: "missing", content: "result" }])).toThrow(/matching/);
  });
  it("handles byte-fragmented CRLF SSE, text, final tool arguments and usage once", async () => {
    const frames = [ { type: "response.reasoning_summary_text.delta", delta: "公开摘要" }, { type: "response.output_text.delta", delta: "检查" },
      { type: "response.function_call_arguments.delta", delta: '{"value":' },
      { type: "response.completed", response: completed([{ type: "reasoning", summary: [{ type: "summary_text", text: "公开摘要" }] }, message("检查"), call]) } ];
    const bytes = new TextEncoder().encode(frames.map(frame => `data: ${JSON.stringify(frame)}\r\n\r\n`).join(""));
    let position = 0;
    const provider = createProvider(config, { fetch: async () => new Response(new ReadableStream({ pull(controller) {
      if (position === bytes.length) controller.close(); else controller.enqueue(bytes.slice(position, ++position));
    } }), { headers: { "content-type": "text/event-stream" } }) });
    const delta = vi.fn(); const usage = vi.fn(); const reasoning = vi.fn();
    expect(await provider.streamTools!(args, { onTextDelta: delta, onUsage: usage, onReasoningDelta: reasoning })).toMatchObject({ text: "检查", done: false, toolCalls: [{ input: { value: 1 } }] });
    expect(reasoning).toHaveBeenCalledExactlyOnceWith("公开摘要");
    expect(delta).toHaveBeenCalledExactlyOnceWith("检查"); expect(usage).toHaveBeenCalledTimes(1);
  });
  it.each([
    'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
    'data: {"type":"response.failed","error":{"message":"fixture-only"}}\n\n',
    'data: {"type":"response.incomplete"}\n\n',
    'data: not-json\n\n',
  ])("rejects incomplete or malformed streams without replay", async body => {
    const transport = vi.fn(async () => new Response(body, { headers: { "content-type": "text/event-stream" } }));
    await expect(createProvider(config, { fetch: transport }).streamTools!(args, {})).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each([
    { status: "incomplete", output: [call] },
    completed([{ ...call, arguments: "bad" }]), completed([call, call]),
    completed([{ type: "web_search_call" }]), completed([{ type: "reasoning", encrypted_content: "opaque" }]),
    completed([{ ...message(""), content: [{ type: "refusal", refusal: "no" }] }]),
  ])("rejects unsupported or invalid output instead of pretending completion", async body => {
    await expect(createProvider(config, { fetch: async () => Response.json(body) }).runTools(args)).rejects.toThrow();
  });
  it("sanitizes HTTP error bodies, does not retry, and respects cancellation", async () => {
    const transport = vi.fn(async () => new Response("fixture-only upstream private material", { status: 401 }));
    await expect(createProvider(config, { fetch: transport }).runTools(args)).rejects.toThrow("Model request failed (HTTP 401)");
    expect(transport).toHaveBeenCalledTimes(1);
    const controller = new AbortController(); controller.abort();
    await expect(createProvider(config, { fetch: transport }).streamTools!(args, { signal: controller.signal })).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("rejects unsupported options before sending requests", () => {
    expect(() => createProvider({ ...config, requestOptions: { thinking: "enabled" } })).toThrow(/thinking/);
    expect(() => createProvider({ ...config, embeddingModel: "embed" })).toThrow(/embeddings/);
  });
  it("assembles approved device authorization, refresh, protocol calls and disconnect through one gateway", async () => {
    let now = 100000; let refreshes = 0; const sent: string[] = []; const records = new Map<string, OAuthTokenRecord>();
    const gateway = createDeviceModelGateway([{ id: "account-a", registration: {
      issuer: "https://identity.example", clientId: "traceforge-fixture", scopes: ["api"], apiBaseUrl: config.baseUrl,
    } }], { async read(id) { return records.get(id); }, async write(id, record) { records.set(id, record); }, async remove(id) { records.delete(id); } }, {
      now: () => now, fetch: async (input, init) => {
        const request = new Request(input, init);
        if (request.url.endsWith("openid-configuration")) return Response.json({ issuer: "https://identity.example", device_authorization_endpoint: "https://identity.example/device", token_endpoint: "https://identity.example/token" });
        if (request.url.endsWith("/device")) return Response.json({ device_code: "private", user_code: "public", verification_uri: "https://identity.example/activate", expires_in: 600, interval: 1 });
        if (request.url.endsWith("/token")) {
          const refreshing = (await request.text()).includes("grant_type=refresh_token"); if (refreshing) refreshes++;
          return Response.json({ access_token: refreshing ? "fresh" : "initial", refresh_token: "refresh", expires_in: 120, token_type: "Bearer" });
        }
        sent.push(request.headers.get("authorization")!);
        expect(await request.text()).not.toMatch(/initial|fresh|refresh/);
        return Response.json(completed([message("ok")]));
      },
    });
    const login = await gateway.beginLogin("account-a");
    expect(JSON.stringify(login)).not.toContain("private"); now += 1000;
    expect(await gateway.pollLogin("account-a", login.pendingId)).toBe("connected");
    const provider = gateway.createProvider({ ...config, apiKey: undefined, credentialRef: "account-a" });
    await provider.runTools(args); now += 61000;
    await Promise.all([provider.runTools(args), provider.runTools(args)]);
    expect(refreshes).toBe(1); expect(sent).toEqual(["Bearer initial", "Bearer fresh", "Bearer fresh"]);
    await gateway.disconnect("account-a"); await expect(provider.runTools(args)).rejects.toThrow(); expect(sent).toHaveLength(3);
    expect(() => gateway.createProvider({ ...config, apiKey: undefined, credentialRef: "unknown" })).toThrow(/unavailable/);
  });
});
