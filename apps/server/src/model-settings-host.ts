import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { LlmConfigService, type LlmSecretStore } from "./llm-config-service.js";
import { registerModelSettingsRoutes } from "./model-settings-routes.js";
import { ModelAccounts, type ModelAccountManifest } from "./model-accounts.js";
import type { OAuthTokenStore } from "@traceforge/llm";
export { ModelAccountManifestSchema, type ModelAccountManifest } from "./model-accounts.js";
export { defaultModelAccounts } from "./model-account-presets.js";
export { ModelAccounts } from "./model-accounts.js";
export type { OAuthTokenStore, OAuthTokenRecord } from "@traceforge/llm";

/** Settings-only desktop host. The model API server never listens on a socket;
 * only the isolated main-process bridge can inject its three operations.
 */
export async function buildModelSettingsHost(webRoot: string, configPath: string, secretStore: LlmSecretStore,
  accountOptions?: { manifest: ModelAccountManifest; store: OAuthTokenStore }) {
  const controls = Fastify({ logger: false });
  const accounts = accountOptions ? new ModelAccounts(accountOptions.manifest, accountOptions.store) : undefined;
  const service = new LlmConfigService(configPath, { secretStore, gateway: accounts?.gateway });
  registerModelSettingsRoutes(controls, service, accounts);
  await controls.ready();
  const web = Fastify({ logger: false });
  await web.register(fastifyStatic, { root: webRoot });
  return { web,
    authorizationUrl(id: string) {
      if (!accounts) throw new Error("Account registration unavailable");
      return accounts.authorizationUrl(id);
    },
    async request(url: string, payload?: unknown) {
      const response = await controls.inject({ url, method: payload === undefined ? "GET" : "POST",
        ...(payload === undefined ? {} : { payload: JSON.stringify(payload), headers: { "content-type": "application/json" } }) });
      return { status: response.statusCode, body: response.json() };
    },
    async close() { accounts?.close(); await controls.close(); await web.close(); },
  };
}
