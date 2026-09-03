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
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../test-fixtures/work-continuation-crash-host.mjs", import.meta.url)), root, mode, phase],
      { stdio: ["ignore", "pipe", "pipe"] });
    children.add(child); let stdout = ""; let stderr = ""; let stopped = false; let failure: Error | undefined;
    const abort = (error: Error) => { failure = error; child.kill("SIGKILL"); };
    const timeout = setTimeout(() => abort(new Error("Continuation fixture timed out")), 20000);
    child.stdout!.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.length > 64000) return abort(new Error("Fixture output exceeded limit"));
      if (mode === "crash" && stdout.includes("\n") && !stopped) {
        try { if (JSON.parse(stdout.split("\n")[0]!).boundary !== phase) throw new Error("Wrong crash boundary");
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
describe("Work continuation after actual host termination", () => {
  it.each(["pending-committed", "receipt-before-checkpoint", "result-committed", "terminal-committed"])("continues after SIGKILL at %s without a second effect", async (phase) => {
    const root = await mkdtemp(join(tmpdir(), "traceforge-continuation-crash-")); roots.push(root);
    await host(root, "crash", phase);
    expect(await host(root, "recover", phase)).toMatchObject({ outcome: "completed", effects: 1, workCount: 1,
      modelCalls: phase === "terminal-committed" ? 0 : 1, integrity: "ok" });
    expect(await host(root, "recover", phase)).toMatchObject({ outcome: "completed", effects: 1, workCount: 1, modelCalls: 0, integrity: "ok" });
  });
});
