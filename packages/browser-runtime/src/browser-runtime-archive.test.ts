import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdtemp, readFile, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { afterEach, describe, expect, it } from "vitest";
import { ZipFile } from "yazl";
import {
  extractBrowserRuntimeSourceArchive,
  type BrowserRuntimeSourceTarget,
} from "./index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Browser Runtime source archive", () => {
  it("streams one locked ZIP into a new bounded tree and preserves contained links", async () => {
    const root = await temporaryRoot();
    const archivePath = join(root, "browser.zip");
    await createZip(archivePath, [
      ["chromium/bin/chrome", Buffer.from("browser"), 0o100755],
      ["chromium/resources.dat", Buffer.from("resource"), 0o100644],
      ["chromium/bin/resources-current", Buffer.from("../resources.dat"), 0o120777],
    ]);
    const target = await targetFor(archivePath);
    const extracted = await extractBrowserRuntimeSourceArchive({
      target,
      archivePath,
      destination: join(root, "installed"),
    });
    expect(await readFile(extracted.browserPath, "utf8")).toBe("browser");
    expect((await lstat(extracted.browserPath)).mode & 0o500).toBe(0o500);
    expect(await readlink(join(extracted.browserRootPath, "bin/resources-current"))).toBe("../resources.dat");
    expect(extracted.entries).toBe(3);
    expect(extracted.expandedBytes).toBe(Buffer.byteLength("browserresource../resources.dat"));
  });

  it("removes partial output after rejecting escaped links, expansion overflow or a bad archive digest", async () => {
    const root = await temporaryRoot();
    const archivePath = join(root, "unsafe.zip");
    await createZip(archivePath, [
      ["chromium/bin/chrome", Buffer.from("browser"), 0o100755],
      ["chromium/link", Buffer.from("../outside"), 0o120777],
    ]);
    const target = await targetFor(archivePath);
    const escapedDestination = join(root, "escaped");
    await expect(extractBrowserRuntimeSourceArchive({
      target,
      archivePath,
      destination: escapedDestination,
    })).rejects.toThrow("escapes");
    await expect(lstat(escapedDestination)).rejects.toMatchObject({ code: "ENOENT" });

    const limitedDestination = join(root, "limited");
    await expect(extractBrowserRuntimeSourceArchive({
      target,
      archivePath,
      destination: limitedDestination,
      maximumExpandedBytes: 15,
      maximumFileBytes: 15,
    })).rejects.toThrow("expanded byte limit");
    await expect(lstat(limitedDestination)).rejects.toMatchObject({ code: "ENOENT" });

    const badDestination = join(root, "bad-digest");
    await expect(extractBrowserRuntimeSourceArchive({
      target: { ...target, archiveSha256: "f".repeat(64) },
      archivePath,
      destination: badDestination,
    })).rejects.toThrow("digest");
    await expect(lstat(badDestination)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "traceforge-browser-archive-"));
  temporaryDirectories.push(root);
  return root;
}

async function targetFor(archivePath: string): Promise<BrowserRuntimeSourceTarget> {
  const bytes = await readFile(archivePath);
  return {
    platform: "linux",
    architecture: "x64",
    archiveFormat: "zip",
    url: "https://downloads.example.invalid/browser/140/browser-linux-x64.zip",
    archiveBytes: bytes.length,
    archiveSha256: createHash("sha256").update(bytes).digest("hex"),
    rootDirectory: "chromium",
    executable: "bin/chrome",
  };
}

async function createZip(
  path: string,
  entries: Array<[name: string, bytes: Buffer, mode: number]>,
): Promise<void> {
  const zip = new ZipFile();
  for (const [name, bytes, mode] of entries) zip.addBuffer(bytes, name, { mode, compress: false });
  const writing = pipeline(zip.outputStream as Readable, createWriteStream(path, { flags: "wx" }));
  zip.end();
  await writing;
}
