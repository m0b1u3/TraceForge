import type { ScopeRule } from "@traceforge/shared";

function hostMatches(host: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1); // ".target.com"
    return host.endsWith(suffix) && host !== suffix.slice(1);
  }
  return host === pattern;
}

function candidateHosts(url: URL): string[] {
  const host = url.hostname;
  const hostWithPort = url.port ? `${url.hostname}:${url.port}` : url.hostname;
  return hostWithPort === host ? [host] : [hostWithPort, host];
}

export function checkScope(
  url: string,
  rules: ScopeRule[],
): { allowed: boolean; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: "invalid URL" };
  }
  const hosts = candidateHosts(parsed);
  const displayHost = hosts[0];

  for (const rule of rules) {
    if (rule.denyHosts.some((p) => hosts.some((h) => hostMatches(h, p)))) {
      return { allowed: false, reason: `host ${displayHost} is explicitly denied` };
    }
  }
  for (const rule of rules) {
    if (rule.allowHosts.some((p) => hosts.some((h) => hostMatches(h, p)))) {
      return { allowed: true, reason: `host ${displayHost} is in scope` };
    }
  }
  return { allowed: false, reason: `host ${displayHost} is out of scope (deny-by-default)` };
}
