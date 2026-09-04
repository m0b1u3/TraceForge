import { readFile, stat } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";
import { isAbsolute } from "node:path";
import { startChromiumController } from "./chromium-controller-bootstrap.js";
import type { BrowserControllerProcessIo } from "./controller-process-runtime.js";

export interface BrowserControllerEntryArguments {
  releaseManifestPath: string;
  sourceLockPath: string;
  sourceReviewPath: string;
  sourceAuthorityPath: string;
  buildAttestationPath: string;
  browserRootPath: string;
  browserExecutable: string;
  workingDirectory: string;
  userDataDirectory: string;
}

export interface BrowserControllerNodeProcess {
  stdin: Readable;
  stdout: Writable;
  argv: string[];
  platform: NodeJS.Platform;
  arch: string;
  exitCode?: string | number | null;
}

export function parseBrowserControllerEntryArguments(arguments_: string[]): BrowserControllerEntryArguments {
  const values = new Map<string, string>();
  const allowed = new Set(["release-manifest", "source-lock", "source-review", "source-authority", "build-attestation", "browser-root", "browser", "working-directory", "user-data-directory"]);
  for (const argument of arguments_) {
    const match = /^--([a-z-]+)=(.+)$/.exec(argument);
    if (!match || !allowed.has(match[1]!) || values.has(match[1]!)) throw new Error("Browser Controller argument is invalid or duplicated");
    values.set(match[1]!, match[2]!);
  }
  if (values.size !== allowed.size) throw new Error("Browser Controller arguments are incomplete");
  const result = {
    releaseManifestPath: values.get("release-manifest")!,
    sourceLockPath: values.get("source-lock")!,
    sourceReviewPath: values.get("source-review")!,
    sourceAuthorityPath: values.get("source-authority")!,
    buildAttestationPath: values.get("build-attestation")!,
    browserRootPath: values.get("browser-root")!,
    browserExecutable: values.get("browser")!,
    workingDirectory: values.get("working-directory")!,
    userDataDirectory: values.get("user-data-directory")!,
  };
  if (Object.values(result).some((value) => !isAbsolute(value) || Buffer.byteLength(value) > 4096 || value.includes("\0"))) {
    throw new Error("Browser Controller paths must be bounded absolute paths");
  }
  return result;
}

export async function runChromiumControllerProcess(
  process_: BrowserControllerNodeProcess = process,
): Promise<void> {
  const input = parseBrowserControllerEntryArguments(process_.argv.slice(2));
  const controllerPath = process_.argv[1];
  if (!controllerPath || !isAbsolute(controllerPath)) throw new Error("Browser Controller executable path is invalid");
  const platform = controllerPlatform(process_.platform);
  const architecture = controllerArchitecture(process_.arch);
  const manifest = await readBoundedJson(input.releaseManifestPath, 64 * 1024, "release manifest");
  const sourceLock = await readBoundedJson(input.sourceLockPath, 256 * 1024, "source lock");
  const sourceReview = await readBoundedJson(input.sourceReviewPath, 64 * 1024, "source review");
  const sourceAuthority = await readBoundedJson(input.sourceAuthorityPath, 32 * 1024, "source authority");
  const buildAttestation = await readBoundedJson(input.buildAttestationPath, 256 * 1024, "build attestation");
  const io = new NodeBrowserControllerProcessIo(process_.stdin, process_.stdout, (code) => { process_.exitCode = code; });
  await startChromiumController({
    io,
    releaseManifest: manifest,
    sourceLock,
    sourceReview,
    sourceAuthority,
    buildAttestation,
    platform,
    architecture,
    controllerPath,
    chromium: {
      browserExecutable: input.browserExecutable,
      browserRootPath: input.browserRootPath,
      workingDirectory: input.workingDirectory,
      userDataDirectory: input.userDataDirectory,
    },
  });
}

export class NodeBrowserControllerProcessIo implements BrowserControllerProcessIo {
  private closed = false;
  private failureNotified = false;

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly setExitCode: (code: number) => void,
  ) {}

  onData(listener: (data: Buffer) => void): () => void {
    const receive = (data: Buffer | string) => listener(Buffer.isBuffer(data) ? data : Buffer.from(data));
    this.input.on("data", receive);
    return () => this.input.off("data", receive);
  }

  onFailure(listener: (error: Error) => void): () => void {
    const notify = (error: Error) => {
      if (this.closed || this.failureNotified) return;
      this.failureNotified = true;
      listener(error);
    };
    const error = (value: Error) => notify(value);
    const ended = () => notify(new Error("Browser Controller Host pipe closed"));
    this.input.on("error", error);
    this.input.on("end", ended);
    this.input.on("close", ended);
    this.output.on("error", error);
    return () => {
      this.input.off("error", error);
      this.input.off("end", ended);
      this.input.off("close", ended);
      this.output.off("error", error);
    };
  }

  write(data: Buffer): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Browser Controller Host pipe is closed"));
    return new Promise((resolve, reject) => this.output.write(data, (error) => error ? reject(error) : resolve()));
  }

  close(exitCode: number): void {
    if (this.closed) return;
    this.closed = true;
    this.setExitCode(exitCode);
    this.input.destroy();
    this.output.end();
  }
}

async function readBoundedJson(path: string, maximumBytes: number, label: string): Promise<unknown> {
  const before = await stat(path);
  if (!before.isFile() || before.size < 2 || before.size > maximumBytes) throw new Error(`Browser Runtime ${label} size is invalid`);
  const bytes = await readFile(path);
  const after = await stat(path);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs
    || bytes.length !== before.size) throw new Error(`Browser Runtime ${label} changed while being read`);
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error(`Browser Runtime ${label} is not valid strict UTF-8 JSON`); }
}

function controllerPlatform(value: NodeJS.Platform): "darwin" | "linux" | "win32" {
  if (value !== "darwin" && value !== "linux" && value !== "win32") throw new Error("Browser Controller platform is unsupported");
  return value;
}

function controllerArchitecture(value: string): "arm64" | "x64" {
  if (value !== "arm64" && value !== "x64") throw new Error("Browser Controller architecture is unsupported");
  return value;
}
