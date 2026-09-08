import { parse } from "parse5";
import { createHash } from "node:crypto";
import { fetchPublic, publicUrl, type PublicFetch } from "./public-fetch.js";

export interface SearchConfiguration { provider: "disabled" | "brave" | "searxng"; endpoint: string }
export interface SearchResult { title: string; url: string; description: string }
export interface WebDocument { url: string; title: string; text: string; links: string[]; digest: string; truncated: boolean; retrievedAt: string; trust: "untrusted_external_content" }
interface HtmlNode { nodeName: string; tagName?: string; value?: string; childNodes?: HtmlNode[]; attrs?: { name: string; value: string }[] }

export function extractDocument(bytes: Buffer, contentType: string, url: string): WebDocument {
  if (bytes.length > 1024 * 1024) throw new Error("Document exceeds 1 MiB");
  const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let title = "", text = ""; const links = new Set<string>(); let truncated = false;
  if (/text\/html|application\/xhtml\+xml/i.test(contentType)) {
    let nodes = 0;
    const visit = (node: HtmlNode, depth: number) => {
      if (++nodes > 30_000 || depth > 128) { truncated = true; return; }
      if (["script", "style", "noscript", "template", "svg", "form", "iframe"].includes(node.tagName ?? "")) return;
      if (node.tagName === "title") title = node.childNodes?.map(child => child.value ?? "").join("").slice(0, 256) ?? "";
      if (node.tagName === "a" && links.size < 100) {
        const href = node.attrs?.find(attr => attr.name === "href")?.value;
        try { if (href) { const link = new URL(href, url); link.hash = ""; links.add(publicUrl(link.href).href); } } catch {}
      }
      if (node.nodeName === "#text") {
        if (text.length >= 65_536) { truncated = true; return; }
        text += (node.value ?? "").slice(0, 65_536 - text.length);
      }
      if (["p", "div", "br", "pre", "li", "h1", "h2", "h3", "tr"].includes(node.tagName ?? "")) text += "\n";
      for (const child of node.childNodes ?? []) visit(child, depth + 1);
    };
    visit(parse(body) as unknown as HtmlNode, 0);
    text = text.replace(/[ \t]+/g, " ").replace(/\n\s*\n/g, "\n\n").trim();
  } else if (/^(text\/(plain|markdown)|application\/json)/i.test(contentType)) {
    text = body.slice(0, 65_536); truncated = body.length > text.length;
  } else throw new Error("Only UTF-8 HTML, text, Markdown and JSON documents are supported; scripts are not executed");
  return { url, title, text: text.slice(0, 65_536), links: [...links], digest: createHash("sha256").update(bytes).digest("hex"),
    truncated, retrievedAt: new Date().toISOString(), trust: "untrusted_external_content" };
}

export class PublicResearch {
  constructor(private readonly fetch: PublicFetch = fetchPublic) {}
  async read(url: string, signal?: AbortSignal, authorizeUrl?: (url: string) => void): Promise<WebDocument> {
    publicUrl(url);
    authorizeUrl?.(url);
    const response = await this.fetch(url, { signal, authorizeUrl });
    if (response.status !== 200) throw new Error(`Public document returned HTTP ${response.status}`);
    return extractDocument(response.bytes, response.contentType, response.url);
  }
  async search(query: string, config: SearchConfiguration, credential?: string, signal?: AbortSignal): Promise<SearchResult[]> {
    if (!query.trim() || query.length > 500 || query.split(/\s+/).length > 70) throw new Error("Search query must contain 1–500 characters and at most 70 words");
    if (config.provider === "disabled") throw new Error("Web search is not configured; configure a search service in desktop settings");
    const endpoint = publicUrl(config.endpoint); endpoint.search = "";
    endpoint.searchParams.set("q", query);
    let headers: Record<string, string> = {};
    if (config.provider === "brave") {
      if (!credential) throw new Error("Brave Search credential is not configured");
      endpoint.searchParams.set("count", "10"); headers = { "X-Subscription-Token": credential };
    } else endpoint.searchParams.set("format", "json");
    const response = await this.fetch(endpoint.href, { headers, signal });
    if (response.status !== 200) throw new Error(`Search service returned HTTP ${response.status}`);
    const body = JSON.parse(response.bytes.toString("utf8"));
    const items: unknown = config.provider === "brave" ? body.web?.results : body.results;
    if (!Array.isArray(items)) throw new Error("Search service returned an unsupported response");
    return items.slice(0, 10).flatMap(item => {
      try { return [{ title: String(item.title ?? "").slice(0, 256), url: publicUrl(item.url).href,
        description: String(item.description ?? item.content ?? "").slice(0, 2000) }]; } catch { return []; }
    });
  }
}
