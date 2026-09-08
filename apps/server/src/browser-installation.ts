import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, mkdtemp, rm } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { verifyInstalledBrowserRuntimeRelease, parseBrowserRuntimeReleaseManifest, type BrowserArtifactPort } from "@traceforge/browser-runtime";
import { allowsFileSystemPath, satisfiesPermissionRequirements } from "@traceforge/orchestration-core";
import type { ExecutionResourceLimits } from "@traceforge/execution-node";
import type { ToolExecutionContext } from "@traceforge/worker-runtime";
import type { ScenarioBrowserDeployment } from "./scenario-browser-host.js";
import type { BrowserScratchStore } from "./browser-scratch.js";
import { z } from "zod";

export interface BrowserInstallation {
  releaseDirectory: string;
  /** Independent trust anchor outside the release tree. */
  sourceAuthorityPath: string;
  nodeExecutable: string;
  nodeSha256: string;
  scratchDirectory: string;
  expectedSandboxBackend: string;
  expectedBackendMeasurement: string;
  acceptedResourcePolicy?: "sampled_terminate";
  resources: ExecutionResourceLimits;
}
const installationPath = z.string().min(1).max(4096).refine(path => isAbsolute(path) && !path.includes("\0"), "Browser installation paths must be bounded and absolute");
const installationSchema = z.object({ releaseDirectory: installationPath, sourceAuthorityPath: installationPath,
  nodeExecutable: installationPath, scratchDirectory: installationPath, nodeSha256: z.string().regex(/^[a-f0-9]{64}$/, "Browser installation requires measured launch identities"),
  expectedSandboxBackend: z.string().trim().min(1).max(256), expectedBackendMeasurement: z.string().regex(/^[a-f0-9]{64}$/),
  acceptedResourcePolicy: z.literal("sampled_terminate").optional(),
  resources: z.object({ cpuTimeMs: z.number().int().positive().safe(), memoryBytes: z.number().int().positive().safe(),
    maximumProcesses: z.number().int().positive().safe(), writeBytes: z.number().int().nonnegative().safe() }).strict(),
}).strict();

/** Explicit host configuration file; never searched for or accepted over RPC. */
export async function loadBrowserInstallation(path: string): Promise<BrowserInstallation> {
  return installationSchema.parse(await json(installationPath.parse(path), 16384));
}

/** Host-owned installation configuration only. Each invocation revalidates the
 * release; the controller independently repeats validation inside the sandbox. */
export function createInstalledBrowserDeployment(input: BrowserInstallation, artifacts: BrowserArtifactPort,
  scratchStore?: BrowserScratchStore): ScenarioBrowserDeployment {
  const config = installationSchema.parse(structuredClone(input)), scratches = new Map<string, string>();
  const preparing = new Set<string>();
  for (const path of [config.releaseDirectory, config.sourceAuthorityPath, config.nodeExecutable, config.scratchDirectory]) {
    if (!isAbsolute(path) || path.includes("\0") || path.length > 4096) throw new Error("Browser installation paths must be bounded and absolute");
  }
  if (!/^[a-f0-9]{64}$/.test(config.nodeSha256) || !/^[a-f0-9]{64}$/.test(config.expectedBackendMeasurement) || !config.expectedSandboxBackend.trim()) throw new Error("Browser installation requires measured launch identities");
  const key = (context: ToolExecutionContext) => JSON.stringify([context.caseId, context.runId, context.workId, context.leaseId, context.idempotencyKey]);
  let recovery: Promise<void> | undefined;
  const recover = () => recovery ??= scratchStore?.recover(config.scratchDirectory) ?? Promise.resolve();
  return { artifacts, recover,
    beforeDispatch: (context, processKey) => scratchStore?.beforeDispatch(context, processKey),
    async prepare(context, signal) {
      signal.throwIfAborted();
      await recover();
      const invocation = key(context);
      if (scratches.has(invocation) || preparing.has(invocation)) throw new Error("Browser invocation already prepared or cleanup is unresolved");
      preparing.add(invocation);
      try {
      if (!["linux", "win32", "darwin"].includes(process.platform) || !["x64", "arm64"].includes(process.arch)
        || (process.platform === "darwin" && process.arch !== "arm64")) throw new Error("Browser native production platform is not supported by this installation loader");
      const root = await realpath(config.releaseDirectory), scratchRoot = await realpath(config.scratchDirectory), authority = await realpath(config.sourceAuthorityPath);
      if (inside(root, authority) || inside(scratchRoot, authority) || inside(root, scratchRoot) || inside(scratchRoot, root)) throw new Error("Browser trust, release and scratch locations must be separated");
      if (inside(scratchRoot, await realpath(config.nodeExecutable))) throw new Error("Browser Node executable must be outside scratch");
      const manifestPath = join(root, "release.json"), lockPath = join(root, "source-lock.json"), reviewPath = join(root, "source-review.json"), attestationPath = join(root, "build-attestation.json");
      const manifest = parseBrowserRuntimeReleaseManifest(await json(manifestPath, 65536));
      const controllerPath = join(root, manifest.controller.executable), browserRoot = join(root, manifest.browser.root), browserPath = join(browserRoot, manifest.browser.executable);
      if (!inside(root, await realpath(controllerPath)) || !inside(root, await realpath(browserRoot)) || !inside(root, await realpath(browserPath))) throw new Error("Browser release path escapes installation");
      const profile = context.effectivePermissions;
      if (profile.network !== "brokered" || profile.process.access !== "sandboxed") throw new Error("Browser requires sandboxed process and brokered permissions");
      if (profile.platform !== (process.platform === "win32" ? "windows" : process.platform)) throw new Error("Browser permission platform mismatch");
      // Check overlapping descendants too, not only the entry-point binaries.
      if (profile.filesystem.write.some(grant => inside(root, grant.path) || (grant.scope === "tree" && inside(grant.path, root))))
        throw new Error("Browser release tree must be read-only");
      for (const path of [config.nodeExecutable, controllerPath, browserPath, manifestPath, lockPath, reviewPath, attestationPath, authority]) {
        if (!allowsFileSystemPath(profile, "read", path) || allowsFileSystemPath(profile, "write", path)) throw new Error("Browser release and trust files require read-only invocation grants");
      }
      if (!allowsFileSystemPath(profile, "write", scratchRoot)) throw new Error("Browser scratch is outside invocation write grants");
      if (await digest(config.nodeExecutable) !== config.nodeSha256) throw new Error("Browser controller Node executable changed");
      const verified = await verifyInstalledBrowserRuntimeRelease({ manifest, sourceLock: await json(lockPath, 262144), sourceReview: await json(reviewPath, 65536),
        sourceAuthority: await json(authority, 32768), buildAttestation: await json(attestationPath, 262144), platform: process.platform as "linux" | "win32" | "darwin",
        architecture: process.arch as "x64" | "arm64", controllerPath, browserRootPath: browserRoot, browserPath });
      signal.throwIfAborted();
      const scratch = scratchStore ? await scratchStore.allocate(scratchRoot, context) : await mkdtemp(join(scratchRoot, "browser-"));
      scratches.set(invocation, scratch);
      try {
        signal.throwIfAborted();
        if (!satisfiesPermissionRequirements(profile, { filesystem: { write: [{ path: scratch, scope: "tree" }] } }))
          throw new Error("Browser private scratch requires an authorized writable tree without denied descendants");
      } catch (error) {
        // No process was dispatched. Remove only this successfully allocated directory.
        if (scratchStore) await scratchStore.release(context, true);
        else await rm(scratch, { recursive: true, force: false });
        scratches.delete(invocation);
        throw error;
      }
      return { controlTransport: "pipe", controllerIdentity: verified.identity, expectedSandboxBackend: config.expectedSandboxBackend,
        expectedBackendMeasurement: config.expectedBackendMeasurement, executable: config.nodeExecutable,
        acceptedResourcePolicy: config.acceptedResourcePolicy,
        arguments: [controllerPath, `--release-manifest=${manifestPath}`, `--source-lock=${lockPath}`, `--source-review=${reviewPath}`,
          `--source-authority=${authority}`, `--build-attestation=${attestationPath}`, `--browser-root=${browserRoot}`, `--browser=${browserPath}`,
          `--working-directory=${scratch}`, `--user-data-directory=${join(scratch, "profile")}`],
        workingDirectory: scratch, restrictWritesToWorkingDirectory: true, environment: {}, permissions: structuredClone(profile), resources: structuredClone(config.resources), timeoutMs: 30000, outputLimitBytes: 1048576 };
      } finally { preparing.delete(invocation); }
    },
    async release(context, terminalConfirmed) {
      if (scratchStore) { await scratchStore.release(context, terminalConfirmed); if (terminalConfirmed) scratches.delete(key(context)); return; }
      const id = key(context), scratch = scratches.get(id);
      if (!scratch || !terminalConfirmed) return;
      // Exact directory created above; uncertain process outcomes retain it.
      await rm(scratch, { recursive: true, force: false }); scratches.delete(id);
    },
  };
}
function inside(root: string, path: string) { const part = relative(root, path); return part === "" || (!part.startsWith(`..${sep}`) && part !== ".." && !isAbsolute(part)); }
async function json(path: string, maximum: number): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat(); if (!before.isFile() || before.size > maximum) throw new Error("Browser installation document exceeds limit");
    const bytes = Buffer.alloc(maximum + 1); const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const after = await file.stat();
    if (bytesRead !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("Browser installation document changed");
    return JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
  } finally { await file.close(); }
}
async function digest(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat(); if (!before.isFile() || before.size > 268435456) throw new Error("Node executable is invalid");
    const hash = createHash("sha256"); for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
    const after = await file.stat(); if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("Node executable changed while measuring");
    return hash.digest("hex");
  } finally { await file.close(); }
}
