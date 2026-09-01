import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import type { EffectivePermissionProfile } from "@traceforge/orchestration-core";
import { NativeTerminalFrameDecoder, WindowsConptyProcessLauncher, encodeNativeTerminalFrame } from "./native-terminal.js";
import { permissionProfileFingerprint, resourceLimitsFingerprint, type StartProcessRequest } from "./protocol.js";
import type { ProcessWatchdogOptions } from "./process-watchdog.js";

const fakeHelper = String.raw`
const nonce = process.argv[process.argv.indexOf("--execution-nonce") + 1];
const started = Buffer.alloc(9); started[0] = 0x81; started.writeUInt32BE(4, 1); started.writeUInt32BE(9001, 5); process.stdout.write(started);
let buffered = Buffer.alloc(0);
const send = (type, payload = Buffer.alloc(0)) => { const frame = Buffer.alloc(payload.length + 5); frame[0] = type; frame.writeUInt32BE(payload.length, 1); payload.copy(frame, 5); process.stdout.write(frame); };
process.stdin.on("data", chunk => {
  buffered = Buffer.concat([buffered, chunk]);
  while (buffered.length >= 5) {
    const length = buffered.readUInt32BE(1); if (buffered.length < length + 5) return;
    const type = buffered[0]; const payload = buffered.subarray(5, length + 5); buffered = buffered.subarray(length + 5);
    const operationId = payload.subarray(0, 4); const body = payload.subarray(4);
    if (type === 1) send(0x82, body);
    if (type === 2) send(0x82, Buffer.from("resized:" + body.readUInt16BE(0) + "x" + body.readUInt16BE(2)));
    send(0x84, Buffer.concat([operationId, Buffer.from([0])]));
    if (type === 4) { const code = body[0] ? 137 : 143; const exited = Buffer.alloc(4); exited.writeInt32BE(code); send(0x83, Buffer.concat([exited, Buffer.from(nonce)])); setImmediate(() => process.exit(code)); }
  }
});
`;

function launcher(helper: string, options: Partial<ProcessWatchdogOptions> = {}) {
  return new WindowsConptyProcessLauncher((launchRequest) => ({
    helperExecutable: process.execPath,
    helperArgumentsPrefix: ["--input-type=module", "-e", helper],
    helperEnvironment: process.env,
    mode: "appcontainer",
    enforcement: {
      sandboxBackend: "test-native", sandboxed: true, filesystemPolicyApplied: true,
      permissionProfileFingerprint: permissionProfileFingerprint(launchRequest.permissions),
      resourceLimitsApplied: true, resourceLimitsFingerprint: resourceLimitsFingerprint(launchRequest.resources), network: "deny",
    },
  }), options);
}

// Real subprocess transport faults; deliberately not Windows sandbox/Job Object acceptance tests.
function completionHelper(action: string) {
  return String.raw`
    const nonce = process.argv[process.argv.indexOf("--execution-nonce") + 1];
    const send = (type, payload = Buffer.alloc(0)) => {
      const frame = Buffer.alloc(payload.length + 5); frame[0] = type;
      frame.writeUInt32BE(payload.length, 1); payload.copy(frame, 5); process.stdout.write(frame);
    };
    const pid = Buffer.alloc(4); pid.writeUInt32BE(9001); send(0x81, pid);
    const completion = Buffer.concat([Buffer.alloc(4), Buffer.from(nonce)]);
    setTimeout(() => { ${action} }, 20);
  `;
}

function request(): StartProcessRequest {
  const platform: EffectivePermissionProfile["platform"] = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
  return {
    requestId: "native_terminal_1",
    attribution: {
      caseId: "case_1", runId: "run_1", workId: "work_1", workerId: "worker_1", scopeRef: "scope_1",
      leaseId: "lease_1", leaseExpiresAt: "2099-01-01T00:00:00.000Z", actionId: "action_1", idempotencyKey: "effect_1",
    },
    executable: process.execPath,
    arguments: ["--version"],
    workingDirectory: dirname(process.execPath),
    environment: {},
    stdin: "pipe",
    terminal: { columns: 80, rows: 24 },
    timeoutMs: 60_000,
    outputLimitBytes: 1024,
    resources: { cpuTimeMs: 30_000, memoryBytes: 256 * 1024 * 1024, maximumProcesses: 8, writeBytes: 1024 * 1024 },
    permissions: {
      version: 1,
      platform,
      filesystem: { read: [{ path: dirname(process.execPath), scope: "tree" }], write: [], deny: [] },
      network: "deny",
      process: { access: "sandboxed", interactive: true, background: false },
      secrets: "deny",
      sources: ["test"],
    },
  };
}

describe("native terminal framing", () => {
  it("uses the persisted launch nonce in the native completion handshake", async () => {
    const helper = completionHelper("if (nonce !== '" + "a".repeat(64) + "') process.exit(125); send(0x83, completion); process.exit(0)");
    const launchRequest = request();
    const { process: terminal } = await launcher(helper).launch(launchRequest, {
      nodeId: "node", generationId: "generation", launchId: "a".repeat(64), requestId: launchRequest.requestId, requestFingerprint: "b".repeat(64),
    });
    expect(await new Promise((resolve) => terminal.onExit(resolve))).toBe(0);
  });

  it("times out a helper that never acknowledges startup", async () => {
    await expect(launcher("setInterval(() => {}, 1000)", { startupTimeoutMs: 100 }).launch(request()))
      .rejects.toThrow(/startup timed out/);
  });

  it("bounds simultaneous controls when the helper never acknowledges them", async () => {
    const { process: terminal } = await launcher(completionHelper("setInterval(() => {}, 1000)"), { operationTimeoutMs: 100 }).launch(request());
    const errors: string[] = [];
    terminal.onError((error) => errors.push(error.message));
    const exit = new Promise((resolve) => terminal.onExit(resolve));
    const result = await Promise.allSettled([terminal.writeInput(Buffer.from("input")), terminal.resizeTerminal(80, 24)]);
    expect(result.map((entry) => entry.status)).toEqual(["rejected", "rejected"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/acknowledgment.*timed out/);
    expect(await exit).toBeNull();
  });

  it("does not treat an accepted termination request as completed shutdown", async () => {
    const { process: terminal } = await launcher(fakeHelper.replace("if (type === 4)", "if (false)"), { shutdownTimeoutMs: 100 }).launch(request());
    const errors: string[] = [];
    terminal.onError((error) => errors.push(error.message));
    const exit = new Promise((resolve) => terminal.onExit(resolve));
    await terminal.terminate(true);
    expect(await exit).toBeNull();
    expect(errors[0]).toMatch(/shutdown or pipe drain timed out/);
  });

  it("times out a helper that sends completion but never closes", async () => {
    const { process: terminal } = await launcher(completionHelper("send(0x83, completion); setInterval(() => {}, 1000)"), { shutdownTimeoutMs: 100 }).launch(request());
    const errors: string[] = [];
    terminal.onError((error) => errors.push(error.message));
    expect(await new Promise((resolve) => terminal.onExit(resolve))).toBeNull();
    expect(errors[0]).toMatch(/shutdown/);
  });

  it("enforces the execution budget even without a controller termination call", async () => {
    const { process: terminal } = await launcher(completionHelper("setInterval(() => {}, 1000)")).launch({ ...request(), timeoutMs: 150 });
    const errors: string[] = [];
    terminal.onError((error) => errors.push(error.message));
    expect(await new Promise((resolve) => terminal.onExit(resolve))).toBeNull();
    expect(errors[0]).toMatch(/execution deadline/);
  });

  it("decodes fragmented and coalesced binary frames", () => {
    const first = encodeNativeTerminalFrame(0x82, Buffer.from("one"));
    const second = encodeNativeTerminalFrame(0x82, Buffer.from("two"));
    const decoder = new NativeTerminalFrameDecoder();
    expect(decoder.push(first.subarray(0, 2))).toEqual([]);
    expect(decoder.push(Buffer.concat([first.subarray(2), second])).map((frame) => frame.payload.toString())).toEqual(["one", "two"]);
    expect(() => decoder.finish()).not.toThrow();
  });

  it("rejects truncated headers and payloads at EOF", () => {
    for (const bytes of [Buffer.from([0x83, 0]), encodeNativeTerminalFrame(0x83, Buffer.alloc(68)).subarray(0, 10)]) {
      const decoder = new NativeTerminalFrameDecoder();
      decoder.push(bytes);
      expect(() => decoder.finish()).toThrow(/truncated/);
    }
  });

  it("provides interactive input, resize, output, and process-tree termination through the helper protocol", async () => {
    const { process: terminal } = await launcher(fakeHelper).launch(request());
    const output: string[] = [];
    terminal.onOutput((_stream, data) => output.push(data.toString()));
    const exited = new Promise<number | null>((resolvePromise) => terminal.onExit((code) => resolvePromise(code)));
    await terminal.writeInput(Buffer.from("hello"));
    await terminal.resizeTerminal(120, 40);
    await terminal.terminate(true);
    expect(await exited).toBe(137);
    expect(output).toEqual(["hello", "resized:120x40"]);
    expect(terminal.pid).toBe(9001);
  });

  it.each([
    ["missing completion", "process.exit(0)", /without matching cleanup/],
    ["legacy exit", "send(0x83, Buffer.alloc(4)); process.exit(0)", /completion identity/],
    ["wrong launch identity", "completion.fill(48, 4); send(0x83, completion); process.exit(0)", /completion identity/],
    ["non-ASCII identity bytes", "completion[4] |= 128; send(0x83, completion); process.exit(0)", /completion identity/],
    ["duplicate completion", "send(0x83, completion); send(0x83, completion); process.exit(0)", /after completion/],
    ["trailing partial frame", "send(0x83, completion); process.stdout.write(Buffer.from([0x82])); process.exit(0)", /truncated/],
    ["late output", "send(0x83, completion); send(0x82, Buffer.from('late')); process.exit(0)", /after completion/],
    ["helper failure after completion", "send(0x83, completion); process.exit(125)", /without matching cleanup/],
    ["explicit helper error", "send(0xff, Buffer.from('cleanup failed')); process.exit(125)", /cleanup failed/],
  ])("does not accept %s as successful cleanup completion", async (_label, action, expected) => {
    const { process: terminal } = await launcher(completionHelper(action as string)).launch(request());
    const errors: string[] = [];
    terminal.onError((error) => errors.push(error.message));
    const code = await new Promise((resolvePromise) => terminal.onExit(resolvePromise));
    expect(code).toBeNull();
    expect(errors.join(" ")).toMatch(expected as RegExp);
  });

  it("waits for helper close instead of publishing a completion frame immediately", async () => {
    const { process: terminal } = await launcher(completionHelper("send(0x83, completion); setTimeout(() => process.exit(0), 150)")).launch(request());
    const errors: string[] = [];
    terminal.onError((error) => errors.push(error.message));
    let exited = false;
    const result = new Promise((resolvePromise) => terminal.onExit((code) => { exited = true; resolvePromise(code); }));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 70));
    expect(exited).toBe(false);
    expect(await result).toBe(0);
    expect(errors).toEqual([]);
  });

  it("rejects completion before a started frame", async () => {
    const helper = completionHelper("send(0x83, completion); process.exit(0)").replace("send(0x81, pid);", "");
    await expect(launcher(helper).launch(request())).rejects.toThrow(/before process start/);
  });
});
