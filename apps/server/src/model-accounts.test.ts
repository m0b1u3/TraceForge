import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelAccounts, ModelAccountManifestSchema, type ModelAccountManifest } from "./model-accounts.js";
import { LlmConfigService, type LlmSecretBundle } from "./llm-config-service.js";
import { registerModelSettingsRoutes } from "./model-settings-routes.js";
import type { OAuthTokenRecord, OAuthTokenStore } from "@traceforge/llm";

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
const manifest: ModelAccountManifest = { version: 1, accounts: [{ id: "first-account", label: "First account", provider: "responses",
  registration: { issuer: "https://identity.example", clientId: "installation-registration", scopes: ["api"], apiBaseUrl: "https://model.example/v1" } }] };
function fixture() {
  let now = 100000; let invalid = false; const tokens = new Map<string, OAuthTokenRecord>();
  const store: OAuthTokenStore = { async read(id) { return tokens.get(id); }, async write(id, value) { tokens.set(id, value); }, async remove(id) { tokens.delete(id); } };
  const sent: string[] = [];
  const dependencies = { now: () => now, fetch: (async (input, init) => {
    const request = new Request(input, init);
    if (request.url.endsWith("openid-configuration")) return Response.json({ issuer: "https://identity.example", device_authorization_endpoint: "https://identity.example/device", token_endpoint: "https://identity.example/token" });
    if (request.url.endsWith("/device")) return Response.json({ device_code: "private-device", user_code: "public-code", verification_uri: "https://identity.example/activate", expires_in: 600, interval: 1 });
    if (request.url.endsWith("/token")) return invalid ? Response.json({ error: "invalid_grant", error_description: "private-error" }, { status: 400 })
      : Response.json({ access_token: "private-access", refresh_token: "private-refresh", expires_in: 120, token_type: "Bearer" });
    sent.push(request.headers.get("authorization")!);
    return Response.json({ status: "completed", output: [{ type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: '{"ok":true}' }] }] });
  }) as typeof fetch };
  const accounts = new ModelAccounts(manifest, store, dependencies);
  return { accounts, store, dependencies, sent, tick() { now += 1000; }, expire() { now += 61000; }, invalidate() { invalid = true; }, tokens };
}

describe("host account connection lifecycle", () => {
  it("logs in, binds config, saves, restores, calls and disconnects through protected-shape routes", async () => {
    const f = fixture(); const dir = mkdtempSync(join(tmpdir(), "traceforge-accounts-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    let secrets: LlmSecretBundle = { alternativeRoutes: {} }; const secretStore = { load: () => secrets, save: (value: LlmSecretBundle) => { secrets = value; } };
    const service = new LlmConfigService(join(dir, "llm.json"), { secretStore, gateway: f.accounts.gateway });
    const app = Fastify(); cleanup.push(() => app.close()); registerModelSettingsRoutes(app, service, f.accounts);
    const control = async (operation: string) => (await app.inject({ method: "POST", url: "/api/desktop/models/account", payload: { operation, id: "first-account" } })).json();
    expect((await app.inject({ url: "/api/desktop/models" })).json().accounts[0].status).toBe("signed_out");
    const login = await control("begin"); expect(login.state).toBe("pending"); expect(JSON.stringify(login)).not.toContain("private-device");
    f.tick(); expect(await control("poll")).toEqual({ state: "connected" });
    const view = (await app.inject({ url: "/api/desktop/models" })).json();
    expect(JSON.stringify(view)).not.toMatch(/private-access|private-refresh/);
    const config = { provider: "responses", credentialRef: "first-account", model: "selected-model", baseUrl: "https://model.example/v1", authMode: "bearer" };
    for (const patch of [{ apiKey: "ambiguous" }, { authMode: "api_key" }, { baseUrl: "https://other.example/v1" }, { provider: "openai" }]) {
      expect((await app.inject({ method: "POST", url: "/api/desktop/models/save", payload: { expectedRevision: view.revision, config: { ...config, ...patch } } })).statusCode).not.toBe(200);
    }
    expect((await app.inject({ method: "POST", url: "/api/desktop/models/save", payload: { expectedRevision: view.revision, config } })).statusCode).toBe(200);
    const restoredAccounts = new ModelAccounts(manifest, f.store, f.dependencies);
    expect((await restoredAccounts.list())[0]!.status).toBe("connected");
    const restored = new LlmConfigService(join(dir, "llm.json"), { secretStore, gateway: restoredAccounts.gateway }); restored.initializeFromConfig();
    expect(await restored.getProvider().extractJson({ system: "JSON", user: "ping", schema: {} })).toEqual({ ok: true });
    await control("disconnect");
    await expect(restored.getProvider().extractJson({ system: "JSON", user: "ping", schema: {} })).rejects.toThrow();
    expect(f.sent).toEqual(["Bearer private-access"]);
  });
  it("cancels login, invalidates expired refresh credentials, and exposes no tokens", async () => {
    const f = fixture(); await f.accounts.operate("begin", "first-account");
    await f.accounts.operate("cancel", "first-account"); f.tick();
    await expect(f.accounts.operate("poll", "first-account")).rejects.toThrow(); expect(f.tokens.size).toBe(0);
    await f.accounts.operate("begin", "first-account"); f.tick(); await f.accounts.operate("poll", "first-account");
    f.expire(); expect((await f.accounts.list())[0]!.status).toBe("refresh_required");
    f.invalidate(); await expect(f.accounts.gateway.resolve("first-account")).rejects.toThrow();
    expect((await f.accounts.list())[0]!.status).toBe("signed_out");
  });
  it("rejects malformed registrations and closed controls", async () => {
    expect(ModelAccountManifestSchema.safeParse({ ...manifest, accounts: [...manifest.accounts, ...manifest.accounts] }).success).toBe(false);
    expect(ModelAccountManifestSchema.safeParse({ ...manifest, extra: "ignored" }).success).toBe(false);
    const f = fixture(); f.accounts.close(); await expect(f.accounts.operate("begin", "first-account")).rejects.toThrow();
    await expect(f.accounts.list()).rejects.toThrow();
  });
});
