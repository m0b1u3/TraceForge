import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalJson,
  type ToolProviderManifest,
} from "./tool-provider-control-plane.js";
import {
  createSignedToolProviderArchive,
  DEFAULT_TOOL_PROVIDER_ARCHIVE_POLICY,
  extractAndVerifyToolProviderArchive,
} from "./tool-provider-archive.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "traceforge-provider-archive-"));
  temporaryDirectories.push(root);
  const sourceRoot = join(root, "source");
  const stagingRoot = join(root, "staging");
  mkdirSync(join(sourceRoot, "data"), { recursive: true });
  const executable = join(sourceRoot, "provider.bin");
  writeFileSync(executable, "neutral provider executable");
  chmodSync(executable, 0o700);
  writeFileSync(join(sourceRoot, "data", "defaults.json"), "{}\n");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const manifest: ToolProviderManifest = {
    schemaVersion: 1,
    providerId: "neutral-provider",
    source: "managed.neutral-provider",
    version: "1.0.0",
    protocolVersion: 1,
    entrypoint: { executable: "provider.bin", arguments: [], workingDirectory: "." },
    artifact: { sha256: "0".repeat(64), packageSha256: "0".repeat(64) },
    capabilities: ["investigation.observe"],
    tools: [{
      name: "candidate.observe",
      source: "managed.neutral-provider",
      version: "1.0.0",
      priority: 100,
      description: "Observe a neutral candidate",
      inputSchema: {},
      providedCapabilities: ["investigation.observe"],
      dependencyCapabilities: [],
      permissionRequirements: {},
      risk: "read_only",
      timeoutMs: 1_000,
    }],
    permissions: { network: "deny", filesystem: "read_only", process: "sandboxed", secrets: "none" },
    resources: { cpuTimeMs: 10_000, memoryBytes: 64 * 1024 * 1024, maximumProcesses: 2, maximumWriteBytes: 1_024 },
    platforms: [process.platform],
  };
  const trustRoots = new Map([["release-key", publicKey]]);
  return { root, sourceRoot, stagingRoot, privateKey, publicKey, manifest, trustRoots };
}

describe("Tool Provider deterministic signed archives", () => {
  it("publishes byte-identical archives and verifies them before isolated extraction", () => {
    const context = fixture();
    const firstPath = join(context.root, "first.tfpa");
    const secondPath = join(context.root, "second.tfpa");
    const first = createSignedToolProviderArchive({
      sourceRoot: context.sourceRoot,
      manifestValue: context.manifest,
      privateKey: context.privateKey,
      keyId: "release-key",
      archivePath: firstPath,
    });
    const second = createSignedToolProviderArchive({
      sourceRoot: context.sourceRoot,
      manifestValue: context.manifest,
      privateKey: context.privateKey,
      keyId: "release-key",
      archivePath: secondPath,
    });

    expect(readFileSync(firstPath)).toEqual(readFileSync(secondPath));
    expect(first.archiveSha256).toBe(second.archiveSha256);
    expect(first.manifest.artifact.packageSha256).not.toBe("0".repeat(64));

    const extracted = extractAndVerifyToolProviderArchive({
      archivePath: firstPath,
      stagingRoot: context.stagingRoot,
      trustRoots: context.trustRoots,
    });
    expect(extracted.manifest).toEqual(first.manifest);
    expect(extracted.package.digest).toBe(first.package.digest);
    expect(readFileSync(join(extracted.packageRoot, "provider.bin"), "utf8")).toBe("neutral provider executable");
  });

  it("rejects traversal, non-canonical content, and unknown signing roots before extraction", () => {
    const context = fixture();
    const archivePath = join(context.root, "provider.tfpa");
    createSignedToolProviderArchive({
      sourceRoot: context.sourceRoot,
      manifestValue: context.manifest,
      privateKey: context.privateKey,
      keyId: "release-key",
      archivePath,
    });

    expect(() => extractAndVerifyToolProviderArchive({
      archivePath,
      stagingRoot: context.stagingRoot,
      trustRoots: new Map(),
    })).toThrow("Unknown Tool Provider signing key");

    const traversalPath = join(context.root, "traversal.tfpa");
    rewriteArchive(archivePath, traversalPath, (envelope) => {
      const entries = envelope.entries as Array<Record<string, unknown>>;
      entries[0].path = "../escape";
    });
    expect(() => extractAndVerifyToolProviderArchive({
      archivePath: traversalPath,
      stagingRoot: context.stagingRoot,
      trustRoots: context.trustRoots,
    })).toThrow("escapes or ambiguously addresses");

    const contentPath = join(context.root, "content.tfpa");
    rewriteArchive(archivePath, contentPath, (envelope) => {
      const entries = envelope.entries as Array<Record<string, unknown>>;
      const file = entries.find((entry) => entry.type === "file")!;
      file.contentBase64 = `${String(file.contentBase64).slice(0, -1)} `;
    });
    expect(() => extractAndVerifyToolProviderArchive({
      archivePath: contentPath,
      stagingRoot: context.stagingRoot,
      trustRoots: context.trustRoots,
    })).toThrow("canonical base64");
  });

  it("enforces decompression, file-count, and package-byte limits", () => {
    const context = fixture();
    const archivePath = join(context.root, "provider.tfpa");
    createSignedToolProviderArchive({
      sourceRoot: context.sourceRoot,
      manifestValue: context.manifest,
      privateKey: context.privateKey,
      keyId: "release-key",
      archivePath,
    });

    expect(() => extractAndVerifyToolProviderArchive({
      archivePath,
      stagingRoot: context.stagingRoot,
      trustRoots: context.trustRoots,
      policy: { ...DEFAULT_TOOL_PROVIDER_ARCHIVE_POLICY, maximumEnvelopeBytes: 32 },
    })).toThrow("cannot be decompressed within policy");
    expect(() => extractAndVerifyToolProviderArchive({
      archivePath,
      stagingRoot: context.stagingRoot,
      trustRoots: context.trustRoots,
      policy: { ...DEFAULT_TOOL_PROVIDER_ARCHIVE_POLICY, maximumEntries: 2 },
    })).toThrow("exceeds 2 entries");
    expect(() => extractAndVerifyToolProviderArchive({
      archivePath,
      stagingRoot: context.stagingRoot,
      trustRoots: context.trustRoots,
      policy: { ...DEFAULT_TOOL_PROVIDER_ARCHIVE_POLICY, maximumFiles: 1 },
    })).toThrow("exceeds 1 files");
    expect(() => extractAndVerifyToolProviderArchive({
      archivePath,
      stagingRoot: context.stagingRoot,
      trustRoots: context.trustRoots,
      policy: { ...DEFAULT_TOOL_PROVIDER_ARCHIVE_POLICY, maximumBytes: 1 },
    })).toThrow("exceeds 1 package bytes");
  });

  it("rejects manifest signature tampering and case-colliding source packages", () => {
    const context = fixture();
    const archivePath = join(context.root, "provider.tfpa");
    createSignedToolProviderArchive({
      sourceRoot: context.sourceRoot,
      manifestValue: context.manifest,
      privateKey: context.privateKey,
      keyId: "release-key",
      archivePath,
    });
    const tamperedPath = join(context.root, "tampered.tfpa");
    rewriteArchive(archivePath, tamperedPath, (envelope) => {
      const signature = envelope.signature as Record<string, unknown>;
      const value = String(signature.value);
      signature.value = `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`;
    });
    expect(() => extractAndVerifyToolProviderArchive({
      archivePath: tamperedPath,
      stagingRoot: context.stagingRoot,
      trustRoots: context.trustRoots,
    })).toThrow("signature verification failed");

    const collisionPath = join(context.root, "collision.tfpa");
    rewriteArchive(archivePath, collisionPath, (envelope) => {
      const entries = envelope.entries as Array<Record<string, unknown>>;
      const file = entries.find((entry) => entry.type === "file")!;
      envelope.entries = [{ ...file, path: "Alpha" }, { ...file, path: "alpha" }];
    });
    expect(() => extractAndVerifyToolProviderArchive({
      archivePath: collisionPath,
      stagingRoot: context.stagingRoot,
      trustRoots: context.trustRoots,
    })).toThrow("duplicate path");
  });
});

function rewriteArchive(source: string, target: string, mutate: (envelope: Record<string, unknown>) => void): void {
  const envelope = JSON.parse(gunzipSync(readFileSync(source)).toString("utf8")) as Record<string, unknown>;
  mutate(envelope);
  writeFileSync(target, gzipSync(Buffer.from(canonicalJson(envelope)), { level: 9 }));
}
