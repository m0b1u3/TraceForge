import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const runner = fileURLToPath(new URL("../../../scripts/verify-foundation-reliability.mts", import.meta.url));
function run(args: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", runner, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "", errors = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 25000);
    child.stdout.on("data", (chunk) => { output += String(chunk); if (output.length > 65536) child.kill("SIGTERM"); });
    child.stderr.on("data", (chunk) => { errors = (errors + String(chunk)).slice(-8192); });
    child.once("error", reject);
    child.once("close", (code) => { clearTimeout(timer); done({ code, output: output + errors }); });
  });
}
describe("Foundation reliability acceptance runner", () => {
  it("combines physical denial, result restoration, archive pressure, three kill windows and a resident host", async () => {
    const parent = await mkdtemp(join(tmpdir(), "traceforge-reliability-test-")); roots.push(parent);
    const response = await run(["--duration-seconds", "60", "--interval-ms", "0", "--max-cycles", "3", "--output-parent", parent]);
    expect(response.code, response.output).toBe(0);
    const summary = JSON.parse(response.output.trim().split("\n").at(-1)!);
    expect(summary).toMatchObject({ status: "cycle_limit_reached", cycles: 3, hostRuns: 12, forcedRestarts: 3, error: null });
    expect(resolve(summary.report).startsWith(resolve(parent) + "/")).toBe(true);
    const report = JSON.parse(await readFile(summary.report, "utf8"));
    expect(report.samples).toHaveLength(3);
    expect(report.resident).toMatchObject({ cycles: 3, completed: true });
    expect(report.resident.peakRssBytes).toBeLessThan(512 * 1024 * 1024);
    expect(report.samples.every((sample: { restored: boolean; integrity: string }) => sample.restored && sample.integrity === "ok")).toBe(true);
  });
  it("rejects unsafe or unbounded runner options", async () => {
    expect((await run(["--duration-seconds", "0"])).code).not.toBe(0);
    expect((await run(["--database", "/existing/application.db"])).code).not.toBe(0);
  });
});
