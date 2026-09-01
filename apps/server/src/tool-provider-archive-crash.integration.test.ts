import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const fixture = fileURLToPath(new URL("../test-fixtures/provider-archive-crash-host.mjs", import.meta.url));
const roots: string[] = [];
const children = new Set<ChildProcess>();
afterEach(async () => {
  await Promise.all([...children].map((child) => new Promise<void>((resolve) => {
    child.once("close", () => resolve());
    child.kill("SIGKILL");
  })));
  for (const root of roots.splice(0)) {
    makeWritable(root);
    rmSync(root, { recursive: true, force: true });
  }
});

interface Snapshot {
  installations: Array<{ version: string; state: string }>;
  audits: Array<{ outcome: string; uploadCleanup: string; packageCleanup: string }>;
  uploads: string[];
  staging: string[];
  packages: string[];
  events: number;
  activations: number;
  authorizations: number;
  integrity: string;
}
interface HostReport {
  before: Snapshot;
  after: Snapshot;
  recovery: { installed: number; rejected: number; orphaned: number; cleanupFailures: number };
  deleted: number;
  graceEligible: number;
  gcFailures: number;
  enableProbe: number | null;
  result?: { replayed?: boolean; state?: string; statusCode?: number };
}

function host(root: string, mode: "install" | "recover" | "replay", phase: string): Promise<HostReport | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", fixture, mode, root, phase], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    let stdout = "";
    let stderr = "";
    let killedAtCheckpoint = false;
    let failure: Error | undefined;
    const abort = (message: string) => {
      failure = new Error(message);
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => abort(`Test host timed out at ${mode}/${phase}`), 20_000);
    child.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > 64_000) return abort("Test host output exceeded its bound");
      if (mode === "install" && stdout.includes("\n") && !killedAtCheckpoint) {
        try {
          const message = JSON.parse(stdout.split("\n")[0]!);
          if (message.checkpoint !== phase) return abort("Test host reached an unexpected checkpoint");
          killedAtCheckpoint = true;
          child.kill("SIGKILL");
        } catch { abort("Test host returned an invalid checkpoint"); }
      }
    });
    child.stderr!.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8000); });
    child.once("error", (error) => { failure = error; });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      children.delete(child);
      if (failure) return reject(failure);
      if (mode === "install") {
        if (!killedAtCheckpoint || signal !== "SIGKILL") return reject(new Error(`Host did not crash at ${phase}: ${code}/${signal}\n${stderr}`));
        return resolve(null);
      }
      if (code !== 0) return reject(new Error(`Host ${mode} failed (${code}): ${stderr}`));
      try { resolve(JSON.parse(stdout) as HostReport); }
      catch { reject(new Error(`Invalid host report: ${stdout}\n${stderr}`)); }
    });
  });
}

describe("Provider archive cross-process crash recovery", () => {
  it.each([
    "upload-complete", "staging-created", "staging-registered", "package-published",
    "manifest-uncommitted", "manifest-committed", "audit-committed",
  ])("recovers a SIGKILL at %s using only disk state", async (phase) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "traceforge-archive-crash-")));
    roots.push(root);
    await host(root, "install", phase);
    const recovered = (await host(root, "recover", phase))!;
    const committed = phase === "manifest-committed" || phase === "audit-committed";
    expect(recovered.before.integrity).toBe("ok");
    expect(recovered.after.integrity).toBe("ok");
    expect(recovered.recovery.cleanupFailures).toBe(0);
    expect(recovered.gcFailures).toBe(0);
    expect(recovered.graceEligible).toBe(0);
    expect(recovered.after.uploads).toEqual([]);
    expect(recovered.after.staging).toEqual([]);
    expect(recovered.after.activations).toBe(0);
    expect(recovered.after.authorizations).toBe(0);
    expect(recovered.after.installations).toEqual(committed ? [{ version: "1.0.0", state: "installed" }] : []);
    expect(recovered.after.events).toBe(committed ? 1 : 0);
    expect(recovered.before.installations).toEqual(committed ? [{ version: "1.0.0", state: "installed" }] : []);
    expect(recovered.enableProbe).toBe(committed ? null : 404);
    if (phase === "upload-complete") {
      expect(recovered.before.uploads).toHaveLength(1);
      expect(recovered.after.audits).toEqual([]);
      expect(recovered.recovery.orphaned).toBe(1);
    } else {
      expect(recovered.before.audits).toMatchObject([{ outcome: phase === "audit-committed" ? "installed" : "receiving" }]);
      expect(recovered.after.audits).toMatchObject([{
        outcome: committed ? "installed" : "rejected", uploadCleanup: "completed",
      }]);
    }
    if (phase === "staging-created") expect(recovered.recovery.orphaned).toBe(1);
    if (phase === "staging-registered") expect(recovered.recovery.orphaned).toBe(0);
    if (phase === "package-published" || phase === "manifest-uncommitted") expect(recovered.deleted).toBe(1);
    if (committed) expect(recovered.after.packages.some((path) => path.endsWith("provider.bin"))).toBe(true);
    else expect(recovered.after.packages.some((path) => path.includes("1.0.0-"))).toBe(false);

    // A second fresh process must see the same settled state and perform no recovery mutations.
    const again = (await host(root, "recover", phase))!;
    expect(again.after).toEqual(recovered.after);
    expect(again.recovery).toEqual({ installed: 0, rejected: 0, orphaned: 0, cleanupFailures: 0 });
    expect(again.deleted).toBe(0);

    const replay = (await host(root, "replay", phase))!;
    if (committed) {
      expect(replay.result).toEqual({ replayed: true, state: "installed" });
      expect(replay.after.events).toBe(1);
      expect(replay.after.authorizations).toBe(0);
    } else if (phase === "upload-complete") {
      expect(replay.result).toEqual({ replayed: false, state: "installed" });
      expect(replay.after.events).toBe(1);
    } else {
      expect(replay.result?.statusCode).toBe(400);
      expect(replay.after.events).toBe(0);
      expect(replay.after.installations).toEqual([]);
    }
  });
});

function makeWritable(path: string): void {
  if (!existsSync(path)) return;
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) return;
  chmodSync(path, stats.isDirectory() ? 0o700 : 0o600);
  if (stats.isDirectory()) for (const name of readdirSync(path)) makeWritable(join(path, name));
}
