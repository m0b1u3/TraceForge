import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const fixture = fileURLToPath(new URL("../test-fixtures/provider-activation-crash-host.mjs", import.meta.url));
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

type Action = "enable" | "upgrade" | "rollback";
interface Snapshot {
  integrity: string;
  installations: Array<{ version: string; state: string }>;
  deliveries: Array<{ command_id: string; version: string; status: string }>;
  events: Array<{ commandId: string; type: string; version: string }>;
  fences: Array<{ version: string; status: string }>;
  activeVersions: string[];
  acceptingSources: string[];
  activations: string[];
  activationFences: string[];
}
interface HostReport {
  checkpoint?: string;
  snapshot: Snapshot;
  before: Snapshot;
  recovered: Snapshot;
  after: Snapshot;
  superseded: Snapshot;
  recovery: { providers: { enabled: string[]; failed: string[] } };
  probes: Record<string, string>;
  catalogVersions: string[];
  result: { state: string };
}

function host(root: string, mode: string, action: Action, phase: string, supersession = ""): Promise<HostReport> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", fixture, mode, root, action, phase, supersession], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    let stdout = "";
    let stderr = "";
    let checkpoint: HostReport | undefined;
    let failure: Error | undefined;
    const abort = (message: string) => {
      failure = new Error(message);
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => abort(`Activation host timed out at ${mode}/${action}/${phase}`), 20_000);
    child.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > 128_000) return abort("Activation host output exceeded its bound");
      if (mode === "crash" && stdout.includes("\n") && !checkpoint) {
        try {
          const report = JSON.parse(stdout.split("\n")[0]!) as HostReport;
          if (report.checkpoint !== phase) return abort("Activation host reached an unexpected checkpoint");
          checkpoint = report;
          child.kill("SIGKILL");
        } catch { abort("Activation host returned an invalid checkpoint"); }
      }
    });
    child.stderr!.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8000); });
    child.once("error", (error) => { failure = error; });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      children.delete(child);
      if (failure) return reject(failure);
      if (mode === "crash") {
        if (!checkpoint || signal !== "SIGKILL") return reject(new Error(`Host did not crash at ${action}/${phase}: ${code}/${signal}\n${stderr}`));
        return resolve(checkpoint);
      }
      if (code !== 0) return reject(new Error(`Host ${mode}/${action} failed (${code}): ${stderr}`));
      try { resolve(JSON.parse(stdout) as HostReport); }
      catch { reject(new Error(`Invalid activation host report: ${stdout}\n${stderr}`)); }
    });
  });
}

const phases = ["target-fenced", "runtime-activated", "lifecycle-uncommitted", "lifecycle-committed", "admission-open", "delivery-completed"];
const matrix = (["enable", "upgrade", "rollback"] as const).flatMap((action) =>
  [...phases, ...(action === "enable" ? [] : ["compensation-restored"])].map((phase) => ({ action, phase })));
const delivery = (snapshot: Snapshot) => snapshot.deliveries.find((entry) => entry.command_id === "activation-command");
const lifecycle = (snapshot: Snapshot, version: string) => snapshot.installations.find((entry) => entry.version === version)?.state;
const fence = (snapshot: Snapshot, version: string) => snapshot.fences.find((entry) => entry.version === version)?.status;
function rootDirectory() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "traceforge-activation-crash-")));
  roots.push(root);
  return root;
}

describe("Provider activation cross-process crash recovery", () => {
  it.each(matrix)("recovers $action killed at $phase using the production startup chain", async ({ action, phase }) => {
    const root = rootDirectory();
    const target = action === "upgrade" ? "2.0.0" : "1.0.0";
    const previous = action === "enable" ? undefined : action === "upgrade" ? "1.0.0" : "2.0.0";
    const committed = ["lifecycle-committed", "admission-open", "delivery-completed"].includes(phase);
    const ready = committed ? target : previous;
    const crashed = await host(root, "crash", action, phase);
    expect(crashed.snapshot.activationFences.every((status) => status === "closed")).toBe(true);
    expect(fence(crashed.snapshot, target)).toBe(["admission-open", "delivery-completed"].includes(phase) ? "open" : "closed");
    if (phase === "compensation-restored") {
      expect(crashed.snapshot.activeVersions).toEqual([previous]);
      expect(lifecycle(crashed.snapshot, previous!)).toBe("enabled");
      expect(fence(crashed.snapshot, previous!)).toBe("open");
    } else if (phase !== "target-fenced") expect(crashed.snapshot.activeVersions).toEqual([target]);
    if (phase === "lifecycle-uncommitted") expect(delivery(crashed.snapshot)).toBeUndefined();
    const recovered = await host(root, "recover", action, phase);
    expect(recovered.before.integrity).toBe("ok");
    expect(recovered.after.integrity).toBe("ok");
    expect(recovered.before.activeVersions).toEqual([]);
    expect(delivery(recovered.before)?.status).toBe(committed ? phase === "delivery-completed" ? "completed" : "pending" : undefined);
    expect(recovered.before.events.filter((event) => event.commandId === "activation-command")).toHaveLength(committed ? 1 : 0);
    expect(lifecycle(recovered.before, target)).toBe(committed ? "enabled" : action === "rollback" ? "disabled" : "installed");
    if (previous && phase === "lifecycle-committed") expect(lifecycle(recovered.before, previous)).toBe("draining");
    expect(recovered.recovery.providers).toEqual({ enabled: ready ? [`neutral-provider@${ready}`] : [], failed: [] });
    expect(recovered.after.activeVersions).toEqual(ready ? [ready] : []);
    expect(recovered.after.activations).toEqual(ready ? [ready] : []);
    expect(recovered.after.activationFences).toEqual(ready ? ["closed"] : []);
    expect(recovered.after.acceptingSources).toEqual(ready ? ["managed.neutral-provider"] : []);
    expect(delivery(recovered.after)?.status).toBe(committed ? "completed" : undefined);
    expect(lifecycle(recovered.after, target)).toBe(committed ? "enabled" : action === "rollback" ? "disabled" : "installed");
    if (previous) expect(lifecycle(recovered.after, previous)).toBe(committed ? "disabled" : "enabled");
    for (const installation of recovered.after.installations) {
      expect(recovered.probes[installation.version]).toBe(installation.version === ready ? "admitted" : "closed");
    }
    if (ready) expect(recovered.catalogVersions).toEqual([ready]);
    // Catalog history may contain the uncommitted target but must never create a live source on its own.
    expect(recovered.after.installations.some((entry) => entry.state === "draining")).toBe(false);

    const again = await host(root, "recover", action, phase);
    expect(again.after).toEqual(recovered.after);
    expect(again.probes).toEqual(recovered.probes);

    // An uncommitted request may be explicitly retried; a committed one only returns current state.
    const replay = await host(root, "replay", action, phase);
    expect(replay.result).toEqual({ state: "enabled" });
    expect(replay.after.activeVersions).toEqual([target]);
    expect(delivery(replay.after)?.status).toBe("completed");
    expect(replay.after.activations).toEqual(committed ? [target] : [...(previous ? [previous] : []), target]);
    if (committed) expect(replay.after.events).toEqual(replay.recovered.events);
    expect(replay.after.events.filter((event) => event.commandId === "activation-command")).toHaveLength(1);
  });

  it.each(["disable", "quarantine", "upgrade"])("does not revive a committed activation after %s and another restart", async (supersession) => {
    const root = rootDirectory();
    await host(root, "crash", "upgrade", "lifecycle-committed", supersession);
    const superseded = await host(root, "supersede", "upgrade", "lifecycle-committed", supersession);
    const expectedState = supersession === "quarantine" ? "quarantined" : "disabled";
    expect(superseded.result).toEqual({ state: expectedState });
    expect(superseded.after).toEqual(superseded.superseded);
    expect(superseded.probes["2.0.0"]).toBe("closed");
    const replay = await host(root, "replay", "upgrade", "lifecycle-committed");
    expect(replay.result).toEqual({ state: expectedState });
    expect(replay.after).toEqual(replay.recovered);
    expect(replay.after.activeVersions).toEqual(supersession === "upgrade" ? ["3.0.0"] : []);
    expect(replay.probes["2.0.0"]).toBe("closed");
  });

  it.each(["disable", "quarantine", "upgrade"])("supersedes a still-pending delivery when killed after %s", async (supersession) => {
    const root = rootDirectory();
    const crashed = await host(root, "crash", "upgrade", "superseded-pending", supersession);
    expect(delivery(crashed.snapshot)?.status).toBe("pending");
    const expectedState = supersession === "quarantine" ? "quarantined" : "disabled";
    expect(lifecycle(crashed.snapshot, "2.0.0")).toBe(expectedState);
    const recovered = await host(root, "replay", "upgrade", "superseded-pending");
    expect(delivery(recovered.before)?.status).toBe("pending");
    expect(delivery(recovered.after)?.status).toBe("superseded");
    expect(recovered.result).toEqual({ state: expectedState });
    expect(recovered.after).toEqual(recovered.recovered);
    expect(recovered.after.activeVersions).toEqual(supersession === "upgrade" ? ["3.0.0"] : []);
    expect(recovered.probes["2.0.0"]).toBe("closed");
    const again = await host(root, "replay", "upgrade", "superseded-pending");
    expect(again.after).toEqual(recovered.after);
    expect(again.result).toEqual(recovered.result);
  });
});

function makeWritable(path: string): void {
  if (!existsSync(path)) return;
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) return;
  chmodSync(path, stats.isDirectory() ? 0o700 : 0o600);
  if (stats.isDirectory()) for (const name of readdirSync(path)) makeWritable(join(path, name));
}
