import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function host(root: string, mode: string, phase: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../test-fixtures/storage-maintenance-crash-host.mjs", import.meta.url)), root, mode, phase], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "", error = "", failure: Error | undefined, stopped = false;
    const abort = (message: string) => { failure = new Error(message); child.kill("SIGKILL"); };
    const timer = setTimeout(() => abort("Maintenance fixture deadline exceeded"), 20000);
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      if (output.length > 64000) return abort("Fixture output limit");
      if (mode === "crash" && output.includes("\n") && !stopped) {
        try { if (JSON.parse(output).boundary !== phase) return abort("Unexpected crash boundary"); stopped = true; child.kill("SIGKILL"); }
        catch { abort("Invalid fixture output"); }
      }
    });
    child.stderr.on("data", (chunk) => { error = (error + String(chunk)).slice(-8000); });
    child.once("error", (value) => { failure = value; });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (mode === "crash" ? !stopped || signal !== "SIGKILL" : code !== 0) return reject(new Error(error));
      try { resolve(JSON.parse(output)); } catch { reject(new Error("Invalid maintenance report")); }
    });
  });
}
describe("Legacy checkpoint retirement across actual host termination", () => {
  it.each(["import-uncommitted", "source-retired", "completed"])("retains original references after SIGKILL at %s", async (phase) => {
    const root = await mkdtemp(join(tmpdir(), "traceforge-maintenance-kill-")); roots.push(root);
    await host(root, "crash", phase);
    const first = await host(root, "resume", phase);
    expect(first).toMatchObject({ before: phase === "import-uncommitted" ? { file: true, checkpoints: 0, phase: "prepared" }
      : { file: false, checkpoints: 1, phase: phase === "completed" ? "completed" : "imported" }, phase: "completed", file: false, matches: true, integrity: "ok" });
    expect(await host(root, "resume", phase)).toMatchObject({ phase: "completed", file: false, matches: true, integrity: "ok", replayed: true, usage: first.usage });
  });
});
