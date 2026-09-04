import { createHash, generateKeyPairSync } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { afterEach, describe, expect, it } from "vitest";
import { ZipFile } from "yazl";
import {
  BROWSER_RUNTIME_SOURCE_LOCK_PROFILE,
  BROWSER_RUNTIME_SOURCE_AUTHORITY_PROFILE,
  assembleBrowserRuntimeRelease,
  browserRuntimeBuildAttestationSha256,
  createBrowserRuntimeSourceReview,
  extractBrowserRuntimeSourceArchive,
  measureBrowserRuntimeTree,
  verifyInstalledBrowserRuntimeRelease,
  type BrowserRuntimeBuildAttestation,
  type BrowserRuntimeSourceLock,
  type BrowserRuntimeSourceReview,
  type BrowserRuntimeSourceAuthority,
} from "./index.js";
import { createTestBrowserRuntimeBuildAttestation } from "./test-fixtures/browser-runtime-material.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Browser Runtime release assembly", () => {
  it("atomically assembles Controller and a verified source archive into one provenance-bound release", async () => {
    const source = await fixture();
    const destination = join(source.root, "release");
    const assembled = await assembleBrowserRuntimeRelease({
      destination,
      controllerSource: source.controller,
      controllerVersion: "1.0.0",
      sourceLock: source.lock,
      sourceReview: source.review,
      sourceAuthority: source.authority,
      buildAttestation: source.attestation,
      sourceArchivePath: source.archive,
      platform: "linux",
      architecture: "x64",
    });
    expect(assembled.root).toBe(destination);
    expect(JSON.parse(await readFile(assembled.manifestPath, "utf8"))).toEqual(assembled.manifest);
    expect(JSON.parse(await readFile(assembled.sourceLockPath, "utf8"))).toEqual(source.lock);
    expect(JSON.parse(await readFile(assembled.sourceReviewPath, "utf8"))).toEqual(source.review);
    expect(JSON.parse(await readFile(assembled.buildAttestationPath, "utf8"))).toEqual(source.attestation);
    expect(assembled.manifest.source).toMatchObject({
      sourceId: source.lock.sourceId,
      revision: source.lock.revision,
      archiveSha256: source.lock.targets[0]!.archiveSha256,
    });
    await expect(verifyInstalledBrowserRuntimeRelease({
      manifest: assembled.manifest,
      sourceLock: source.lock,
      sourceReview: source.review,
      sourceAuthority: source.authority,
      buildAttestation: source.attestation,
      platform: "linux",
      architecture: "x64",
      controllerPath: assembled.controllerPath,
      browserRootPath: assembled.browserRootPath,
      browserPath: assembled.browserPath,
    })).resolves.toMatchObject({
      identity: {
        controllerSha256: assembled.manifest.controller.sha256,
        browserSha256: assembled.manifest.browser.tree.sha256,
      },
      browserExecutableSha256: assembled.manifest.browser.executableSha256,
    });
  });

  it("never overlays an existing destination or assembles an archive outside the reviewed lock", async () => {
    const source = await fixture();
    const destination = join(source.root, "existing");
    await mkdir(destination);
    await expect(assembleBrowserRuntimeRelease({
      destination,
      controllerSource: source.controller,
      controllerVersion: "1.0.0",
      sourceLock: source.lock,
      sourceReview: source.review,
      sourceAuthority: source.authority,
      buildAttestation: source.attestation,
      sourceArchivePath: source.archive,
      platform: "linux",
      architecture: "x64",
    })).rejects.toThrow("already exists");
    await expect(assembleBrowserRuntimeRelease({
      destination: join(source.root, "untrusted"),
      controllerSource: source.controller,
      controllerVersion: "1.0.0",
      sourceLock: {
        ...source.lock,
        targets: [{ ...source.lock.targets[0]!, archiveSha256: "f".repeat(64) }],
      },
      sourceReview: source.review,
      sourceAuthority: source.authority,
      buildAttestation: source.attestation,
      sourceArchivePath: source.archive,
      platform: "linux",
      architecture: "x64",
    })).rejects.toThrow("review identity");
  });
});

async function fixture(): Promise<{
  root: string;
  controller: string;
  archive: string;
  lock: BrowserRuntimeSourceLock;
  review: BrowserRuntimeSourceReview;
  authority: BrowserRuntimeSourceAuthority;
  attestation: BrowserRuntimeBuildAttestation;
}> {
  const root = await mkdtemp(join(tmpdir(), "traceforge-browser-release-builder-"));
  temporaryDirectories.push(root);
  const controller = join(root, "traceforge-browser-controller.mjs");
  const archive = join(root, "chromium.zip");
  await writeFile(controller, "#!/usr/bin/env node\n", { encoding: "utf8", mode: 0o755 });
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from("browser"), "chromium/bin/chrome", { mode: 0o100755, compress: false });
  zip.addBuffer(Buffer.from("resource"), "chromium/resources.dat", { mode: 0o100644, compress: false });
  zip.addBuffer(Buffer.from("../resources.dat"), "chromium/bin/resources-current", { mode: 0o120777, compress: false });
  const writing = pipeline(zip.outputStream as Readable, createWriteStream(archive, { flags: "wx" }));
  zip.end();
  await writing;
  const bytes = await readFile(archive);
  const target = {
        platform: "linux" as const,
        architecture: "x64" as const,
        archiveFormat: "zip" as const,
        url: "https://downloads.example.invalid/browser.zip",
        archiveBytes: bytes.length,
        archiveSha256: createHash("sha256").update(bytes).digest("hex"),
        rootDirectory: "chromium",
        executable: "bin/chrome",
  };
  const measurementRoot = join(root, "measurement");
  const extracted = await extractBrowserRuntimeSourceArchive({ target, archivePath: archive, destination: measurementRoot });
  const browserTreeSha256 = (await measureBrowserRuntimeTree(extracted.browserRootPath)).sha256;
  await rm(measurementRoot, { recursive: true, force: true });
  const attestation = createTestBrowserRuntimeBuildAttestation({
    version: "HeadlessChrome/140.0.0.0",
    revision: "1".repeat(40),
    target,
    browserTreeSha256,
  });
  const lock: BrowserRuntimeSourceLock = {
      format: 1,
      profile: BROWSER_RUNTIME_SOURCE_LOCK_PROFILE,
      sourceId: "reviewed-browser-distribution",
      version: "HeadlessChrome/140.0.0.0",
      revision: "1".repeat(40),
      createdAt: "2026-09-04T00:00:00.000Z",
      buildAttestationSha256: browserRuntimeBuildAttestationSha256(attestation),
      securityReviewRef: `sha256:${attestation.compliance.securityAssessmentSha256}`,
      licenseReviewRef: `sha256:${attestation.compliance.licenseReviewSha256}`,
      targets: [target],
  };
  const keys = generateKeyPairSync("ed25519");
  const authority: BrowserRuntimeSourceAuthority = {
    format: 1, profile: BROWSER_RUNTIME_SOURCE_AUTHORITY_PROFILE, keyId: "browser-release-reviewer",
    publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    sourceIds: [lock.sourceId], validFrom: "2026-09-01T00:00:00.000Z",
    validUntil: "2099-01-01T00:00:00.000Z", revokedAt: null,
  };
  const review = createBrowserRuntimeSourceReview({ sourceLock: lock, keyId: authority.keyId,
    privateKeyPem: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    issuedAt: "2026-09-04T00:01:00.000Z", expiresAt: "2098-01-01T00:00:00.000Z" });
  return {
    root,
    controller,
    archive,
    lock,
    review,
    authority,
    attestation,
  };
}
