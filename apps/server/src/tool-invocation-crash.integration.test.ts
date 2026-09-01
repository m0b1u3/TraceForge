import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const fixture = fileURLToPath(new URL("../test-fixtures/tool-invocation-crash-host.mjs", import.meta.url));
const roots: string[] = [];
const children = new Set<ChildProcess>();
afterEach(async () => {
  await Promise.all([...children].map((child) => new Promise<void>((resolve) => { child.once("close", () => resolve()); child.kill("SIGKILL"); })));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
interface Report {
  processObservations: Array<{ status: string; cleanup: string }>;
  recovery: { completed: number; uncertain: number };
  runRecovery: { issues: unknown[]; actions: Array<{ action: string }> };
  outcome: { status?: string; error?: string };
  launches: number;
  effects: number;
  binding: string;
  execution: string;
  protected: boolean;
  integrity: string;
}
function host(root: string, mode: string, phase: string): Promise<Report> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", fixture, mode, root, phase], { stdio: ["ignore", "pipe", "pipe"] });
    children.add(child);
    let stdout = "";
    let stderr = "";
    let checkpoint = false;
    let failure: Error | undefined;
    const abort = (message: string) => { failure = new Error(message); child.kill("SIGKILL"); };
    const timer = setTimeout(() => abort(`Invocation host timed out at ${mode}/${phase}`), 20000);
    child.stdout!.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.length > 64000) return abort("Invocation host output exceeded its bound");
      if (mode === "crash" && stdout.includes("\n") && !checkpoint) {
        try {
          if (JSON.parse(stdout.split("\n")[0]!).checkpoint !== phase) return abort("Unexpected invocation checkpoint");
          checkpoint = true;
          child.kill("SIGKILL");
        } catch { abort("Invalid invocation checkpoint"); }
      }
    });
    child.stderr!.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-8000); });
    child.once("error", (error) => { failure = error; });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      children.delete(child);
      if (failure) return reject(failure);
      if (mode === "crash" && (!checkpoint || signal !== "SIGKILL")) return reject(new Error(`No crash at ${phase}: ${code}/${signal}\n${stderr}`));
      if (mode !== "crash" && code !== 0) return reject(new Error(`Recovery failed at ${phase}: ${stderr}`));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`Invalid report: ${stdout}\n${stderr}`)); }
    });
  });
}

describe("Tool Invocation real-process interruption recovery", () => {
  it.each(["prepared", "claimed", "executing", "result-returned", "receipt-committed", "binding-completed"])("recovers a host killed at %s without repeating an uncertain effect", async (phase) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "traceforge-invocation-crash-")));
    roots.push(root);
    await host(root, "crash", phase);
    if (phase === "executing") {
      await expect.poll(() => existsSync(join(root, "provider-exited")), { timeout: 5000, interval: 10 }).toBe(true);
    }
    const recovered = await host(root, "recover", phase);
    const uncertain = ["claimed", "executing", "result-returned"].includes(phase);
    expect(recovered.integrity).toBe("ok");
    expect(recovered.runRecovery.issues).toEqual([]);
    expect(recovered.runRecovery.actions).toMatchObject([{ action: "requeued" }]);
    expect(recovered.execution).toBe(uncertain ? "uncertain" : "completed");
    expect(recovered.protected).toBe(uncertain);
    expect(recovered.outcome).toMatchObject(uncertain ? { error: "ToolInvocationRecoveryRequiredError" } : { status: "succeeded" });
    expect(recovered.launches).toBe(phase === "prepared" ? 1 : 0);
    expect(recovered.effects).toBe(phase === "claimed" ? 0 : 1);
    expect(recovered.processObservations).toHaveLength(phase === "claimed" ? 0 : 1);
    expect(recovered.processObservations.every((entry) => entry.cleanup === "unverified")).toBe(true);
    if (phase === "executing") expect(recovered.processObservations[0].status).toBe("claimed");
    expect(recovered.recovery.uncertain).toBe(uncertain ? 1 : 0);
    expect(recovered.recovery.completed).toBe(phase === "receipt-committed" ? 1 : 0);
    const again = await host(root, "recover", phase);
    expect(again.recovery).toEqual({ completed: 0, uncertain: 0 });
    expect(again.outcome).toEqual(recovered.outcome);
    expect(again.launches).toBe(0);
    expect(again.effects).toBe(recovered.effects);
    expect(again.processObservations).toEqual(recovered.processObservations);
    expect(again.protected).toBe(recovered.protected);
  });
});
