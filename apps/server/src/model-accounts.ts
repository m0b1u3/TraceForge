import { z } from "zod";
import { createDeviceModelGateway, type ModelGateway, validateEndpoint, type LlmEndpointConfig, type ModelConnectionDependencies, type OAuthTokenStore } from "@traceforge/llm";
import { MODEL_PROTOCOLS } from "@traceforge/shared/model-protocol";

const endpoint = z.string().max(2048).refine(value => { try { validateEndpoint(value); return true; } catch { return false; } });
export const ModelAccountManifestSchema = z.object({ version: z.literal(1), accounts: z.array(z.object({
  id: z.string().regex(/^[a-z][a-z0-9_.:-]{0,127}$/), label: z.string().trim().min(1).max(100),
  provider: z.enum(MODEL_PROTOCOLS),
  registration: z.object({ issuer: endpoint, clientId: z.string().trim().min(1).max(256),
    scopes: z.array(z.string().regex(/^[\w:.-]+$/)).min(1).max(32), apiBaseUrl: endpoint,
    verificationOrigins: z.array(z.string().url().refine(value => { try { return new URL(value).origin === value && value.startsWith("https://"); } catch { return false; } })).max(8).optional(),
    defaultTokenType: z.literal("Bearer").optional(), defaultTokenLifetimeSeconds: z.number().int().min(1).max(86400).optional(),
  }).strict(),
}).strict()).max(32) }).strict().superRefine((value, ctx) => {
  if (new Set(value.accounts.map(account => account.id)).size !== value.accounts.length) ctx.addIssue({ code: "custom", message: "Duplicate account reference" });
});
export type ModelAccountManifest = z.infer<typeof ModelAccountManifestSchema>;
type Login = Awaited<ReturnType<ModelGateway["beginLogin"]>>;

/** Trusted host-owned registrations only. Renderer cannot supply OAuth endpoints
 * or client identities. A login does not select a model or initiate inference.
 */
export class ModelAccounts {
  readonly gateway: ModelGateway;
  private readonly manifest: ModelAccountManifest;
  private pending = new Map<string, Login>();
  private busy = false;
  private closed = false;
  authorizationUrl(id: string): string {
    const login = this.pending.get(id);
    if (this.closed || !login || login.expiresAt <= Date.now()) throw new Error("Login unavailable");
    return login.verificationUrl;
  }
  constructor(manifest: ModelAccountManifest, store: OAuthTokenStore, dependencies: Omit<ModelConnectionDependencies, "credentials"> = {}) {
    this.manifest = ModelAccountManifestSchema.parse(manifest);
    this.gateway = createDeviceModelGateway(this.manifest.accounts, store, dependencies);
  }
  async list() {
    if (this.closed) throw new Error("Account controls closed");
    return Promise.all(this.manifest.accounts.map(async account => ({ id: account.id, label: account.label,
      provider: account.provider, baseUrl: account.registration.apiBaseUrl, issuer: account.registration.issuer,
      scopes: account.registration.scopes, status: await this.gateway.status(account.id) })));
  }
  assertConnection(config: Pick<LlmEndpointConfig, "credentialRef" | "baseUrl" | "provider" | "apiKey" | "authMode">) {
    if (!config.credentialRef) return;
    const account = this.manifest.accounts.find(item => item.id === config.credentialRef);
    if (!account || config.apiKey || config.authMode !== "bearer" || config.provider !== account.provider || !config.baseUrl ||
      new URL(config.baseUrl).href.replace(/\/+$/, "") !== new URL(account.registration.apiBaseUrl).href.replace(/\/+$/, "")) throw new Error("Account connection does not match its registration");
  }
  async operate(operation: "begin" | "poll" | "cancel" | "disconnect", id: string) {
    if (this.closed || this.busy) throw new Error("Account operation unavailable");
    if (!this.manifest.accounts.some(account => account.id === id)) throw new Error("Account registration unavailable");
    this.busy = true;
    try {
      if (operation === "begin") {
        const old = this.pending.get(id); if (old) this.gateway.cancelLogin(id, old.pendingId);
        this.pending.delete(id);
        const login = await this.gateway.beginLogin(id);
        if (this.closed) { this.gateway.cancelLogin(id, login.pendingId); throw new Error("Account controls closed"); }
        this.pending.set(id, login);
        const { pendingId: _private, ...view } = login;
        return { state: "pending" as const, login: view };
      }
      if (operation === "poll") {
        const login = this.pending.get(id); if (!login) throw new Error("Login unavailable");
        try {
          const state = await this.gateway.pollLogin(id, login.pendingId);
          if (state === "connected") this.pending.delete(id);
          return { state };
        } catch { this.gateway.cancelLogin(id, login.pendingId); this.pending.delete(id); throw new Error("Login failed; read account status before retrying"); }
      }
      const login = this.pending.get(id); if (login) this.gateway.cancelLogin(id, login.pendingId);
      this.pending.delete(id);
      if (operation === "disconnect") await this.gateway.disconnect(id);
      return { state: operation === "disconnect" ? "signed_out" as const : "canceled" as const };
    } finally { this.busy = false; }
  }
  close() { this.closed = true; this.gateway.cancelAllLogins(); this.pending.clear(); }
}
