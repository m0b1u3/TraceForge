import { canonicalHttpUrl, unique } from "./validation.mjs";

// Bounded passive hints, not a browser DOM or an HTML conformance parser.
// Never return input values, inline scripts or automatically submit a form.
export function inspectDocument(body: string, base: string, origins: Set<string>, maximum: number) {
  const clean = body.replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  const sameOrigin: string[] = [], external: string[] = [], forms: Array<{
    action: string | null; method: string; sameOrigin: boolean; fields: Array<{ name: string; type: string }>;
    fieldsTruncated: boolean; automaticSubmission: false;
  }> = [];
  let form: typeof forms[number] | undefined;
  let truncated = false, examined = 0;
  for (const match of clean.matchAll(/<\/?[a-z][^>]*>/gi)) {
    if (++examined > 4096) { truncated = true; break; }
    const tag = /^<(\/?)([a-z0-9-]+)/i.exec(match[0])!;
    const name = tag[2]!.toLowerCase();
    if (tag[1]) { if (name === "form") form = undefined; continue; }
    const attrs = attributes(match[0]);
    if (name === "form") {
      if (forms.length === 8) { truncated = true; form = undefined; continue; }
      const action = httpUrl(attrs.action ?? base, base);
      form = { action, method: (attrs.method ?? "GET").toUpperCase().slice(0, 16), sameOrigin: action !== null && origins.has(new URL(action).origin),
        fields: [], fieldsTruncated: false, automaticSubmission: false };
      forms.push(form);
      continue;
    }
    if (form && ["input", "select", "button"].includes(name) && attrs.name) {
      if (form.fields.length >= 16) form.fieldsTruncated = true;
      else form.fields.push({ name: attrs.name.slice(0, 128), type: (attrs.type ?? name).slice(0, 32) });
    }
    // A form action is a possible operation, never an automatic GET seed.
    const raw = ["a", "area", "link"].includes(name) ? attrs.href : ["img", "iframe", "source"].includes(name) ? attrs.src : undefined;
    if (raw === undefined) continue;
    const url = httpUrl(raw, base); if (!url) continue;
    const destination = origins.has(new URL(url).origin) ? sameOrigin : external;
    if (destination.includes(url)) continue;
    if (destination.length >= maximum) { truncated = true; continue; }
    destination.push(url);
  }
  // Metadata is persisted through the Host's 16 KiB artifact contract.
  while (Buffer.byteLength(JSON.stringify(forms)) > 4096) { forms.pop(); truncated = true; }
  return { sameOrigin: unique(sameOrigin), external: unique(external), forms, hintsTruncated: truncated,
    parserLimitations: ["Static bounded HTML hints only; scripts, browser state, form values and dynamic routes are not interpreted."] };
}

function attributes(tag: string): Record<string, string> {
  const values: Record<string, string> = Object.create(null);
  for (const match of tag.matchAll(/\s([a-z_:][a-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const key = match[1]!.toLowerCase();
    if (!(key in values)) values[key] = decode(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return values;
}
function decode(value: string): string {
  return value.replace(/&(?:amp|quot|apos|lt|gt|#\d{1,7}|#x[0-9a-f]{1,6});/gi, token => {
    const named: Record<string, string> = { "&amp;": "&", "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">" };
    if (named[token.toLowerCase()]) return named[token.toLowerCase()]!;
    const hex = token[2]?.toLowerCase() === "x", point = Number.parseInt(token.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : "\uFFFD";
  });
}
function httpUrl(value: string, base: string): string | null {
  try { return canonicalHttpUrl(new URL(value, base).href, "Document URL"); } catch { return null; }
}
