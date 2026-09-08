import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import type { ProcessResourceSample } from "./sampled-resource-budget.js";

export interface MacosProcessBirth { pid: number; startSeconds: string; startMicroseconds: string }
export interface MacosNativeResourceSample extends MacosProcessBirth, ProcessResourceSample { parentPid: number; groupId: number }
const execute = promisify(execFile);
const digits = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value);
function validateBirth(birth: MacosProcessBirth) {
  if (!Number.isSafeInteger(birth.pid) || birth.pid <= 1 || birth.pid > 2147483647 || !digits(birth.startSeconds)
    || !digits(birth.startMicroseconds) || BigInt(birth.startMicroseconds) >= 1000000n) throw new Error("Invalid native process identity");
}
export function parseMacosResourceSample(raw: string, expected: MacosProcessBirth): MacosNativeResourceSample {
  validateBirth(expected);
  if (Buffer.byteLength(raw) > 4096) throw new Error("Native sample exceeds capacity");
  const value = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !==
    "cpuTimeMs,format,groupId,parentPid,pid,residentBytes,startMicroseconds,startSeconds,writeBytes" || value.format !== 1) throw new Error("Invalid native sample schema");
  validateBirth(value);
  for (const key of ["parentPid", "groupId", "cpuTimeMs", "residentBytes", "writeBytes"]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) throw new Error("Invalid native sample counter");
  }
  if (value.pid !== expected.pid || ((expected.startSeconds !== "0" || expected.startMicroseconds !== "0")
    && (value.startSeconds !== expected.startSeconds || value.startMicroseconds !== expected.startMicroseconds))) throw new Error("Native process birth changed");
  const { format: _, ...sample } = value;
  return { ...sample, identity: `${value.pid}:${value.startSeconds}:${value.startMicroseconds}` };
}

/** Read-only, same-UID sampler. Possessing a birth identity is NOT execution
 * ownership. Only the owning launcher may select processes for supervision. */
export class MacosResourceSampler {
  constructor(private readonly helperPath: string, private readonly helperSha256: string) {
    if (!isAbsolute(helperPath) || !/^[a-f0-9]{64}$/.test(helperSha256)) throw new Error("Native sampler requires measured absolute helper");
  }
  async sample(birth: MacosProcessBirth, signal: AbortSignal): Promise<MacosNativeResourceSample> {
    if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Native sampler requires macOS Apple Silicon");
    signal.throwIfAborted(); validateBirth(birth);
    const stat = await lstat(this.helperPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1048576 || (stat.mode & 0o111) === 0
      || await realpath(this.helperPath) !== this.helperPath) throw new Error("Native sampler installation is invalid");
    const digest = createHash("sha256").update(await readFile(this.helperPath)).digest("hex");
    if (digest !== this.helperSha256) throw new Error("Native sampler identity changed");
    signal.throwIfAborted();
    const result = await execute(this.helperPath, [String(birth.pid), birth.startSeconds, birth.startMicroseconds],
      { signal, timeout: 1000, maxBuffer: 4096, env: {} });
    return parseMacosResourceSample(result.stdout, birth);
  }
}
