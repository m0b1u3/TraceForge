import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type { buildServer } from "@traceforge/server";

type Installation = NonNullable<Parameters<typeof buildServer>[5]>["browserInstallation"];

/** Resolve only application-owned resources. This is assembly, not approval:
 * the Server still verifies the signed source review, tree and launch identity.
 * Never discover Chrome, use a user profile, or trust a renderer-provided path. */
export async function bundledBrowserInstallation(resourcesRoot: string, userData: string): Promise<Installation> {
  if (!isAbsolute(resourcesRoot) || !isAbsolute(userData)) throw new Error("Browser resource roots must be absolute");
  const root = await realpath(join(resourcesRoot, "browser-runtime"));
  const resources = await realpath(resourcesRoot);
  if (!inside(resources, root)) throw new Error("Bundled browser escapes application resources");
  const configPath = join(root, "installation.json");
  const file = await open(configPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let value: Record<string, unknown>;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 16384) throw new Error("Bundled browser metadata exceeds limit");
    const bytes = Buffer.alloc(16385), result = await file.read(bytes, 0, bytes.length, 0);
    const after = await file.stat();
    if (result.bytesRead !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs)
      throw new Error("Bundled browser metadata changed");
    value = JSON.parse(bytes.subarray(0, result.bytesRead).toString("utf8"));
  } finally { await file.close(); }
  const keys = ["format", "platform", "architecture", "nodeSha256", "expectedSandboxBackend", "expectedBackendMeasurement", "resources"];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== keys.sort().join()
    || value.format !== 1 || value.platform !== process.platform || value.architecture !== process.arch
    || !/^[a-f0-9]{64}$/.test(String(value.nodeSha256)) || !/^[a-f0-9]{64}$/.test(String(value.expectedBackendMeasurement))
    || typeof value.expectedSandboxBackend !== "string" || !value.expectedSandboxBackend.trim() || value.expectedSandboxBackend.length > 256)
    throw new Error("Bundled browser metadata is incompatible");
  const limits = value.resources as Record<string, unknown>;
  const resourceKeys = ["cpuTimeMs", "memoryBytes", "maximumProcesses", "writeBytes"];
  if (!limits || typeof limits !== "object" || Array.isArray(limits)
    || Object.keys(limits).sort().join() !== resourceKeys.sort().join()
    || resourceKeys.some(k => !Number.isSafeInteger(limits[k]) || (limits[k] as number) < (k === "writeBytes" ? 0 : 1)))
    throw new Error("Bundled browser resource limits are invalid");
  const releaseDirectory = await realpath(join(root, "release"));
  const sourceAuthorityPath = await realpath(join(root, "source-authority.json"));
  const nodeExecutable = await realpath(join(root, process.platform === "win32" ? "node.exe" : "node"));
  for (const path of [releaseDirectory, sourceAuthorityPath, nodeExecutable]) if (!inside(root, path))
    throw new Error("Bundled browser material escapes application resources");
  if (!(await lstat(releaseDirectory)).isDirectory() || !(await lstat(sourceAuthorityPath)).isFile() || !(await lstat(nodeExecutable)).isFile())
    throw new Error("Bundled browser material is incomplete");
  const scratchDirectory = join(await realpath(userData), "browser-scratch");
  await mkdir(scratchDirectory, { recursive: true, mode: 0o700 });
  if ((await lstat(scratchDirectory)).isSymbolicLink() || await realpath(scratchDirectory) !== scratchDirectory)
    throw new Error("Browser scratch must be a private application directory");
  if (inside(root, scratchDirectory) || inside(scratchDirectory, root)) throw new Error("Browser scratch overlaps release");
  return { isolation: "chromium", releaseDirectory, sourceAuthorityPath, nodeExecutable, scratchDirectory,
    nodeSha256: value.nodeSha256 as string, expectedSandboxBackend: value.expectedSandboxBackend,
    expectedBackendMeasurement: value.expectedBackendMeasurement as string,
    acceptedResourcePolicy: "sampled_terminate",
    resources: { cpuTimeMs: limits.cpuTimeMs as number, memoryBytes: limits.memoryBytes as number,
      maximumProcesses: limits.maximumProcesses as number, writeBytes: limits.writeBytes as number } };
}
function inside(root: string, path: string) {
  const part = relative(root, path);
  return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`));
}
