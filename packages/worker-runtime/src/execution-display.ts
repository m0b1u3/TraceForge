/** A bounded, untrusted desktop projection. Never an executable command or an
 * evidence source. Structured secret fields are omitted before serialization. */
export function executionDisplay(value: unknown, maximum = 8000): { text: string; truncated: boolean } {
  const secret = /authorization|cookie|password|passwd|secret|token|credential|api.?key|private.?key|environment|^env$|^headers$|^body$/i;
  const walk = (input: unknown, depth: number): unknown => {
    if (depth > 6) return "[omitted]";
    if (Array.isArray(input)) return input.slice(0, 64).map((v, i) => i > 0 && typeof input[i - 1] === "string" && /^--?(?:password|token|secret|api-key)$/i.test(input[i - 1]) ? "[redacted]" : walk(v, depth + 1));
    if (input && typeof input === "object") return Object.fromEntries(Object.entries(input).slice(0, 64).map(([key, v]) => [key, secret.test(key) ? "[redacted]" : walk(v, depth + 1)]));
    return typeof input === "string" ? input.slice(0, 32768) : input;
  };
  let parsed = value;
  if (typeof value === "string" && /^[\s]*[\[{]/.test(value)) { try { parsed = JSON.parse(value); } catch { /* Plain output stays plain. */ } }
  const raw = typeof parsed === "string" ? parsed : JSON.stringify(walk(parsed, 0), null, 2) ?? "";
  const safe = raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[redacted private key]")
    .replace(/\b(Bearer|Basic)\s+[^\s"']*/gi, "$1 [redacted]")
    .replace(/((?:password|passwd|api[_-]?key|access[_-]?token|secret|token)\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]*)/gi, "$1[redacted]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "[redacted]");
  return { text: safe.slice(0, maximum), truncated: safe.length > maximum };
}
