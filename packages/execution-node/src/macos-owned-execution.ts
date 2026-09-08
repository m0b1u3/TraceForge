import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";
import type { StartProcessRequest, ResourceLimitKind } from "./protocol.js";
import { compileMacosSeatbeltPolicy, type MacosSystemServicePolicy } from "./macos-seatbelt.js";
import { SampledResourceBudget } from "./sampled-resource-budget.js";
import { allowsFileSystemPath } from "@traceforge/orchestration-core";

export interface MacosOwnedExecutionResult {
  resourcePolicy: "sampled_terminate";
  cleanupConfirmed: boolean;
  reason: "exited" | "cancelled" | "deadline" | "budget" | "supervision_failed";
  resourceLimitExceeded: ResourceLimitKind | null;
  exitCode: number | null;
  signal: number | null;
  stdout: Buffer;
  stderr: Buffer;
  omittedOutputBytes: number;
}

/** Bounded stdio execution path. Not yet a ProcessLauncher: no PTY/adoption or
 * fabricated hard-limit attestation. The native parent owns the group lifetime. */
export async function runMacosOwnedExecution(request: StartProcessRequest, helper: { path: string; sha256: string },
  signal: AbortSignal, ports?: {
    ready(pid: number, input: Writable | null): void;
    output(stream: "stdout" | "stderr", bytes: Buffer): void;
    resourceLimit(resource: ResourceLimitKind): void;
  }, services?: MacosSystemServicePolicy): Promise<MacosOwnedExecutionResult> {
  signal.throwIfAborted();
  if (process.platform !== "darwin" || process.arch !== "arm64" || request.terminal || (!ports && request.stdin !== "closed")) throw new Error("macOS execution requires Apple Silicon stdio");
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 300000
    || !Number.isSafeInteger(request.outputLimitBytes) || request.outputLimitBytes < 1 || request.outputLimitBytes > 4194304) throw new Error("Invalid macOS execution bounds");
  // No loader injection into the unsandboxed supervisor itself.
  if (Object.keys(request.environment).length) throw new Error("macOS supervisor currently requires an empty environment");
  const profile = compileMacosSeatbeltPolicy(request.permissions, request.executable, request.workingDirectory, services);
  for (const trusted of [helper.path, "/usr/bin/sandbox-exec", "/System/Library/Sandbox/Profiles/dyld-support.sb"]) {
    if (allowsFileSystemPath(request.permissions, "write", trusted)) throw new Error("macOS execution must not modify its supervisor or system policy");
  }
  const metadata = await lstat(helper.path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1048576 || !(metadata.mode & 0o111)
    || await realpath(helper.path) !== helper.path || !/^[a-f0-9]{64}$/.test(helper.sha256)
    || createHash("sha256").update(await readFile(helper.path)).digest("hex") !== helper.sha256) throw new Error("macOS supervisor identity mismatch");
  const budget = new SampledResourceBudget(request.resources, 4096);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(helper.path, [profile.profile, request.executable, ...request.arguments], {
      cwd: request.workingDirectory, env: {}, stdio: [request.stdin === "closed" ? "ignore" : "pipe", "pipe", "pipe", "pipe", "pipe"],
    });
    let reason: MacosOwnedExecutionResult["reason"] = "exited", limit: ResourceLimitKind | null = null;
    let settled = false, ready = false, terminal: { exitCode: number; signal: number } | undefined;
    let buffered = "", retained = 0, omitted = 0, lastTelemetry = performance.now();
    const output: Buffer[] = [], errors: Buffer[] = [];
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (cause: MacosOwnedExecutionResult["reason"]) => {
      if (settled) return;
      if (reason === "exited") reason = cause;
      (child.stdio[4] as Writable).end();
      if (!cleanupTimer) cleanupTimer = setTimeout(() => { child.kill("SIGKILL"); finish(false); }, 4000);
    };
    const abort = () => stop("cancelled");
    const deadline = setTimeout(() => stop("deadline"), request.timeoutMs);
    const watchdog = setInterval(() => { if (!terminal && performance.now() - lastTelemetry > 1000) stop("supervision_failed"); }, 100);
    const dispose = () => { clearTimeout(deadline); clearInterval(watchdog); clearTimeout(cleanupTimer); signal.removeEventListener("abort", abort); };
    const finish = (confirmed: boolean) => {
      if (settled) return; settled = true; dispose();
      for (const stream of child.stdio) stream?.destroy();
      resolve({ resourcePolicy: "sampled_terminate", cleanupConfirmed: confirmed,
        reason: confirmed ? reason : "supervision_failed", resourceLimitExceeded: limit,
        exitCode: confirmed && terminal!.exitCode >= 0 ? terminal!.exitCode : null,
        signal: confirmed && terminal!.signal > 0 ? terminal!.signal : null,
        stdout: Buffer.concat(output), stderr: Buffer.concat(errors), omittedOutputBytes: omitted });
    };
    const capture = (list: Buffer[], bytes: Buffer) => {
      const take = Math.min(bytes.length, request.outputLimitBytes - retained);
      if (take) list.push(Buffer.from(bytes.subarray(0, take))); retained += take; omitted += bytes.length - take;
    };
    child.stdout!.on("data", bytes => { capture(output, bytes); ports?.output("stdout", bytes); });
    child.stderr!.on("data", bytes => { capture(errors, bytes); ports?.output("stderr", bytes); });
    (child.stdio[3] as Readable).on("data", bytes => {
      if (settled) return;
      buffered += bytes.toString("utf8");
      if (Buffer.byteLength(buffered) > 1048576) { stop("supervision_failed"); return; }
      for (;;) {
        const newline = buffered.indexOf("\n"); if (newline < 0) break;
        const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
        try {
          if (terminal) throw Error("Telemetry after terminal");
          const frame = JSON.parse(line);
          if (frame.type === "ready" && !ready && Number.isSafeInteger(frame.pid) && frame.pid > 1) {
            ready = true; ports?.ready(frame.pid, child.stdin);
          }
          else if (frame.type === "sample" && ready && frame.valid === true && Array.isArray(frame.processes)) {
            const decision = budget.observe(performance.now(), frame.processes);
            if (decision.exceeded) { if (!limit) ports?.resourceLimit(decision.exceeded); limit = decision.exceeded; stop("budget"); }
          } else if (frame.type === "terminal" && ready && Number.isSafeInteger(frame.exitCode) && frame.exitCode >= -1
            && frame.exitCode <= 255 && Number.isSafeInteger(frame.signal) && frame.signal >= 0 && frame.signal <= 128) {
            terminal = frame;
          } else throw Error("Invalid telemetry");
          lastTelemetry = performance.now();
        } catch { stop("supervision_failed"); }
      }
    });
    child.once("error", error => { if (!settled) { settled = true; dispose(); reject(error); } });
    for (const stream of child.stdio) stream?.on("error", () => stop("supervision_failed"));
    child.once("close", code => finish(code === 0 && !!terminal && !buffered));
    signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
  });
}
