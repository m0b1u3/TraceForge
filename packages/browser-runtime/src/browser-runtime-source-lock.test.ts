import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BROWSER_RUNTIME_SOURCE_LOCK_PROFILE,
  browserRuntimeSourceLockSha256,
  parseBrowserRuntimeSourceLock,
  selectBrowserRuntimeSourceTarget,
  verifyBrowserRuntimeSourceArchive,
  type BrowserRuntimeSourceLock,
} from "./index.js";

const temporaryDirectories: string[] = [];
const bytes = Buffer.from("reviewed-browser-archive");
const target = {
  platform: "linux" as const,
  architecture: "x64" as const,
  archiveFormat: "zip" as const,
  url: "https://downloads.example.invalid/browser/140/browser-linux-x64.zip",
  archiveBytes: bytes.length,
  archiveSha256: createHash("sha256").update(bytes).digest("hex"),
  rootDirectory: "chromium",
  executable: "bin/chrome",
};
const lock: BrowserRuntimeSourceLock = {
  format: 1,
  profile: BROWSER_RUNTIME_SOURCE_LOCK_PROFILE,
  sourceId: "reviewed-browser-distribution",
  version: "140.0.0.0",
  revision: "1400000",
  createdAt: "2026-09-04T00:00:00.000Z",
  buildAttestationSha256: "b".repeat(64),
  securityReviewRef: "security-review/browser/140",
  licenseReviewRef: "license-review/browser/140",
  targets: [target],
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Browser Runtime source lock", () => {
  it("strictly validates, fingerprints and selects one reviewed host target", () => {
    expect(parseBrowserRuntimeSourceLock(lock)).toEqual(lock);
    const selected = selectBrowserRuntimeSourceTarget(lock, "linux", "x64");
    expect(selected.target).toEqual(target);
    expect(selected.lockSha256).toBe(browserRuntimeSourceLockSha256(lock));
    expect(() => parseBrowserRuntimeSourceLock({ ...lock, extra: true })).toThrow("missing or unknown fields");
    expect(() => parseBrowserRuntimeSourceLock({ ...lock, securityReviewRef: "" })).toThrow("security review");
    expect(() => parseBrowserRuntimeSourceLock({ ...lock, targets: [target, target] })).toThrow("duplicated");
    expect(() => selectBrowserRuntimeSourceTarget(lock, "darwin", "arm64")).toThrow("no target");
  });

  it("accepts only a stable regular archive with the locked size and digest", async () => {
    const root = await mkdtemp(join(tmpdir(), "traceforge-browser-source-lock-"));
    temporaryDirectories.push(root);
    const archivePath = join(root, "browser.zip");
    await writeFile(archivePath, bytes);
    await expect(verifyBrowserRuntimeSourceArchive({ target, archivePath })).resolves.toEqual({
      bytes: bytes.length,
      sha256: target.archiveSha256,
    });
    await writeFile(archivePath, Buffer.from("tampered-browser-archive"));
    await expect(verifyBrowserRuntimeSourceArchive({ target, archivePath })).rejects.toThrow(/size|digest/);
  });
});
