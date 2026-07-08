import { mkdir, writeFile, chmod } from "node:fs/promises";
import { resolve, sep, normalize } from "node:path";
import { proxyDispatcher } from "@traceforge/shared";
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
    description: "从网络下载一个现成工具或脚本到本 Case 的 workspace/downloads 目录。仅当本地环境无法解决问题时使用。保存后可通过 mcp__poc__exec_command 执行（仍需用户批准）。输入：url（http/https 直链）、filename（保存文件名，如 nuclei.zip）、executable（是否在非 Windows 平台设为可执行）。",
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
        normalized.startsWith(".") ||
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
