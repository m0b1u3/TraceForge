import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = []; const children = new Set<ChildProcess>();
afterEach(async () => {
  await Promise.all([...children].map((child) => new Promise<void>((resolve) => { child.once("close", () => resolve()); child.kill("SIGKILL"); })));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
function host(root: string, mode: string, phase: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../test-fixtures/execution-archive-crash-host.mjs", import.meta.url)), root, mode, phase],
      { stdio: ["ignore", "pipe", "pipe"] });
    children.add(child); let stdout = ""; let stderr = ""; let stopped = false; let failure: Error | undefined;
    const abort = (error: Error) => { failure = error; child.kill("SIGKILL"); };
    const timeout = setTimeout(() => abort(new Error("Archive fixture timed out")), 20000);
    child.stdout!.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.length > 64000) return abort(new Error("Fixture output exceeded limit"));
      if (mode === "crash" && stdout.includes("\n") && !stopped) {
        try { if (JSON.parse(stdout.split("\n")[0]!).boundary !== phase) throw new Error("Wrong archive crash boundary");
          stopped = true; child.kill("SIGKILL"); } catch (error) { abort(error as Error); }
      }
    });
    child.stderr!.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-8000); });
    child.once("error", (error) => { failure = error; });
    child.once("close", (code, signal) => {
      clearTimeout(timeout); children.delete(child);
      if (failure) return reject(failure);
      if ((mode === "crash" && (!stopped || signal !== "SIGKILL")) || (mode !== "crash" && code !== 0)) return reject(new Error(`Fixture failed: ${stderr}`));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`Invalid fixture output: ${stderr}`)); }
    });
  });
}
describe("Execution archive actual host termination", () => {
  it.each(["cold-written", "hot-replaced", "committed"])("keeps archive/source/accounting atomic after SIGKILL at %s", async (phase) => {
    const root = await mkdtemp(join(tmpdir(), "traceforge-archive-crash-")); roots.push(root); await host(root, "crash", phase);
    const first = await host(root, "recover", phase);
    expect(first).toMatchObject({ before: phase === "committed" ? { archives: 2, audits: 1 } : { archives: 0, audits: 0 },
      outcome: "archived", archives: 2, audits: 1, receiptMatches: true, checkpointMatches: true, integrity: "ok" });
    const second = await host(root, "recover", phase);
    expect(second).toMatchObject({ replayed: true, archives: 2, audits: 1, receiptMatches: true, checkpointMatches: true, integrity: "ok", usage: first.usage });
  });
});
