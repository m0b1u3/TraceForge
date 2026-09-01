import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

// Every run owns a fresh directory. Existing application databases are never opened or modified.
const args = process.argv.slice(2);
const options = new Map<string, string>();
for (let i = 0; i < args.length; i += 2) {
  if (!["--duration-seconds", "--interval-ms", "--max-cycles", "--output-parent"].includes(args[i]!) || !args[i + 1] || options.has(args[i]!)) throw new Error("Invalid reliability runner arguments");
  options.set(args[i]!, args[i + 1]!);
}
function numberOption(name: string, fallback: number, minimum: number, maximum: number) {
  const n = Number(options.get(name) ?? fallback);
  if (!Number.isSafeInteger(n) || n < minimum || n > maximum) throw new Error(`Invalid ${name}`); return n;
}
const durationSeconds = numberOption("--duration-seconds", 60, 1, 259200);
const intervalMs = numberOption("--interval-ms", 10000, 0, 60000);
const maximumCycles = numberOption("--max-cycles", 30000, 1, 30000);
const parent = resolve(options.get("--output-parent") ?? tmpdir()); await mkdir(parent, { recursive: true });
const root = await mkdtemp(join(parent, "traceforge-reliability-"));
const fixture = fileURLToPath(new URL("../apps/server/test-fixtures/foundation-reliability-host.mjs", import.meta.url));
let active: ChildProcess | undefined, resident: ChildProcess | undefined, interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { interrupted = true; active?.kill("SIGKILL"); resident?.kill("SIGKILL"); });
const report = { format: "traceforge.foundation-reliability.v1", root, startedAt: new Date().toISOString(), finishedAt: null as string | null,
  durationSeconds, intervalMs, maximumCycles, cycles: 0, hostRuns: 0, forcedRestarts: 0, status: "running", error: null as string | null,
  elapsedSeconds: 0, peakRssBytes: 0, peakDatabaseBytes: 0, peakWalBytes: 0, minimumAvailableBytes: Number.MAX_SAFE_INTEGER,
  samples: [] as Array<Record<string, unknown>>, resident: null as Record<string, any> | null, boundaries: ["receipt", "archive-uncommitted", "archive-committed"],
  limitations: ["Local neutral gateway workload; not a native sandbox or model/scenario certification", "Free-space pressure is injected; no host disk is filled",
    "Resident workload reuses one process but reopens SQLite between cycles; not a full production server load test", "Selected SIGKILL windows are not hardware power-loss tests"] };
async function persist() { const path = join(root, "report.json"); await writeFile(`${path}.tmp`, JSON.stringify(report, null, 2)); await rename(`${path}.tmp`, path); }
function host(cycle: number, mode: string, phase: string): Promise<Record<string, any>> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", fixture, root, String(cycle), mode, phase], { stdio: ["ignore", "pipe", "pipe"] });
    active = child; let output = "", error = "", stopped = false, failure: Error | undefined;
    const abort = (message: string) => { failure = new Error(message); child.kill("SIGKILL"); };
    const timer = setTimeout(() => abort("Workload host exceeded 30 second deadline"), 30000);
    child.stdout.on("data", (chunk) => {
      output += String(chunk); if (output.length > 65536) return abort("Workload output exceeded limit");
      if (mode === "kill" && output.includes("\n") && !stopped) {
        try { if (JSON.parse(output).boundary !== phase) return abort("Unexpected workload boundary"); stopped = true; child.kill("SIGKILL"); }
        catch { abort("Invalid workload boundary report"); }
      }
    });
    child.stderr.on("data", (chunk) => { error = (error + String(chunk)).slice(-8192); });
    child.once("error", (e) => { failure = e; });
    child.once("close", (code, signal) => {
      clearTimeout(timer); active = undefined; report.hostRuns++;
      if (failure || interrupted) return reject(failure ?? new Error("Interrupted"));
      if (mode === "kill" ? !stopped || signal !== "SIGKILL" : code !== 0) return reject(new Error(`Workload failed (${code}/${signal}): ${error}`));
      if (mode === "kill") report.forcedRestarts++;
      try { resolveResult(JSON.parse(output)); } catch { reject(new Error("Invalid workload report")); }
    });
  });
}
const start = performance.now(); await persist(); console.log(`Reliability artifacts: ${root}`);
const residentRoot = join(root, "resident"); await mkdir(residentRoot);
const residentDone = new Promise<void>((resolveResident, reject) => {
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../apps/server/test-fixtures/foundation-reliability-resident.mjs", import.meta.url)),
    residentRoot, String(durationSeconds), String(Math.max(100, intervalMs)), String(maximumCycles)], { stdio: ["ignore", "pipe", "pipe"] });
  resident = child; let pending = "", errors = "";
  const timer = setTimeout(() => child.kill("SIGKILL"), (durationSeconds + 60) * 1000);
  child.stdout.on("data", (chunk) => {
    pending += String(chunk);
    if (pending.length > 65536) { child.kill("SIGKILL"); return; }
    while (pending.includes("\n")) {
      const position = pending.indexOf("\n"), line = pending.slice(0, position); pending = pending.slice(position + 1);
      try { report.resident = JSON.parse(line); } catch { child.kill("SIGKILL"); }
    }
  });
  child.stderr.on("data", (chunk) => { errors = (errors + String(chunk)).slice(-8192); });
  child.once("error", reject);
  child.once("close", (code) => { clearTimeout(timer); resident = undefined;
    if (code !== 0 || !report.resident?.completed) reject(new Error(`Resident workload failed: ${errors}`)); else resolveResident(); });
});
let residentError: unknown;
// Observe immediately so an early resident failure is not an unhandled rejection during a crash-host run.
const residentSettled = residentDone.catch((error) => { residentError = error; active?.kill("SIGKILL"); });
try {
  while (!interrupted && report.cycles < maximumCycles && (performance.now() - start) / 1000 < durationSeconds) {
    if (residentError) throw residentError;
    const cycle = report.cycles, phase = report.boundaries[cycle % report.boundaries.length]!;
    await host(cycle, "crash", phase); await host(cycle, "kill", phase);
    await host(cycle, "resume", phase); const observed = await host(cycle, "inspect", phase);
    if (!observed.restored || observed.integrity !== "ok" || observed.physical.admission !== "available") throw new Error("Workload invariant or physical admission failed");
    const physical = observed.physical.observation;
    report.peakRssBytes = Math.max(report.peakRssBytes, observed.rssBytes);
    report.peakDatabaseBytes = Math.max(report.peakDatabaseBytes, physical.databaseBytes);
    report.peakWalBytes = Math.max(report.peakWalBytes, physical.walBytes);
    report.minimumAvailableBytes = Math.min(report.minimumAvailableBytes, physical.availableBytes);
    report.cycles++; report.elapsedSeconds = (performance.now() - start) / 1000;
    report.samples.push(observed); if (report.samples.length > 128) report.samples.shift();
    await persist(); if (cycle % 10 === 0) console.log(`Completed ${report.cycles} cycles / ${report.hostRuns} hosts / ${report.forcedRestarts} forced restarts`);
    const remainingMs = durationSeconds * 1000 - (performance.now() - start);
    if (report.cycles < maximumCycles && remainingMs > 0) await delay(Math.min(intervalMs, remainingMs));
  }
  await residentSettled; if (residentError) throw residentError;
  report.elapsedSeconds = (performance.now() - start) / 1000;
  report.status = interrupted ? "interrupted" : report.elapsedSeconds >= durationSeconds ? "passed" : "cycle_limit_reached";
  if (report.cycles < 3 && report.status === "passed") report.status = "insufficient_boundary_coverage";
} catch (error) { resident?.kill("SIGKILL"); await residentSettled;
  report.status = interrupted ? "interrupted" : "failed"; report.error = error instanceof Error ? error.message.slice(0, 8192) : "Unknown failure"; }
report.elapsedSeconds = (performance.now() - start) / 1000; report.finishedAt = new Date().toISOString(); await persist();
console.log(JSON.stringify({ status: report.status, cycles: report.cycles, hostRuns: report.hostRuns, forcedRestarts: report.forcedRestarts,
  elapsedSeconds: report.elapsedSeconds, report: join(root, "report.json"), error: report.error }));
if (!["passed", "cycle_limit_reached"].includes(report.status)) process.exitCode = 1;
