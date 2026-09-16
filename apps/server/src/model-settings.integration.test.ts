import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Fastify from "fastify";
import { LlmConfigService, type LlmSecretBundle } from "./llm-config-service.js";
import { createDb, getSqliteClient } from "./db/client.js";
import { FoundationHostControl } from "./foundation-host-control.js";
import { registerModelSettingsRoutes } from "./model-settings-routes.js";
import { createModelSettingsBridge } from "../../desktop/src/model-settings-bridge.js";
import { ModelSettingsClient } from "../../web/renderer/model-settings-client.js";
import { buildModelSettingsHost } from "./model-settings-host.js";
import { ModelGateway } from "@traceforge/llm";

const cleanup: Array<() => unknown> = [];
afterEach(async () => { vi.useRealTimers(); for (const fn of cleanup.splice(0).reverse()) await fn(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "traceforge-model-settings-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  let secrets: LlmSecretBundle = { alternativeRoutes: {} }; let failSave = false; let failTest = false;
  const store = { load: () => structuredClone(secrets), save: (next: LlmSecretBundle) => { secrets = structuredClone(next); if (failSave) throw new Error("crash after secret write"); } };
  const seen: Array<{ model: string; apiKey?: string }> = [];
  const deps = { secretStore: store, createProvider: (config: { model: string; apiKey?: string }) => {
    seen.push(config);
    return { extractJson: async () => { if (failTest) throw new Error(`upstream echoed ${config.apiKey}`); return { ok: true, model: config.model }; }, runTools: async () => ({ done: true, text: "", toolCalls: [] }) };
  } };
  const service = new LlmConfigService(join(dir, "llm.json"), deps);
  return { dir, service, store, deps, seen, failSave: () => { failSave = true; }, failTest: () => { failTest = true; } };
}
const config = { provider: "openai" as const, supplier: "deepseek" as const, model: "explicit-model", baseUrl: "https://api.deepseek.com", apiKey: "fixture-secret-only" };

describe("complete model settings control flow", () => {
  it("persists capability snapshots, consumes budgets and explicitly clears same-model overrides", async () => {
    const f = fixture(); const requests: Request[] = [];
    const gateway = new ModelGateway([], { fetch: async (input, init) => {
      const request = new Request(input, init); requests.push(request);
      return request.method === "GET" ? Response.json({data:[{id:"explicit-model",context_length:64000,max_output_tokens:1024}]}) :
        Response.json({choices:[{message:{role:"assistant",content:'{"ok":true}'},finish_reason:"stop"}]});
    }});
    const path = join(f.dir,"profiles.json");
    const service = new LlmConfigService(path,{secretStore:f.store,gateway});
    const app = Fastify(); cleanup.push(()=>app.close()); registerModelSettingsRoutes(app,service);
    const bridge = createModelSettingsBridge({webContentsId:7,origin:"http://127.0.0.1:43333",request:async(url,payload)=>{
      const response=await app.inject({method:"POST",url,payload:JSON.stringify(payload),headers:{"content-type":"application/json"}});
      return {status:response.statusCode,body:response.json()};
    }});
    const client=new ModelSettingsClient({protocolVersion:1,request:input=>bridge.request({webContentsId:7,mainFrame:true,url:"http://127.0.0.1:43333/"},input)});
    const catalog=await client.discover(service.settings().revision,{...config,model:""});
    const modelProfile=catalog.models[0].profile!;
    expect(modelProfile).toMatchObject({contextWindowTokens:64000,maxOutputTokens:1024,source:"catalog"});
    const saved=await client.save(service.settings().revision,{...config,modelProfile,contextWindowTokens:16000,maxOutputTokens:512});
    const oldProvider=service.getConversationProvider();
    await client.save(saved.revision,{...config,apiKey:undefined,contextWindowTokens:null,maxOutputTokens:null});
    const reopened=new LlmConfigService(path,{secretStore:f.store,gateway});
    expect(reopened.initializeFromConfig().modelProfile).toEqual(modelProfile);
    const args={system:"JSON",user:"ping",schema:{}};
    await reopened.getProvider().extractJson(args); await oldProvider.extractJson(args);
    expect((await requests[1].json()).max_tokens).toBe(1024);
    expect((await requests[2].json()).max_tokens).toBe(512);
    await client.save(service.settings().revision,{...config,apiKey:undefined,modelProfile:null});
    expect(service.settings().config?.modelProfile).toBeNull();
    expect(readFileSync(path,"utf8")).not.toContain(config.apiKey);
  });
  it("discovers through the desktop bridge without a model ID, saving or inference", async () => {
    const f = fixture(); const requests: Request[] = [];
    const gateway = new ModelGateway([], {
      fetch: async input => { requests.push(new Request(input)); return Response.json({ data: [{ id: "discovered-model" }] }); },
    });
    const service = new LlmConfigService(join(f.dir, "catalog.json"), { secretStore: f.store, gateway });
    const app = Fastify(); cleanup.push(() => app.close()); registerModelSettingsRoutes(app, service);
    const bridge = createModelSettingsBridge({ webContentsId: 7, origin: "http://127.0.0.1:43333", request: async (url, payload) => {
      const response = await app.inject({ method: "POST", url, payload: JSON.stringify(payload), headers: { "content-type": "application/json" } });
      return { status: response.statusCode, body: response.json() };
    } });
    const client = new ModelSettingsClient({ protocolVersion: 1, request: input => bridge.request({ webContentsId: 7, mainFrame: true, url: "http://127.0.0.1:43333/" }, input) });
    const revision = service.settings().revision;
    expect(await client.discover(revision, { ...config, model: "" })).toEqual({ models: [{ id: "discovered-model" }], truncated: false });
    expect(service.settings().configured).toBe(false); expect(requests[0].method).toBe("GET");
    await expect(client.discover("f".repeat(64), { ...config, model: "" })).rejects.toThrow("配置已被其他操作改变");
    expect(requests).toHaveLength(1);
    service.reload(config);
    await client.discover(service.settings().revision, { ...config, model: "", apiKey: undefined });
    expect(requests[1].headers.get("authorization")).toBe(`Bearer ${config.apiKey}`);
    await expect(client.discover(service.settings().revision, { ...config, model: "", apiKey: undefined, baseUrl: "https://second.example/v1" })).rejects.toThrow("无权读取");
    expect(requests).toHaveLength(2);
  });
  it("persists and dispatches Responses through the host's injected gateway", async () => {
    const f = fixture(); const requests: Request[] = [];
    const gateway = new ModelGateway([], {
      fetch: async (input, init) => { requests.push(new Request(input, init)); return Response.json({ status: "completed",
        output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: '{"ok":true}' }] }] }); },
    });
    const service = new LlmConfigService(join(f.dir, "responses.json"), { secretStore: f.store, gateway });
    const app = Fastify(); cleanup.push(() => app.close()); registerModelSettingsRoutes(app, service);
    const draft = { ...config, provider: "responses", supplier: "xai", baseUrl: "https://model.example/v1" };
    const payload = { expectedRevision: service.settings().revision, config: draft };
    expect((await app.inject({ method: "POST", url: "/api/desktop/models/test", payload })).json().ok).toBe(true);
    expect(service.settings().configured).toBe(false);
    expect((await app.inject({ method: "POST", url: "/api/desktop/models/save", payload })).statusCode).toBe(200);
    const reopened = new LlmConfigService(join(f.dir, "responses.json"), { secretStore: f.store, gateway });
    expect(reopened.initializeFromConfig().provider).toBe("responses");
    expect(await reopened.getProvider().extractJson({ system: "JSON", user: "ping", schema: {} })).toEqual({ ok: true });
    expect(requests.map(request => request.url)).toEqual(["https://model.example/v1/responses", "https://model.example/v1/responses"]);
  });
  it("keeps settings operations off the browser HTTP server", async () => {
    const f = fixture();
    writeFileSync(join(f.dir, "index.html"), "<main>settings</main>");
    const host = await buildModelSettingsHost(f.dir, join(f.dir, "llm.json"), f.store);
    cleanup.push(() => host.close());
    expect((await host.web.inject({ url: "/" })).statusCode).toBe(200);
    for (const method of ["GET", "POST"] as const) {
      expect((await host.web.inject({ method, url: "/api/desktop/models" })).statusCode).toBe(404);
      expect((await host.web.inject({ method, url: "/api/desktop/models/save" })).statusCode).toBe(404);
    }
    expect((await host.request("/api/desktop/models")).status).toBe(200);
  });
  it("loads unconfigured state, tests without saving, saves, reopens and enforces revision through the real host and bridge", async () => {
    const f = fixture(); const db = createDb(":memory:"); const app = Fastify();
    cleanup.push(() => getSqliteClient(db).close(), () => app.close());
    const control = new FoundationHostControl(app, getSqliteClient(db)); const channel = control.management();
    registerModelSettingsRoutes(app, f.service);
    const bridge = createModelSettingsBridge({ webContentsId: 3, origin: "http://127.0.0.1:43333", request: async (url, payload) => {
      const response = await app.inject({ url, method: payload === undefined ? "GET" : "POST", ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }), headers: { ...channel.headers(), ...(payload === undefined ? {} : { "content-type": "application/json" }) } });
      return { status: response.statusCode, body: response.json() };
    } });
    const client = new ModelSettingsClient({ protocolVersion: 1, request: input => bridge.request({ webContentsId: 3, mainFrame: true, url: "http://127.0.0.1:43333/" }, input) });
    const empty = await client.load(); expect(empty.configured).toBe(false);
    expect(await client.test(empty.revision, config)).toBe(true); expect(f.service.settings().configured).toBe(false);
    const saved = await client.save(empty.revision, config); expect(saved.config?.apiKeyMasked).toBe("••••••••");
    expect(JSON.stringify(saved)).not.toContain(config.apiKey);
    expect(readFileSync(join(f.dir, "llm.json"), "utf8")).not.toContain(config.apiKey);
    expect(new LlmConfigService(join(f.dir, "llm.json"), f.deps).initializeFromConfig().model).toBe(config.model);
    await expect(client.save(empty.revision, config)).rejects.toThrow("已被其他操作改变");
    expect((await app.inject("/api/desktop/models")).statusCode).toBe(401);
    const worker = control.worker({ id: "worker", roles: ["researcher"], capabilities: [], maxConcurrentWork: 1 } as Parameters<typeof control.worker>[0], "neutral", 1);
    expect((await app.inject({ url: "/api/desktop/models", headers: worker.headers() })).statusCode).toBe(403);
    await expect(bridge.request({ webContentsId: 3, mainFrame: false, url: "http://127.0.0.1:43333/" }, { operation: "load" })).rejects.toThrow("Untrusted");
    await expect(bridge.request({ webContentsId: 3, mainFrame: true, url: "http://127.0.0.1:43334/" }, { operation: "load" })).rejects.toThrow("Untrusted");
  });
  it("keeps old metadata and active provider when publication is interrupted after secret storage", async () => {
    const f = fixture(); f.service.reload(config);
    f.failSave();
    expect(() => f.service.reload({ ...config, model: "next-model", baseUrl: "https://second.example/v1", apiKey: "next-secret" })).toThrow();
    expect(await f.service.getProvider().extractJson({ system: "", user: "", schema: {} })).toMatchObject({ model: "explicit-model" });
    const reopened = new LlmConfigService(join(f.dir, "llm.json"), f.deps);
    expect(reopened.initializeFromConfig().baseUrl).toBe(config.baseUrl);
    expect(f.seen.at(-1)?.apiKey).toBe(config.apiKey);
  });
  it("does not overwrite corrupt config or expose upstream secrets in errors", async () => {
    const f = fixture(); f.failTest();
    const result = await f.service.test(config); expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain(config.apiKey);
    writeFileSync(join(f.dir, "llm.json"), "broken config");
    expect(() => f.service.reload(config)).toThrow();
    expect(readFileSync(join(f.dir, "llm.json"), "utf8")).toBe("broken config");
  });
  it("bounds test duration and prevents overlapping probes", async () => {
    vi.useFakeTimers(); const f = fixture(); let signal: AbortSignal | undefined;
    const service = new LlmConfigService(join(f.dir, "llm.json"), { secretStore: f.store, createProvider: () => ({
      extractJson: async args => { signal = args.signal; return new Promise(() => {}); }, runTools: async () => ({ done: true, text: "", toolCalls: [] }),
    }) });
    const pending = service.test(config);
    expect((await service.test(config)).ok).toBe(false);
    await vi.advanceTimersByTimeAsync(30001);
    expect((await pending).error).toContain("超时"); expect(signal?.aborted).toBe(true);
  });
});
