import { createProvider } from "./factory.js";
import { discoverModels } from "./model-catalog.js";
import type { LlmEndpointConfig } from "./config.js";
import type { ModelConnectionDependencies, ModelCredentialResolver } from "./connections.js";
import type { ModelAccountBinding, ModelAccountConnection } from "./model-account.js";

/** In-process model gateway, not a public proxy. Hosts inject registration and
 * encrypted persistence; protocol adapters receive only a credential resolver.
 * Scheduling, budgets and tool execution remain in the existing runtime.
 */
export class ModelGateway implements ModelCredentialResolver {
  private readonly accounts = new Map<string, ModelAccountConnection>();
  constructor(registrations: readonly ModelAccountBinding[],
    private readonly dependencies: Omit<ModelConnectionDependencies, "credentials"> = {}) {
    for (const entry of registrations) {
      if (!/^[a-z][a-z0-9_.:-]{0,127}$/.test(entry.id) || this.accounts.has(entry.id)) throw new Error("Invalid or duplicate model account registration");
      this.accounts.set(entry.id, entry.connection);
    }
  }
  private account(id: string) {
    const account = this.accounts.get(id);
    if (!account) throw new Error("Model account registration is unavailable");
    return account;
  }
  createProvider(config: LlmEndpointConfig) {
    if (config.credentialRef) this.account(config.credentialRef);
    return createProvider(config, { ...this.dependencies, credentials: this });
  }
  beginLogin(id: string, signal?: AbortSignal) { return this.account(id).begin(signal); }
  discoverModels(config: LlmEndpointConfig, signal?: AbortSignal) { return discoverModels(config, { ...this.dependencies, credentials: this }, signal); }
  pollLogin(id: string, pendingId: string, signal?: AbortSignal) { return this.account(id).poll(pendingId, id, signal); }
  cancelLogin(id: string, pendingId: string) { this.account(id).cancel(pendingId); }
  cancelAllLogins() { for (const account of this.accounts.values()) account.cancelAll(); }
  status(id: string) { return this.account(id).status(id); }
  disconnect(id: string) { const account = this.account(id); account.cancelAll(); return account.disconnect(id); }
  resolve(id: string, signal?: AbortSignal) { return this.account(id).resolve(id, signal); }
}
