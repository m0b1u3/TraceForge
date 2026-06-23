import type { ScopeRule } from "@traceforge/shared";

function hostMatches(host: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1); // ".target.com"
    return host.endsWith(suffix) && host !== suffix.slice(1);
  }
  return host === pattern;
}

export function checkScope(
  url: string,
  rules: ScopeRule[],
): { allowed: boolean; reason: string } {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return { allowed: false, reason: "invalid URL" };
  }

  for (const rule of rules) {
    if (rule.denyHosts.some((p) => hostMatches(host, p))) {
      return { allowed: false, reason: `host ${host} is explicitly denied` };
    }
  }
  for (const rule of rules) {
    if (rule.allowHosts.some((p) => hostMatches(host, p))) {
      return { allowed: true, reason: `host ${host} is in scope` };
    }
  }
  return { allowed: false, reason: `host ${host} is out of scope (deny-by-default)` };
}
