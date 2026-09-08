import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { MacosResourceSampler, parseMacosResourceSample } from "./macos-resource-sampler.js";
import { ResourceBudgetSupervisor } from "./resource-budget-supervisor.js";
const execute = promisify(execFile);
const birth = { pid: 123, startSeconds: "100", startMicroseconds: "2" };
const row = { format: 1, ...birth, parentPid: 1, groupId: 123, cpuTimeMs: 2, residentBytes: 1024, writeBytes: 0 };
it("binds native counters to a stable birth identity and rejects malformed data", () => {
  expect(parseMacosResourceSample(JSON.stringify(row), birth).identity).toBe("123:100:2");
  for (const invalid of [{ ...row, pid: 124 }, { ...row, startSeconds: "101" }, { ...row, writeBytes: -1 },
    { ...row, residentBytes: Number.MAX_SAFE_INTEGER + 1 }, { ...row, untrusted: true }, { ...row, startMicroseconds: "1000000" }])
    expect(() => parseMacosResourceSample(JSON.stringify(invalid), birth)).toThrow();
});
it("rejects an unmeasured or relative native helper", () => {
  expect(() => new MacosResourceSampler("relative", "a".repeat(64))).toThrow("measured");
  expect(() => new MacosResourceSampler("/fixture/helper", "invalid")).toThrow("measured");
});

it.skipIf(process.env.TRACEFORGE_TEST_MACOS_SEATBELT !== "1")("samples a real owned child and confirms exit after native memory-budget detection", async () => {
  expect(process.platform).toBe("darwin"); expect(process.arch).toBe("arm64");
  const root = await realpath(await mkdtemp(join(tmpdir(), "traceforge-native-sampler-")));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const helper = join(root, "sample");
    await execute("/usr/bin/clang", ["-Wall", "-Wextra", "-Werror", fileURLToPath(new URL("../native-src/macos-resource-sample.c", import.meta.url)), "-o", helper], { timeout: 15000 });
    const hash = createHash("sha256").update(await readFile(helper)).digest("hex");
    const sampler = new MacosResourceSampler(helper, hash);
    // This fixture intentionally has one child, not a claim of tree containment.
    child = spawn(process.execPath, ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)"], { env: {}, stdio: ["ignore", "pipe", "pipe"] });
    const owned = child;
    const exited = new Promise<void>((resolve, reject) => { owned.once("exit", () => resolve()); owned.once("error", reject); });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("fixture startup timeout")), 3000);
      owned.stdout!.once("data", () => { clearTimeout(timer); resolve(); });
      owned.once("error", error => { clearTimeout(timer); reject(error); });
    });
    const signal = new AbortController().signal;
    const first = await sampler.sample({ pid: owned.pid!, startSeconds: "0", startMicroseconds: "0" }, signal);
    expect(first.parentPid).toBe(process.pid); expect(first.residentBytes).toBeGreaterThan(0);
    await expect(sampler.sample({ ...first, startSeconds: String(BigInt(first.startSeconds) + 1n) }, signal)).rejects.toThrow();
    const supervisor = new ResourceBudgetSupervisor({ cpuTimeMs: 10000, memoryBytes: 1, maximumProcesses: 1, writeBytes: 1000000 }, {
      now: () => performance.now(), sample: async signal => [await sampler.sample(first, signal)],
      terminateAndConfirm: async () => { owned.kill("SIGKILL"); await exited; },
    });
    expect(await supervisor.run(signal)).toMatchObject({ reason: "budget", cleanupConfirmed: true, decision: { exceeded: "memory" } });
    await expect(sampler.sample(first, signal)).rejects.toThrow();
    await writeFile(helper, "changed");
    await expect(sampler.sample(first, signal)).rejects.toThrow("identity changed");
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});
