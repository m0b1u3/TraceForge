import type { StartProcessRequest } from "./protocol.js";

/** Host-owned, execution-scoped authority. Never deserialize this from RPC or a
 * model tool argument. The resolver must bind it to the exact current invocation.
 * A network binding denotes access to a broker endpoint, not destination consent. */
export interface MacosExecutionBinding {
  brokerPort?: number;
  environment?: Readonly<Record<string, string>>;
  signal: AbortSignal;
  assertCurrent(): void;
  /** Close all connections and release the endpoint, including on launch failure. */
  release(): Promise<void>;
}
export type MacosExecutionBindingResolver = (request: Readonly<StartProcessRequest>) => Promise<MacosExecutionBinding | undefined>;

/** Apply only inside Seatbelt, never to the unsandboxed native supervisor. */
export function sandboxEnvironmentArguments(environment: Readonly<Record<string, string>>): string[] {
  const allowed = new Set(["PATH", "HOME", "TMPDIR", "PYTHONPATH", "VIRTUAL_ENV", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "no_proxy", "ALL_PROXY", "all_proxy", "WS_PROXY", "WSS_PROXY", "PIP_CONFIG_FILE", "PIP_DISABLE_PIP_VERSION_CHECK", "NPM_CONFIG_USERCONFIG", "NPM_CONFIG_CACHE"]);
  const entries = Object.entries(environment);
  if (entries.length > allowed.size) throw new Error("Host execution environment exceeds capacity");
  for (const [name, value] of entries) {
    if (!allowed.has(name) || typeof value !== "string" || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value))
      throw new Error("Invalid host execution environment");
  }
  return entries.sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => `${name}=${value}`);
}
