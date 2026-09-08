import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StartProcessRequest } from "./protocol.js";
import { runMacosOwnedExecution } from "./macos-owned-execution.js";
import { MacosProcessLauncher } from "./macos-process-launcher.js";
import { LocalExecutionNode } from "./runtime.js";
const execute = promisify(execFile);
describe.skipIf(process.env.TRACEFORGE_TEST_MACOS_SEATBELT !== "1")("macOS native owned group", () => {
  let root: string, node: string, helper: { path: string; sha256: string };
  beforeAll(async () => {
    expect(process.platform).toBe("darwin"); expect(process.arch).toBe("arm64");
    root = await realpath(await mkdtemp(join(tmpdir(), "traceforge-owned-group-"))); node = await realpath(process.execPath);
    const path = join(root, "supervisor");
    await execute("/usr/bin/clang", ["-Wall", "-Wextra", "-Werror", fileURLToPath(new URL("../native-src/macos-owned-process.c", import.meta.url)), "-o", path], { timeout: 15000 });
    helper = { path, sha256: createHash("sha256").update(await readFile(path)).digest("hex") };
  });
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });
  function request(script: string): StartProcessRequest {
    return { requestId: "fixture", attribution: { caseId: "case", runId: "run", workId: "work", workerId: "worker", scopeRef: "scope", leaseId: "lease",
      leaseExpiresAt: "2099-01-01T00:00:00.000Z", actionId: "action", idempotencyKey: "key" },
      executable: node, arguments: ["-e", script], workingDirectory: root, environment: {}, stdin: "closed", timeoutMs: 3000, outputLimitBytes: 4096,
      resources: { cpuTimeMs: 1000, memoryBytes: 128 * 1024 * 1024, maximumProcesses: 8, writeBytes: 1048576 },
      permissions: { version: 1, platform: "darwin", network: "deny", process: { access: "sandboxed", interactive: false, background: false }, secrets: "deny", sources: ["fixture"],
        filesystem: { read: [{ path: node, scope: "exact" }, { path: root, scope: "tree" }], write: [], deny: [] } } };
  }
  it("captures a normal exit only after the native group barrier", async () => {
    const result = await runMacosOwnedExecution(request("process.stdout.write('owned')"), helper, new AbortController().signal);
    expect(result).toMatchObject({ reason: "exited", cleanupConfirmed: true, exitCode: 0, resourcePolicy: "sampled_terminate" });
    expect(result.stdout.toString()).toBe("owned");
  });
  it("supports streaming input and reports only the confirmed group terminal", async () => {
    const input = request("process.stdin.on('data',b=>process.stdout.write(b));process.stdin.on('end',()=>process.exit(0))"); input.stdin = "pipe";
    const launched = await new MacosProcessLauncher(helper).launch(input);
    expect(launched.enforcement).toMatchObject({ resourceLimitsApplied: false, resourcePolicy: "sampled_terminate", processTreeEmptyBarrier: true });
    let output = "";
    launched.process.onOutput((stream, bytes) => { if (stream === "stdout") output += bytes.toString(); });
    const exited = new Promise(resolve => launched.process.onExit((code, signal) => resolve({ code, signal })));
    await launched.process.writeInput(Buffer.from("round-trip")); await launched.process.closeInput();
    expect(await exited).toEqual({ code: 0, signal: null }); expect(output).toBe("round-trip");
  });
  it("tolerates children exiting between native process enumeration and sampling", async () => {
    const input = request("const {spawn}=require('node:child_process');(async()=>{for(let i=0;i<20;i++)await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['-e',''],{stdio:'inherit',env:{}});child.on('error',reject);child.on('exit',resolve)});process.stdout.write('complete')})()");
    input.timeoutMs = 10000; input.resources.cpuTimeMs = 5000;
    expect(await runMacosOwnedExecution(input, helper, new AbortController().signal))
      .toMatchObject({ reason: "exited", cleanupConfirmed: true, exitCode: 0 });
  });
  it("managed cancellation waits for cleanup and denies PTY", async () => {
    const launched = await new MacosProcessLauncher(helper).launch(request("setInterval(()=>{},1000)"));
    let exited = false; launched.process.onExit(() => { exited = true; });
    await expect(launched.process.resizeTerminal(80, 24)).rejects.toThrow("PTY");
    await launched.process.terminate(true); expect(exited).toBe(true);
  });
  it("runs through the real Execution Node contract and terminates with a confirmed terminal", async () => {
    const node = new LocalExecutionNode(new MacosProcessLauncher(helper), {
      platform: "darwin", sandboxBackends: ["traceforge-macos-native"], sandboxMeasurements: { "traceforge-macos-native": helper.sha256 },
      acceptedSampledResourceBackends: ["traceforge-macos-native"],
      capabilities: { process: { spawn: true, stdio: true, tty: false, adoption: true, resourceLimits: false, resourcePolicy: "sampled_terminate", signals: ["terminate", "kill"] } },
    });
    try {
      const started = await node.startProcess(request("setInterval(()=>{},1000)"));
      expect(started.process.state).toBe("running");
      const terminal = await node.terminateProcess({ operationId: "terminate-fixture", processId: started.process.id, adoptionToken: started.adoptionToken, force: true });
      expect(terminal.state).toBe("exited");
    } finally { await node.shutdown(); }
  });
  it("terminates on real sampled memory excess", async () => {
    const input = request("setInterval(()=>{},1000)"); input.resources.memoryBytes = 1;
    const result = await runMacosOwnedExecution(input, helper, new AbortController().signal);
    expect(result).toMatchObject({ reason: "budget", cleanupConfirmed: true, resourceLimitExceeded: "memory" });
  });
  it("cleans a lingering descendant when its parent exits", async () => {
    const input = request("const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit',env:{}});c.on('spawn',()=>{process.stdout.write(String(c.pid));c.unref();});");
    const result = await runMacosOwnedExecution(input, helper, new AbortController().signal);
    expect(result.cleanupConfirmed).toBe(true);
    const descendant = Number(result.stdout.toString()); expect(descendant).toBeGreaterThan(1);
    // OS may retain a short-lived zombie; native confirmation is no living member.
    const status = await execute("/bin/ps", ["-p", String(descendant), "-o", "stat="]).then(result => result.stdout.trim(), () => "");
    expect(status === "" || status.startsWith("Z")).toBe(true);
  });
  it("cancels execution and preserves the distinction from normal exit", async () => {
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 150);
    try {
      expect(await runMacosOwnedExecution(request("setInterval(()=>{},1000)"), helper, abort.signal))
        .toMatchObject({ reason: "cancelled", cleanupConfirmed: true });
    } finally { clearTimeout(timer); }
  });
  it("rejects environment injection into the unsandboxed supervisor", async () => {
    const input = request(""); input.environment = { DYLD_INSERT_LIBRARIES: "/untrusted" };
    await expect(runMacosOwnedExecution(input, helper, new AbortController().signal)).rejects.toThrow("empty environment");
  });
  it("terminates real CPU excess", async () => {
    const input = request("while(true){}"); input.resources.cpuTimeMs = 30;
    expect(await runMacosOwnedExecution(input, helper, new AbortController().signal))
      .toMatchObject({ reason: "budget", cleanupConfirmed: true, resourceLimitExceeded: "cpu_time" });
  });
  it("counts descendants against the execution budget", async () => {
    const input = request("require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit',env:{}});setInterval(()=>{},1000)");
    input.resources.maximumProcesses = 1;
    expect(await runMacosOwnedExecution(input, helper, new AbortController().signal))
      .toMatchObject({ reason: "budget", cleanupConfirmed: true, resourceLimitExceeded: "process_count" });
  });
  it("bounds output and stops on wall-clock deadline", async () => {
    const input = request("process.stdout.write('x'.repeat(8192));setInterval(()=>{},1000)"); input.timeoutMs = 200;
    const result = await runMacosOwnedExecution(input, helper, new AbortController().signal);
    expect(result).toMatchObject({ reason: "deadline", cleanupConfirmed: true, omittedOutputBytes: 4096 });
    expect(result.stdout.length).toBe(4096);
  });
  it("denies attempts to kill the native supervisor", async () => {
    const result = await runMacosOwnedExecution(request("try{process.kill(process.ppid,'SIGKILL');process.stdout.write('escaped')}catch(e){process.stdout.write(e.code)}"), helper, new AbortController().signal);
    expect(result.cleanupConfirmed).toBe(true); expect(result.stdout.toString()).toBe("EPERM");
  });
});
