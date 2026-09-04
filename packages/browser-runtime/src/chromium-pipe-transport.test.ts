import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  ChromiumPipeTransport,
  type ChromiumPipeLaunchSpec,
  type ChromiumPipeProcess,
} from "./chromium-pipe-transport.js";
import type { BrowserControllerIdentity } from "./index.js";

const identity: BrowserControllerIdentity = {
  protocol: "traceforge.browser-controller.v1",
  controllerVersion: "1.0.0",
  controllerSha256: "a".repeat(64),
  browserVersion: "HeadlessChrome/140.0.0.0",
  browserSha256: "b".repeat(64),
};

class FakeChromiumProcess extends EventEmitter implements ChromiumPipeProcess {
  readonly controlInput = new PassThrough();
  readonly controlOutput = new PassThrough();
  readonly stderr = new PassThrough();
  readonly commands: Array<Record<string, unknown>> = [];
  readonly killSignals: Array<NodeJS.Signals | undefined> = [];
  private commandBuffer = Buffer.alloc(0);

  constructor(private readonly respond = true) {
    super();
    this.controlInput.on("data", (chunk: Buffer) => this.onCommand(chunk));
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killSignals.push(signal);
    this.emit("exit", null, signal ?? "SIGTERM");
    return true;
  }

  reply(value: unknown, fragments?: number[]): void {
    const bytes = Buffer.from(`${JSON.stringify(value)}\0`);
    if (!fragments?.length) return void this.controlOutput.write(bytes);
    let offset = 0;
    for (const size of fragments) {
      this.controlOutput.write(bytes.subarray(offset, offset + size));
      offset += size;
    }
    if (offset < bytes.length) this.controlOutput.write(bytes.subarray(offset));
  }

  private onCommand(chunk: Buffer): void {
    this.commandBuffer = Buffer.concat([this.commandBuffer, chunk]);
    while (true) {
      const delimiter = this.commandBuffer.indexOf(0);
      if (delimiter < 0) return;
      const command = JSON.parse(this.commandBuffer.subarray(0, delimiter).toString("utf8")) as Record<string, unknown>;
      this.commandBuffer = this.commandBuffer.subarray(delimiter + 1);
      this.commands.push(command);
      if (!this.respond) continue;
      const result = command.method === "Browser.getVersion" ? { product: identity.browserVersion } : { accepted: true };
      queueMicrotask(() => this.reply({ id: command.id, result }));
    }
  }
}

function launchHarness(process = new FakeChromiumProcess(), overrides: Record<string, unknown> = {}) {
  let spec: ChromiumPipeLaunchSpec | undefined;
  const launched = ChromiumPipeTransport.launch({
    browserExecutable: "/opt/traceforge/chromium/chrome",
    workingDirectory: "/var/lib/traceforge/browser",
    userDataDirectory: "/var/lib/traceforge/browser/profile/run-1",
    expectedIdentity: identity,
    digestFile: async () => identity.browserSha256,
    launcher: (value) => {
      spec = value;
      queueMicrotask(() => process.emit("spawn"));
      return process;
    },
    startupTimeoutMs: 50,
    commandTimeoutMs: 50,
    shutdownTimeoutMs: 5,
    ...overrides,
  });
  return { launched, process, getSpec: () => spec };
}

describe("ChromiumPipeTransport", () => {
  it("verifies the browser material before launch and fixes the pipe security arguments", async () => {
    const launcher = vi.fn<(spec: ChromiumPipeLaunchSpec) => ChromiumPipeProcess>();
    await expect(ChromiumPipeTransport.launch({
      browserExecutable: "/opt/traceforge/chromium/chrome",
      workingDirectory: "/var/lib/traceforge/browser",
      userDataDirectory: "/var/lib/traceforge/browser/profile/run-1",
      expectedIdentity: identity,
      digestFile: async () => "unreviewed-digest",
      launcher,
    })).rejects.toThrow("digest does not match");
    expect(launcher).not.toHaveBeenCalled();

    const harness = launchHarness(new FakeChromiumProcess(), {
      browserArguments: ["--window-size=1280,720"],
      environment: { TZ: "UTC" },
    });
    const transport = await harness.launched;
    expect(harness.getSpec()).toEqual({
      executable: "/opt/traceforge/chromium/chrome",
      arguments: expect.arrayContaining([
        "--headless=new",
        "--remote-debugging-pipe",
        "--disable-features=ServiceWorker",
        "--user-data-dir=/var/lib/traceforge/browser/profile/run-1",
        "--window-size=1280,720",
      ]),
      workingDirectory: "/var/lib/traceforge/browser",
      environment: { LANG: "C.UTF-8", TZ: "UTC" },
    });
    await transport.close();
  });

  it("exchanges fragmented NUL-delimited responses and events over FD-style streams", async () => {
    const harness = launchHarness();
    const transport = await harness.launched;
    const events: unknown[] = [];
    transport.onEvent((event) => events.push(event));
    harness.process.reply({ method: "Runtime.consoleAPICalled", params: { type: "log" }, sessionId: "page-1" }, [1, 2, 4]);
    await expect(transport.send("Runtime.enable", {}, "page-1")).resolves.toEqual({ accepted: true });
    expect(events).toEqual([{ method: "Runtime.consoleAPICalled", params: { type: "log" }, sessionId: "page-1" }]);
    expect(harness.process.commands.at(-1)).toMatchObject({ method: "Runtime.enable", sessionId: "page-1" });
    await transport.close();
  });

  it("fails closed on protocol corruption without exposing Chromium stderr", async () => {
    const harness = launchHarness();
    const transport = await harness.launched;
    const failures: Error[] = [];
    transport.onFailure((error) => failures.push(error));
    harness.process.stderr.write("secret-token-from-browser");
    harness.process.controlOutput.write(Buffer.from("not-json\0"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(failures[0]?.message).toBe("Chromium CDP returned invalid JSON");
    expect(failures[0]?.message).not.toContain("secret-token");
    expect(harness.process.killSignals).toEqual(["SIGKILL"]);
    await expect(transport.send("Runtime.enable")).rejects.toThrow("unavailable");
    await transport.close();
  });

  it("rejects bypass arguments and inherited proxy-like environment before launch", async () => {
    const cases: Array<{ browserArguments?: string[]; environment?: Record<string, string> }> = [
      { browserArguments: ["--no-sandbox"] },
      { browserArguments: ["--proxy-server=http://127.0.0.1:8080"] },
      { browserArguments: ["--enable-features=ServiceWorker"] },
      { environment: { HTTPS_PROXY: "http://127.0.0.1:8080" } },
      { environment: { HOME: "/tmp/unreviewed-home" } },
    ];
    for (const options of cases) {
      const launcher = vi.fn<(spec: ChromiumPipeLaunchSpec) => ChromiumPipeProcess>();
      await expect(ChromiumPipeTransport.launch({
        browserExecutable: "/opt/traceforge/chromium/chrome",
        workingDirectory: "/var/lib/traceforge/browser",
        userDataDirectory: "/var/lib/traceforge/browser/profile/run-1",
        expectedIdentity: identity,
        digestFile: async () => identity.browserSha256,
        launcher,
        ...options,
      })).rejects.toThrow();
      expect(launcher).not.toHaveBeenCalled();
    }
  });

  it("bounds startup and shutdown and force-kills an unresponsive browser", async () => {
    const neverSpawned = new FakeChromiumProcess(false);
    await expect(ChromiumPipeTransport.launch({
      browserExecutable: "/opt/traceforge/chromium/chrome",
      workingDirectory: "/var/lib/traceforge/browser",
      userDataDirectory: "/var/lib/traceforge/browser/profile/run-1",
      expectedIdentity: identity,
      digestFile: async () => identity.browserSha256,
      launcher: () => neverSpawned,
      startupTimeoutMs: 5,
    })).rejects.toThrow("startup timed out");
    expect(neverSpawned.killSignals).toEqual(["SIGKILL"]);

    const harness = launchHarness();
    const transport = await harness.launched;
    await transport.close();
    expect(harness.process.killSignals).toEqual(["SIGKILL"]);
  });
});
