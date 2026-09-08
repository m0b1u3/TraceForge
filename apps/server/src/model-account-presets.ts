import type { ModelAccountManifest } from "./model-accounts.js";

/** Public-client compatibility, not a TraceForge-owned or partner registration.
 * Source: xai-org/grok-build auth/config.rs and CC Switch xai_oauth_auth.rs.
 * No tokens, client secrets, local account imports or login on startup.
 */
export function defaultModelAccounts(): ModelAccountManifest {
  return { version: 1, accounts: [{ id: "grok-compatible", label: "Grok 兼容登录（公开客户端，待账号验收）", provider: "responses",
    registration: { issuer: "https://auth.x.ai", clientId: "b1a00492-073a-47ea-816f-4c329264a828",
      scopes: ["openid", "profile", "email", "offline_access", "grok-cli:access", "api:access"],
      apiBaseUrl: "https://api.x.ai/v1", verificationOrigins: ["https://accounts.x.ai"],
      defaultTokenType: "Bearer", defaultTokenLifetimeSeconds: 3600 } }] };
}
