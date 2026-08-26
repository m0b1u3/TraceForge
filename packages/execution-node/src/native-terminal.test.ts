import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import type { EffectivePermissionProfile } from "@traceforge/orchestration-core";
import { NativeTerminalFrameDecoder, WindowsConptyProcessLauncher, encodeNativeTerminalFrame } from "./native-terminal.js";
import { permissionProfileFingerprint, resourceLimitsFingerprint, type StartProcessRequest } from "./protocol.js";

const fakeHelper = String.raw`
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
    if (type === 4) { const exited = Buffer.alloc(4); exited.writeInt32BE(body[0] ? 137 : 143); send(0x83, exited); setImmediate(() => process.exit(0)); }
  }
});
`;

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
  it("decodes fragmented and coalesced binary frames", () => {
    const first = encodeNativeTerminalFrame(0x82, Buffer.from("one"));
    const second = encodeNativeTerminalFrame(0x82, Buffer.from("two"));
    const decoder = new NativeTerminalFrameDecoder();
    expect(decoder.push(first.subarray(0, 2))).toEqual([]);
    expect(decoder.push(Buffer.concat([first.subarray(2), second])).map((frame) => frame.payload.toString())).toEqual(["one", "two"]);
  });

  it("provides interactive input, resize, output, and process-tree termination through the helper protocol", async () => {
    const launcher = new WindowsConptyProcessLauncher((launchRequest) => ({
      helperExecutable: process.execPath,
      helperArgumentsPrefix: ["--input-type=module", "-e", fakeHelper],
      helperEnvironment: process.env,
      mode: "appcontainer",
      enforcement: {
        sandboxBackend: "test-native", sandboxed: true, filesystemPolicyApplied: true,
        permissionProfileFingerprint: permissionProfileFingerprint(launchRequest.permissions),
        resourceLimitsApplied: true, resourceLimitsFingerprint: resourceLimitsFingerprint(launchRequest.resources), network: "deny",
      },
    }));
    const { process: terminal } = await launcher.launch(request());
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
});
