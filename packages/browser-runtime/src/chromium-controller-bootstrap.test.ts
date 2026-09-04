import { EventEmitter } from "node:events";
import { generateKeyPairSync } from "node:crypto";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  browserRuntimeMaterialSha256,
  browserRuntimeBuildAttestationSha256,
  browserRuntimeSourceLockSha256,
  BROWSER_RUNTIME_SOURCE_LOCK_PROFILE,
  BROWSER_RUNTIME_SOURCE_AUTHORITY_PROFILE,
  createBrowserRuntimeReleaseManifest,
  createBrowserRuntimeSourceReview,
  verifyBrowserRuntimeSourceReview,
  startChromiumController,
  type BrowserControllerProcessIo,
  type ChromiumPipeProcess,
  type BrowserRuntimeSourceLock,
} from "./index.js";
import { createTestBrowserRuntimeBuildAttestation } from "./test-fixtures/browser-runtime-material.js";

const controllerBytes = Buffer.from("controller-bundle");
const browserBytes = Buffer.from("chromium-binary");
const sourceTarget = { platform: "linux" as const, architecture: "x64" as const,
  archiveFormat: "zip" as const, url: "https://downloads.example.invalid/browser.zip", archiveBytes: 1024,
  archiveSha256: "a".repeat(64), rootDirectory: "chromium", executable: "chrome" };
const buildAttestation = createTestBrowserRuntimeBuildAttestation({
  version: "HeadlessChrome/140.0.0.0", revision: "1".repeat(40), target: sourceTarget,
  browserTreeSha256: "c".repeat(64),
});
const sourceLock: BrowserRuntimeSourceLock = {
  format: 1, profile: BROWSER_RUNTIME_SOURCE_LOCK_PROFILE,
  sourceId: "reviewed-browser-distribution", version: "HeadlessChrome/140.0.0.0", revision: "1".repeat(40),
  createdAt: "2026-09-04T00:00:00.000Z",
  buildAttestationSha256: browserRuntimeBuildAttestationSha256(buildAttestation),
  securityReviewRef: `sha256:${buildAttestation.compliance.securityAssessmentSha256}`,
  licenseReviewRef: `sha256:${buildAttestation.compliance.licenseReviewSha256}`, targets: [sourceTarget],
};
const keys = generateKeyPairSync("ed25519");
const sourceAuthority = { format: 1 as const, profile: BROWSER_RUNTIME_SOURCE_AUTHORITY_PROFILE,
  keyId: "browser-release-reviewer", publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
  sourceIds: [sourceLock.sourceId], validFrom: "2026-09-01T00:00:00.000Z",
  validUntil: "2099-01-01T00:00:00.000Z", revokedAt: null };
const sourceReview = createBrowserRuntimeSourceReview({ sourceLock, keyId: sourceAuthority.keyId,
  privateKeyPem: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  issuedAt: "2026-09-04T00:01:00.000Z", expiresAt: "2098-01-01T00:00:00.000Z" });
const reviewSha256 = verifyBrowserRuntimeSourceReview({ sourceLock, sourceReview, authority: sourceAuthority,
  now: "2026-09-04T00:02:00.000Z" }).reviewSha256;
const manifest = createBrowserRuntimeReleaseManifest({
  platform: "linux",
  architecture: "x64",
  source: { lockSha256: browserRuntimeSourceLockSha256(sourceLock), sourceId: sourceLock.sourceId,
    version: sourceLock.version, revision: sourceLock.revision, archiveBytes: sourceLock.targets[0]!.archiveBytes,
    archiveSha256: sourceLock.targets[0]!.archiveSha256, securityReviewRef: sourceLock.securityReviewRef,
    licenseReviewRef: sourceLock.licenseReviewRef, reviewKeyId: sourceReview.keyId, reviewSha256,
    reviewExpiresAt: sourceReview.expiresAt, buildAttestationSha256: sourceLock.buildAttestationSha256 },
  controller: { executable: "traceforge-browser-controller", version: "1.0.0", bytes: controllerBytes },
  browser: { root: "chromium", executable: "chrome", version: "HeadlessChrome/140.0.0.0",
    executableSha256: browserRuntimeMaterialSha256(browserBytes),
    tree: { sha256: "c".repeat(64), entries: 1, bytes: browserBytes.length } },
});

class FakeChromiumProcess extends EventEmitter implements ChromiumPipeProcess {
  readonly controlInput = new PassThrough();
  readonly controlOutput = new PassThrough();
  readonly stderr = new PassThrough();
  readonly commands: string[] = [];
  private buffer = Buffer.alloc(0);

  constructor() {
    super();
    this.controlInput.on("data", (chunk: Buffer) => this.receive(chunk));
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.emit("exit", null, signal ?? "SIGTERM");
    return true;
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const delimiter = this.buffer.indexOf(0);
      if (delimiter < 0) return;
      const command = JSON.parse(this.buffer.subarray(0, delimiter).toString("utf8"));
      this.buffer = this.buffer.subarray(delimiter + 1);
      this.commands.push(command.method);
      const result = command.method === "Browser.getVersion" ? { product: manifest.browser.version } : {};
      queueMicrotask(() => this.controlOutput.write(Buffer.from(`${JSON.stringify({ id: command.id, result })}\0`)));
    }
  }
}

function ioHarness(): { io: BrowserControllerProcessIo; writes: Buffer[]; exits: number[] } {
  const writes: Buffer[] = [], exits: number[] = [];
  return {
    writes,
    exits,
    io: {
      onData: () => () => undefined,
      onFailure: () => () => undefined,
      write: (data) => { writes.push(data); },
      close: (exitCode) => { exits.push(exitCode); },
    },
  };
}

describe("Chromium Controller bootstrap", () => {
  it("assembles verified release identity, CDP policy and the process handshake", async () => {
    const chromium = new FakeChromiumProcess();
    const launcher = vi.fn(() => {
      queueMicrotask(() => chromium.emit("spawn"));
      return chromium;
    });
    const io = ioHarness();
    const digestFile = async (path: string) => path.endsWith("/chrome")
      ? manifest.browser.executableSha256 : manifest.controller.sha256;
    const started = await startChromiumController({
      io: io.io,
      releaseManifest: manifest,
      sourceLock,
      sourceReview,
      sourceAuthority,
      buildAttestation,
      platform: "linux",
      architecture: "x64",
      controllerPath: "/opt/traceforge/browser/traceforge-browser-controller",
      chromium: {
        browserExecutable: "/opt/traceforge/browser/chromium/chrome",
        browserRootPath: "/opt/traceforge/browser/chromium",
        workingDirectory: "/var/lib/traceforge/browser",
        userDataDirectory: "/var/lib/traceforge/browser/profile/run-1",
        launcher,
      },
      digestFile,
      measureTree: async () => manifest.browser.tree,
    });
    expect(started.identity).toEqual({
      protocol: "traceforge.browser-controller.v1",
      controllerVersion: "1.0.0",
      controllerSha256: manifest.controller.sha256,
      browserVersion: "HeadlessChrome/140.0.0.0",
      browserSha256: manifest.browser.tree.sha256,
    });
    expect(launcher).toHaveBeenCalledTimes(1);
    expect(chromium.commands).toEqual([
      "Browser.getVersion",
      "Target.setDiscoverTargets",
      "Target.setAutoAttach",
      "Browser.setDownloadBehavior",
    ]);
    expect(io.writes).toHaveLength(1);
    const size = io.writes[0]!.readUInt32BE(0);
    const ready = JSON.parse(io.writes[0]!.subarray(4, 4 + size).toString("utf8"));
    expect(ready).toMatchObject({ type: "ready", proof: { identity: started.identity } });
    expect(io.exits).toEqual([]);
  });

  it("does not create a CDP channel when either installed release file is untrusted", async () => {
    const launcher = vi.fn(() => new FakeChromiumProcess());
    await expect(startChromiumController({
      io: ioHarness().io,
      releaseManifest: manifest,
      sourceLock,
      sourceReview,
      sourceAuthority,
      buildAttestation,
      platform: "linux",
      architecture: "x64",
      controllerPath: "/opt/traceforge/browser/traceforge-browser-controller",
      chromium: {
        browserExecutable: "/opt/traceforge/browser/chromium/chrome",
        browserRootPath: "/opt/traceforge/browser/chromium",
        workingDirectory: "/var/lib/traceforge/browser",
        userDataDirectory: "/var/lib/traceforge/browser/profile/run-1",
        launcher,
      },
      digestFile: async () => "f".repeat(64),
      measureTree: async () => manifest.browser.tree,
    })).rejects.toThrow("material digest");
    expect(launcher).not.toHaveBeenCalled();
  });
});
