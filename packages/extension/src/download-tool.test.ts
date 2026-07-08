import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    chmod: vi.fn().mockResolvedValue(undefined),
  };
});

import { makeDownloadTool, type DownloadFetcher } from "./download-tool.js";

describe("makeDownloadTool", () => {
  let root: string;
  let originalFetch: typeof fetch;
  let originalPlatformDescriptor: PropertyDescriptor;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "tf-download-"));
    originalFetch = globalThis.fetch;
    originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    Object.defineProperty(process, "platform", originalPlatformDescriptor);
    vi.mocked(chmod).mockClear();
    await rm(root, { recursive: true, force: true });
  });

  it("downloads a file into the case downloads directory", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new TextEncoder().encode("hello tool").buffer,
    })) as unknown as typeof fetch;

    const tool = makeDownloadTool({ caseId: "c", workspaceRoot: root });
    const res = await tool.execute({ url: "https://example.com/tool.sh", filename: "tool.sh", executable: true });
    expect(res.ok).toBe(true);
    expect(res.content).toContain("downloads/tool.sh");
    const saved = await readFile(resolve(root, "data/cases/c/downloads/tool.sh"));
    expect(saved.toString()).toBe("hello tool");
  });

  it("rejects path traversal filenames", async () => {
    const tool = makeDownloadTool({ caseId: "c", workspaceRoot: root });
    const res = await tool.execute({ url: "https://example.com/x", filename: "../escape.sh" });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/invalid filename|escapes/);
  });

  it("reports HTTP errors", async () => {
    const fetcher: DownloadFetcher = async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) });
    const tool = makeDownloadTool({ caseId: "c", workspaceRoot: root, fetcher });
    const res = await tool.execute({ url: "https://example.com/x", filename: "x.sh" });
    expect(res.ok).toBe(false);
    expect(res.content).toContain("404");
  });

  it("sets executable permission when requested on non-Windows platforms", async () => {
    Object.defineProperty(process, "platform", { ...originalPlatformDescriptor, value: "linux" });
    const fetcher: DownloadFetcher = async () => ({ ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode("script").buffer });
    const tool = makeDownloadTool({ caseId: "c", workspaceRoot: root, fetcher });
    const res = await tool.execute({ url: "https://example.com/x", filename: "x.sh", executable: true });
    expect(res.ok).toBe(true);
    expect(chmod).toHaveBeenCalledTimes(1);
    expect(chmod).toHaveBeenCalledWith(resolve(root, "data/cases/c/downloads/x.sh"), 0o755);
  });
});
