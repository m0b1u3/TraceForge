import { constants } from "node:fs";
import { access, cp, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { extractBrowserRuntimeSourceArchive } from "./browser-runtime-archive.js";
import {
  browserRuntimeMaterialSha256,
  createBrowserRuntimeReleaseManifest,
  type BrowserRuntimeReleaseManifest,
} from "./browser-runtime-release.js";
import { measureBrowserRuntimeTree } from "./browser-runtime-tree.js";
import { selectBrowserRuntimeSourceTarget } from "./browser-runtime-source-lock.js";
import { verifyBrowserRuntimeSourceReview } from "./browser-runtime-source-review.js";
import { verifyBrowserRuntimeBuildAttestation } from "./browser-runtime-build-attestation.js";

export interface AssembleBrowserRuntimeReleaseInput {
  destination: string;
  controllerSource: string;
  controllerVersion: string;
  sourceLock: unknown;
  sourceReview: unknown;
  sourceAuthority: unknown;
  buildAttestation: unknown;
  sourceArchivePath: string;
  platform: BrowserRuntimeReleaseManifest["platform"];
  architecture: BrowserRuntimeReleaseManifest["architecture"];
}

export interface AssembledBrowserRuntimeRelease {
  root: string;
  controllerPath: string;
  browserRootPath: string;
  browserPath: string;
  manifestPath: string;
  sourceLockPath: string;
  sourceReviewPath: string;
  buildAttestationPath: string;
  manifest: BrowserRuntimeReleaseManifest;
}

export async function assembleBrowserRuntimeRelease(
  input: AssembleBrowserRuntimeReleaseInput,
): Promise<AssembledBrowserRuntimeRelease> {
  validateInput(input);
  const reviewed = verifyBrowserRuntimeSourceReview({
    sourceLock: input.sourceLock,
    sourceReview: input.sourceReview,
    authority: input.sourceAuthority,
  });
  const built = verifyBrowserRuntimeBuildAttestation({
    sourceLock: reviewed.lock,
    attestation: input.buildAttestation,
    platform: input.platform,
    architecture: input.architecture,
  });
  const selected = selectBrowserRuntimeSourceTarget(reviewed.lock, input.platform, input.architecture);
  const destination = resolve(input.destination);
  const parent = dirname(destination);
  await mkdir(parent, { recursive: true });
  await assertMissing(destination, "Browser Runtime release destination already exists");
  const controllerInfo = await lstat(input.controllerSource);
  if (!controllerInfo.isFile() || controllerInfo.isSymbolicLink()) {
    throw new Error("Browser Runtime Controller source must be a regular file");
  }
  const temporary = await mkdtemp(join(parent, ".traceforge-browser-release-"));
  try {
    const controllerPath = join(temporary, basename(input.controllerSource));
    await cp(input.controllerSource, controllerPath, { errorOnExist: true, force: false, preserveTimestamps: true });
    const extractionRoot = join(temporary, ".source");
    const extracted = await extractBrowserRuntimeSourceArchive({
      target: selected.target,
      archivePath: input.sourceArchivePath,
      destination: extractionRoot,
    });
    const browserRootPath = join(temporary, selected.target.rootDirectory);
    await rename(extracted.browserRootPath, browserRootPath);
    await rm(extractionRoot, { recursive: true, force: false });
    const browserPath = resolve(browserRootPath, selected.target.executable);
    const [controllerBytes, browserBytes, stagedTree] = await Promise.all([
      readFile(controllerPath),
      readFile(browserPath),
      measureBrowserRuntimeTree(browserRootPath),
    ]);
    if (stagedTree.sha256 !== built.attestation.target.browserTreeSha256) {
      throw new Error("Browser Runtime staged browser tree does not match its build attestation");
    }
    const manifest = createBrowserRuntimeReleaseManifest({
      platform: input.platform,
      architecture: input.architecture,
      source: {
        lockSha256: selected.lockSha256,
        sourceId: selected.lock.sourceId,
        version: selected.lock.version,
        revision: selected.lock.revision,
        archiveBytes: selected.target.archiveBytes,
        archiveSha256: selected.target.archiveSha256,
        securityReviewRef: selected.lock.securityReviewRef,
        licenseReviewRef: selected.lock.licenseReviewRef,
        reviewKeyId: reviewed.review.keyId,
        reviewSha256: reviewed.reviewSha256,
        reviewExpiresAt: reviewed.review.expiresAt,
        buildAttestationSha256: built.attestationSha256,
      },
      controller: {
        executable: basename(controllerPath),
        version: input.controllerVersion,
        bytes: controllerBytes,
      },
      browser: {
        root: selected.target.rootDirectory,
        executable: selected.target.executable,
        version: selected.lock.version,
        executableSha256: browserRuntimeMaterialSha256(browserBytes),
        tree: stagedTree,
      },
    });
    const manifestPath = join(temporary, "release.json");
    const sourceLockPath = join(temporary, "source-lock.json");
    const sourceReviewPath = join(temporary, "source-review.json");
    const buildAttestationPath = join(temporary, "build-attestation.json");
    await writeFile(sourceLockPath, JSON.stringify(selected.lock, null, 2) + "\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o644,
    });
    await writeFile(sourceReviewPath, JSON.stringify(reviewed.review, null, 2) + "\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o644,
    });
    await writeFile(buildAttestationPath, JSON.stringify(built.attestation, null, 2) + "\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o644,
    });
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o644,
    });
    await rename(temporary, destination);
    return {
      root: destination,
      controllerPath: join(destination, basename(controllerPath)),
      browserRootPath: join(destination, basename(browserRootPath)),
      browserPath: join(destination, basename(browserRootPath), selected.target.executable),
      manifestPath: join(destination, "release.json"),
      sourceLockPath: join(destination, "source-lock.json"),
      sourceReviewPath: join(destination, "source-review.json"),
      buildAttestationPath: join(destination, "build-attestation.json"),
      manifest,
    };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

function validateInput(input: AssembleBrowserRuntimeReleaseInput): void {
  if (!isAbsolute(input.destination) || !isAbsolute(input.controllerSource) || !isAbsolute(input.sourceArchivePath)) {
    throw new Error("Browser Runtime release paths must be absolute");
  }
  if (!input.controllerVersion.trim() || input.controllerVersion.length > 128) {
    throw new Error("Browser Runtime release versions are invalid");
  }
  if (!(["darwin", "linux", "win32"] as const).includes(input.platform)
    || !(["arm64", "x64"] as const).includes(input.architecture)) {
    throw new Error("Browser Runtime release host identity is invalid");
  }
}

async function assertMissing(path: string, message: string): Promise<void> {
  try {
    await access(path, constants.F_OK);
    throw new Error(message);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
