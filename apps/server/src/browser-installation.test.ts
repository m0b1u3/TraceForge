import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, realpathSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInstalledBrowserDeployment, loadBrowserInstallation, type BrowserInstallation } from "./browser-installation.js";
import type { ToolExecutionContext } from "@traceforge/worker-runtime";
import { BROWSER_RUNTIME_SOURCE_LOCK_PROFILE, BROWSER_RUNTIME_SOURCE_AUTHORITY_PROFILE,
  browserRuntimeMaterialSha256, browserRuntimeBuildAttestationSha256, browserRuntimeSourceLockSha256,
  createBrowserRuntimeSourceReview, verifyBrowserRuntimeSourceReview, createBrowserRuntimeReleaseManifest,
  measureBrowserRuntimeTree } from "@traceforge/browser-runtime";
import { createTestBrowserRuntimeBuildAttestation } from "../../../packages/browser-runtime/src/test-fixtures/browser-runtime-material.js";
import { BrowserScratchStore } from "./browser-scratch.js";
import { createDb, getSqliteClient } from "./db/client.js";
const directories: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "browser-installation-"))); directories.push(root);
  const releaseDirectory = join(root, "release"), scratchDirectory = join(root, "scratch"); mkdirSync(releaseDirectory); mkdirSync(scratchDirectory);
  const sourceAuthorityPath = join(root, "authority.json"); writeFileSync(sourceAuthorityPath, "{}");
  const config: BrowserInstallation = { releaseDirectory, scratchDirectory, sourceAuthorityPath, nodeExecutable: process.execPath, nodeSha256: "a".repeat(64),
    expectedSandboxBackend: "fixture", expectedBackendMeasurement: "b".repeat(64), resources: { cpuTimeMs: 10000, memoryBytes: 1048576, maximumProcesses: 8, writeBytes: 1048576 } };
  const artifacts = { recordObservation: vi.fn(), recordDownload: vi.fn() };
  const context: ToolExecutionContext = { caseId: "case", runId: "run", workId: "work", workerId: "worker", scopeRef: "scope", leaseId: "lease", leaseExpiresAt: "2099-01-01T00:00:00Z", idempotencyKey: "invocation",
    effectivePermissions: { version: 1, platform: "linux", filesystem: { read: [], write: [], deny: [] }, network: "brokered", process: { access: "sandboxed", interactive: false, background: false }, secrets: "deny", sources: [] } };
  return { config, artifacts, context };
}
it("rejects incomplete installation identities at assembly", () => {
  const f = fixture();
  expect(() => createInstalledBrowserDeployment({ ...f.config, releaseDirectory: "relative" }, f.artifacts)).toThrow("absolute");
  expect(() => createInstalledBrowserDeployment({ ...f.config, nodeSha256: "" }, f.artifacts)).toThrow("measured");
});
it("loads only an explicit bounded strict host configuration", async () => {
  const f = fixture(), path = join(f.config.scratchDirectory, "installation.json");
  writeFileSync(path, JSON.stringify(f.config)); expect(await loadBrowserInstallation(path)).toEqual(f.config);
  writeFileSync(path, JSON.stringify({ ...f.config, directNetwork: true })); await expect(loadBrowserInstallation(path)).rejects.toThrow();
  writeFileSync(path, "x".repeat(16385)); await expect(loadBrowserInstallation(path)).rejects.toThrow("exceeds limit");
  await expect(loadBrowserInstallation("relative.json")).rejects.toThrow("absolute");
});
it("keeps unsupported native platforms closed without reading release material", async () => {
  const f = fixture(); vi.stubGlobal("process", { ...process, platform: "darwin", arch: "x64" });
  await expect(createInstalledBrowserDeployment(f.config, f.artifacts).prepare(f.context, new AbortController().signal)).rejects.toThrow("not supported");
  expect(f.artifacts.recordObservation).not.toHaveBeenCalled();
});
it("rejects missing, oversized and malformed release documents without a launch", async () => {
  const f = fixture(); vi.stubGlobal("process", { ...process, platform: "linux", arch: "x64" });
  const deployment = createInstalledBrowserDeployment(f.config, f.artifacts);
  await expect(deployment.prepare(f.context, new AbortController().signal)).rejects.toThrow();
  writeFileSync(join(f.config.releaseDirectory, "release.json"), "x".repeat(65537));
  await expect(deployment.prepare(f.context, new AbortController().signal)).rejects.toThrow("exceeds limit");
  writeFileSync(join(f.config.releaseDirectory, "release.json"), "{}");
  await expect(deployment.prepare(f.context, new AbortController().signal)).rejects.toThrow();
});
it("rejects cancellation and a trust anchor inside the release tree", async () => {
  const f = fixture(); vi.stubGlobal("process", { ...process, platform: "linux", arch: "x64" });
  const abort = new AbortController(); abort.abort();
  await expect(createInstalledBrowserDeployment(f.config, f.artifacts).prepare(f.context, abort.signal)).rejects.toThrow();
  const sourceAuthorityPath = join(f.config.releaseDirectory, "authority.json"); writeFileSync(sourceAuthorityPath, "{}");
  await expect(createInstalledBrowserDeployment({ ...f.config, sourceAuthorityPath }, f.artifacts).prepare(f.context, new AbortController().signal)).rejects.toThrow("separated");
  const scratchAuthority = join(f.config.scratchDirectory, "authority.json"); writeFileSync(scratchAuthority, "{}");
  await expect(createInstalledBrowserDeployment({ ...f.config, sourceAuthorityPath: scratchAuthority }, f.artifacts).prepare(f.context, new AbortController().signal)).rejects.toThrow("separated");
});

// Real files and real signature/tree verification; these bytes are fixtures,
// not an executable Chromium distribution or native isolation evidence.
async function installedFixture() {
  const f = fixture(), root = f.config.releaseDirectory;
  const controller = Buffer.from("fixture controller"), browser = Buffer.from("fixture browser"), node = Buffer.from("fixture node");
  mkdirSync(join(root, "chromium")); writeFileSync(join(root, "chromium/chrome"), browser);
  writeFileSync(join(root, "controller.mjs"), controller);
  f.config.nodeExecutable = join(root, "node"); writeFileSync(f.config.nodeExecutable, node);
  f.config.nodeSha256 = browserRuntimeMaterialSha256(node);
  const tree = await measureBrowserRuntimeTree(join(root, "chromium"));
  const target = { platform: "linux" as const, architecture: "x64" as const, archiveFormat: "zip" as const,
    url: "https://downloads.example.invalid/browser.zip", archiveBytes: 1024, archiveSha256: "a".repeat(64), rootDirectory: "chromium", executable: "chrome" };
  const attestation = createTestBrowserRuntimeBuildAttestation({ version: "HeadlessChrome/140.0.0.0", revision: "1".repeat(40), target, browserTreeSha256: tree.sha256 });
  const lock = { format: 1 as const, profile: BROWSER_RUNTIME_SOURCE_LOCK_PROFILE, sourceId: "fixture-distribution",
    version: "HeadlessChrome/140.0.0.0", revision: "1".repeat(40), createdAt: "2026-09-04T00:00:00.000Z",
    buildAttestationSha256: browserRuntimeBuildAttestationSha256(attestation),
    securityReviewRef: `sha256:${attestation.compliance.securityAssessmentSha256}`, licenseReviewRef: `sha256:${attestation.compliance.licenseReviewSha256}`, targets: [target] };
  const keys = generateKeyPairSync("ed25519");
  const authority = { format: 1 as const, profile: BROWSER_RUNTIME_SOURCE_AUTHORITY_PROFILE, keyId: "fixture-reviewer",
    publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString(), sourceIds: [lock.sourceId],
    validFrom: "2026-09-01T00:00:00.000Z", validUntil: "2099-01-01T00:00:00.000Z", revokedAt: null };
  const review = createBrowserRuntimeSourceReview({ sourceLock: lock, keyId: authority.keyId,
    privateKeyPem: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), issuedAt: "2026-09-04T00:01:00.000Z", expiresAt: "2098-01-01T00:00:00.000Z" });
  const verified = verifyBrowserRuntimeSourceReview({ sourceLock: lock, sourceReview: review, authority });
  const manifest = createBrowserRuntimeReleaseManifest({ platform: "linux", architecture: "x64",
    source: { lockSha256: browserRuntimeSourceLockSha256(lock), sourceId: lock.sourceId, version: lock.version, revision: lock.revision,
      archiveBytes: target.archiveBytes, archiveSha256: target.archiveSha256, securityReviewRef: lock.securityReviewRef, licenseReviewRef: lock.licenseReviewRef,
      reviewKeyId: review.keyId, reviewSha256: verified.reviewSha256, reviewExpiresAt: review.expiresAt, buildAttestationSha256: lock.buildAttestationSha256 },
    controller: { executable: "controller.mjs", version: "1.0.0", bytes: controller },
    browser: { root: "chromium", executable: "chrome", version: lock.version, executableSha256: browserRuntimeMaterialSha256(browser), tree } });
  for (const [name, value] of Object.entries({ "release.json": manifest, "source-lock.json": lock, "source-review.json": review, "build-attestation.json": attestation }))
    writeFileSync(join(root, name), JSON.stringify(value));
  writeFileSync(f.config.sourceAuthorityPath, JSON.stringify(authority));
  f.context.effectivePermissions.filesystem = { read: [{ path: root, scope: "tree" }, { path: f.config.sourceAuthorityPath, scope: "exact" }],
    write: [{ path: f.config.scratchDirectory, scope: "tree" }], deny: [] };
  vi.stubGlobal("process", { ...process, platform: "linux", arch: "x64" });
  return { ...f, authority };
}
it("verifies a signed on-disk installation, creates a private launch and retains uncertain cleanup", async () => {
  const f = await installedFixture(), deployment = createInstalledBrowserDeployment(f.config, f.artifacts);
  const launch = await deployment.prepare(f.context, new AbortController().signal);
  expect(launch.controllerIdentity.browserSha256).toHaveLength(64);
  expect(launch.arguments).toContain(`--browser=${join(f.config.releaseDirectory, "chromium/chrome")}`);
  expect(launch.permissions).toEqual(f.context.effectivePermissions);
  expect(launch.restrictWritesToWorkingDirectory).toBe(true);
  expect(existsSync(launch.workingDirectory)).toBe(true);
  await deployment.release!(f.context, false); expect(existsSync(launch.workingDirectory)).toBe(true);
  await expect(deployment.prepare(f.context, new AbortController().signal)).rejects.toThrow("already prepared");
  await deployment.release!(f.context, true); expect(existsSync(launch.workingDirectory)).toBe(false);
});
it("rechecks modified launch files and revoked trust before allocating scratch", async () => {
  const f = await installedFixture(), deployment = createInstalledBrowserDeployment(f.config, f.artifacts);
  writeFileSync(f.config.nodeExecutable, "changed");
  await expect(deployment.prepare(f.context, new AbortController().signal)).rejects.toThrow("Node executable changed");
  writeFileSync(f.config.nodeExecutable, "fixture node");
  writeFileSync(join(f.config.releaseDirectory, "controller.mjs"), "changed controller");
  await expect(deployment.prepare(f.context, new AbortController().signal)).rejects.toThrow();
  writeFileSync(join(f.config.releaseDirectory, "controller.mjs"), "fixture controller");
  writeFileSync(join(f.config.releaseDirectory, "chromium/chrome"), "changed browser");
  await expect(deployment.prepare(f.context, new AbortController().signal)).rejects.toThrow();
  writeFileSync(join(f.config.releaseDirectory, "chromium/chrome"), "fixture browser");
  writeFileSync(f.config.sourceAuthorityPath, JSON.stringify({ ...f.authority, revokedAt: "2026-09-05T00:00:00.000Z" }));
  await expect(deployment.prepare(f.context, new AbortController().signal)).rejects.toThrow();
  expect(readdirSync(f.config.scratchDirectory)).toEqual([]);
});
it("wires durable dispatch fencing into a verified installation and recovery", async () => {
  const f = await installedFixture(), db = getSqliteClient(createDb(":memory:"));
  try {
    const deployment = createInstalledBrowserDeployment(f.config, f.artifacts, new BrowserScratchStore(db));
    const launch = await deployment.prepare(f.context, new AbortController().signal);
    deployment.beforeDispatch!(f.context, "actual-browser-launch");
    const reopened = createInstalledBrowserDeployment(f.config, f.artifacts, new BrowserScratchStore(db));
    await reopened.recover!(); expect(existsSync(launch.workingDirectory)).toBe(true);
    await expect(reopened.prepare(f.context, new AbortController().signal)).rejects.toThrow();
    expect(readdirSync(f.config.scratchDirectory)).toHaveLength(1);
    await deployment.release!(f.context, true); expect(existsSync(launch.workingDirectory)).toBe(false);
  } finally { db.close(); }
});
it("rejects write access to any release descendant before launch", async () => {
  const f = await installedFixture();
  f.context.effectivePermissions.filesystem.write.push({ path: join(f.config.releaseDirectory, "chromium/cache"), scope: "tree" });
  await expect(createInstalledBrowserDeployment(f.config, f.artifacts).prepare(f.context, new AbortController().signal)).rejects.toThrow("tree must be read-only");
  expect(readdirSync(f.config.scratchDirectory)).toEqual([]);
});

it("does not turn an exact scratch-root grant into writable child trees", async () => {
  const f = await installedFixture();
  f.context.effectivePermissions.filesystem.write = [{ path: f.config.scratchDirectory, scope: "exact" }];
  await expect(createInstalledBrowserDeployment(f.config, f.artifacts).prepare(f.context, new AbortController().signal)).rejects.toThrow("authorized writable tree");
  expect(readdirSync(f.config.scratchDirectory)).toEqual([]);
});

it("cleans a cancelled allocation and permits retry without leaving a durable fence", async () => {
  const f = await installedFixture(), db = getSqliteClient(createDb(":memory:"));
  try {
    const store = new BrowserScratchStore(db), abort = new AbortController();
    const allocate = store.allocate.bind(store);
    vi.spyOn(store, "allocate").mockImplementationOnce(async (...args) => {
      const path = await allocate(...args); abort.abort(); return path;
    });
    const deployment = createInstalledBrowserDeployment(f.config, f.artifacts, store);
    await expect(deployment.prepare(f.context, abort.signal)).rejects.toThrow();
    expect(readdirSync(f.config.scratchDirectory)).toEqual([]);
    expect(db.prepare("SELECT count(*) AS count FROM browser_scratch").get()).toEqual({ count: 0 });
    const launch = await deployment.prepare(f.context, new AbortController().signal);
    expect(existsSync(launch.workingDirectory)).toBe(true);
    await deployment.release!(f.context, true);
  } finally { db.close(); }
});

it("rejects a launch executable inside the scratch root", async () => {
  const f = await installedFixture();
  f.config.nodeExecutable = join(f.config.scratchDirectory, "node");
  writeFileSync(f.config.nodeExecutable, "fixture node");
  await expect(createInstalledBrowserDeployment(f.config, f.artifacts).prepare(f.context, new AbortController().signal)).rejects.toThrow("outside scratch");
  expect(readdirSync(f.config.scratchDirectory)).toEqual(["node"]);
});
