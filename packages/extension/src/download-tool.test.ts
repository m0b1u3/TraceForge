import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { makeDownloadTool } from "./download-tool.js";

async function withServer<T>(status: number, body: string, run: (url: string) => Promise<T>): Promise<T> {
  const server = http.createServer((_req, res) => {
    res.writeHead(status, { "content-type": "application/octet-stream" });
    res.end(body);
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server address unavailable");
    return await run(`http://127.0.0.1:${address.port}/tool`);
  } finally {
    await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  }
}

describe("makeDownloadTool", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "tf-download-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("downloads a file from a real HTTP server into the case directory", async () => {
    await withServer(200, "hello tool", async (url) => {
      const tool = makeDownloadTool({ caseId: "c", workspaceRoot: root });
      const res = await tool.execute({ url, filename: "tool.sh", executable: true });
      expect(res.ok).toBe(true);
      expect(res.content).toContain("downloads/tool.sh");
      const saved = await readFile(resolve(root, "data/cases/c/downloads/tool.sh"));
      expect(saved.toString()).toBe("hello tool");
    });
  });

  it("rejects path traversal filenames before making a request", async () => {
    const tool = makeDownloadTool({ caseId: "c", workspaceRoot: root });
    const res = await tool.execute({ url: "http://127.0.0.1:1/x", filename: "../escape.sh" });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/invalid filename|escapes/);
  });

  it("reports real HTTP errors", async () => {
    await withServer(404, "missing", async (url) => {
      const tool = makeDownloadTool({ caseId: "c", workspaceRoot: root });
      const res = await tool.execute({ url, filename: "x.sh" });
      expect(res.ok).toBe(false);
      expect(res.content).toContain("404");
    });
  });

  it("sets executable permission when the host platform supports it", async () => {
    await withServer(200, "#!/bin/sh\necho ok\n", async (url) => {
      const tool = makeDownloadTool({ caseId: "c", workspaceRoot: root });
      const res = await tool.execute({ url, filename: "x.sh", executable: true });
      expect(res.ok).toBe(true);
      const info = await stat(resolve(root, "data/cases/c/downloads/x.sh"));
      if (process.platform !== "win32") expect(info.mode & 0o111).toBe(0o111);
      expect(info.size).toBeGreaterThan(0);
    });
  });

  it("downloads a hidden filename", async () => {
    await withServer(200, "use nix", async (url) => {
      const tool = makeDownloadTool({ caseId: "c", workspaceRoot: root });
      const res = await tool.execute({ url, filename: ".envrc" });
      expect(res.ok).toBe(true);
      expect(res.content).toContain("downloads/.envrc");
      const saved = await readFile(resolve(root, "data/cases/c/downloads/.envrc"));
      expect(saved.toString()).toBe("use nix");
    });
  });
});
