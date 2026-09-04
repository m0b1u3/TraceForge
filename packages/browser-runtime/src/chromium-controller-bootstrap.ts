import type { BrowserControllerProcessIo, BrowserControllerProcessRuntimeOptions } from "./controller-process-runtime.js";
import { BrowserControllerProcessRuntime } from "./controller-process-runtime.js";
import { ChromiumCdpAdapter, type ChromiumCdpAdapterOptions } from "./chromium-cdp-adapter.js";
import {
  ChromiumPipeTransport,
  type ChromiumPipeTransportOptions,
} from "./chromium-pipe-transport.js";
import {
  verifyInstalledBrowserRuntimeRelease,
  type BrowserRuntimeReleaseManifest,
} from "./browser-runtime-release.js";
import type { BrowserControllerIdentity } from "./index.js";
import type { BrowserRuntimeTreeMeasurement } from "./browser-runtime-tree.js";

export interface ChromiumControllerBootstrapOptions {
  io: BrowserControllerProcessIo;
  releaseManifest: unknown;
  sourceLock: unknown;
  sourceReview: unknown;
  sourceAuthority: unknown;
  buildAttestation: unknown;
  platform: BrowserRuntimeReleaseManifest["platform"];
  architecture: BrowserRuntimeReleaseManifest["architecture"];
  controllerPath: string;
  chromium: Omit<ChromiumPipeTransportOptions, "browserExecutable" | "expectedIdentity" | "digestFile"> & {
    browserExecutable: string;
    browserRootPath: string;
  };
  adapter?: Omit<ChromiumCdpAdapterOptions, "cdp" | "identity">;
  controller?: Omit<BrowserControllerProcessRuntimeOptions, "io" | "adapter">;
  digestFile?: (path: string) => Promise<string>;
  measureTree?: (path: string) => Promise<BrowserRuntimeTreeMeasurement>;
}

export interface StartedChromiumController {
  identity: BrowserControllerIdentity;
  runtime: BrowserControllerProcessRuntime;
}

export async function startChromiumController(
  options: ChromiumControllerBootstrapOptions,
): Promise<StartedChromiumController> {
  const verified = await verifyInstalledBrowserRuntimeRelease({
    manifest: options.releaseManifest,
    sourceLock: options.sourceLock,
    sourceReview: options.sourceReview,
    sourceAuthority: options.sourceAuthority,
    buildAttestation: options.buildAttestation,
    platform: options.platform,
    architecture: options.architecture,
    controllerPath: options.controllerPath,
    browserRootPath: options.chromium.browserRootPath,
    browserPath: options.chromium.browserExecutable,
    ...(options.digestFile ? { digestFile: options.digestFile } : {}),
    ...(options.measureTree ? { measureTree: options.measureTree } : {}),
  });
  const cdp = await ChromiumPipeTransport.launch({
    ...options.chromium,
    expectedIdentity: verified.identity,
    expectedExecutableSha256: verified.browserExecutableSha256,
    ...(options.digestFile ? { digestFile: options.digestFile } : {}),
  });
  const adapter = new ChromiumCdpAdapter({
    cdp,
    identity: verified.identity,
    ...(options.adapter ?? {}),
  });
  const runtime = new BrowserControllerProcessRuntime({
    io: options.io,
    adapter,
    ...(options.controller ?? {}),
  });
  try {
    await runtime.start();
    return { identity: structuredClone(verified.identity), runtime };
  } catch (error) {
    await Promise.resolve(cdp.close()).catch(() => undefined);
    throw error;
  }
}
