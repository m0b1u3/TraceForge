import { createHash } from "node:crypto";
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
  onDownloaded?: (artifact: {
    sourceUrl: string;
    filename: string;
    relativePath: string;
    byteSize: number;
    sha256: string;
    detectedFormat: string;
  }) => Promise<{ id: string } | void> | { id: string } | void;
}

function detectFormat(buffer: Buffer, filename: string): string {
  if (buffer.subarray(0, 4).toString("ascii") === "JAVA") return "java-hprof";
  if (buffer.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return "elf";
  if (buffer.subarray(0, 2).toString("ascii") === "MZ") return "pe";
  if (buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return "zip";
  if (buffer.subarray(0, 4).toString("ascii") === "%PDF") return "pdf";
  if (/\.json$/i.test(filename)) return "json";
  if (/\.html?$/i.test(filename)) return "html";
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  const controls = [...sample].filter((byte) => byte < 9 || (byte > 13 && byte < 32)).length;
  return sample.length > 0 && controls / sample.length < 0.02 ? "text" : "binary";
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
    security: {
      capabilities: ["network.read", "filesystem.write"], impactScope: "authorized_target", mutates: true, destructive: false, openWorld: false,
    },
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
        const sha256 = createHash("sha256").update(buf).digest("hex");
        const detectedFormat = detectFormat(buf, normalized);
        const recorded = await deps.onDownloaded?.({
          sourceUrl: url,
          filename: normalized,
          relativePath: `downloads/${normalized}`,
          byteSize: buf.length,
          sha256,
          detectedFormat,
        });
        const artifactId = recorded?.id ? `; artifactId=${recorded.id}` : "";
        return {
          ok: true,
          content: `downloaded ${buf.length} bytes to downloads/${normalized}; sha256=${sha256}; format=${detectedFormat}${artifactId}. Download proves acquisition only; use an artifact analyzer before drawing content conclusions.`,
          meta: { artifactId: recorded?.id, sha256, detectedFormat, byteSize: buf.length },
        };
      } catch (e) {
        return { ok: false, content: `download error: ${(e as Error).message}` };
      }
    },
  };
}
