import { mkdir, writeFile, chmod } from "node:fs/promises";
import { resolve, sep, normalize } from "node:path";
import { proxyDispatcher } from "@traceforge/shared/proxy";
import type { ToolDescriptor } from "./tool.js";

export interface DownloadFetcherResponse {
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface DownloadFetcher {
  (url: string): Promise<DownloadFetcherResponse>;
}

export interface DownloadToolDeps {
  caseId: string;
  workspaceRoot: string;
  fetcher?: DownloadFetcher;
}

async function defaultFetch(url: string): Promise<DownloadFetcherResponse> {
  const dispatcher = proxyDispatcher();
  // undici fetch accepts a `dispatcher` option, but the ambient RequestInit type
  // from lib.dom/lib.dom.iterable does not include it, so we cast to avoid TS2769.
  const res = dispatcher ? await fetch(url, { dispatcher } as never) : await fetch(url);
  return {
    ok: res.ok,
    status: res.status,
    arrayBuffer: () => res.arrayBuffer(),
  };
}

export function makeDownloadTool(deps: DownloadToolDeps): ToolDescriptor {
  const downloadDir = resolve(deps.workspaceRoot, "data/cases", deps.caseId, "downloads");
  return {
    name: "download_tool",
    description: "Download an authorized target artifact, binary response, tool, or script into this Case's downloads directory. Use this when traffic metadata shows a binary body that is not retained in get_traffic; pass the original in-scope URL and a safe filename. Downloading does not execute the file. executable only marks it executable on non-Windows platforms.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        filename: { type: "string" },
        executable: { type: "boolean" },
      },
      required: ["url", "filename"],
    },
    risk: "command",
    source: "builtin",
    execute: async (input) => {
      const { url, filename, executable } = input as { url?: string; filename?: string; executable?: boolean };
      if (!url) return { ok: false, content: "missing url" };
      let targetUrl: URL;
      try {
        targetUrl = new URL(url);
      } catch {
        return { ok: false, content: "invalid url" };
      }
      if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
        return { ok: false, content: "only http/https urls are allowed" };
      }
      if (!filename) return { ok: false, content: "missing filename" };
      const normalized = normalize(filename);
      if (
        !normalized ||
        normalized === "." ||
        normalized === ".." ||
        normalized.includes("..") ||
        /[\\/]/.test(normalized)
      ) {
        return { ok: false, content: "invalid filename" };
      }
      const targetPath = resolve(downloadDir, normalized);
      if (!targetPath.startsWith(downloadDir + sep)) {
        return { ok: false, content: "filename escapes downloads directory" };
      }

      try {
        await mkdir(downloadDir, { recursive: true });
        const fetchImpl = deps.fetcher ?? defaultFetch;
        const res = await fetchImpl(url);
        if (!res.ok) return { ok: false, content: `download failed: HTTP ${res.status}` };
        const buf = Buffer.from(await res.arrayBuffer());
        await writeFile(targetPath, buf);
        if (executable && process.platform !== "win32") {
          await chmod(targetPath, 0o755);
        }
        return { ok: true, content: `downloaded ${buf.length} bytes to downloads/${normalized}` };
      } catch (e) {
        return { ok: false, content: `download error: ${(e as Error).message}` };
      }
    },
  };
}
