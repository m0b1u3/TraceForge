import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import type { EffectivePermissionProfile } from "@traceforge/orchestration-core";
import { compileMacosSeatbeltPolicy } from "./macos-seatbelt.js";
const execute = promisify(execFile);
function permissions(root = "/fixture"): EffectivePermissionProfile {
  return { version: 1, platform: "darwin", filesystem: { read: [{ path: root, scope: "tree" }], write: [], deny: [] },
    network: "deny", process: { access: "sandboxed", interactive: false, background: false }, secrets: "deny", sources: ["test"] };
}
it("compiles default-deny grants without claiming resource enforcement or cleanup", () => {
  const p = permissions(); p.filesystem.deny.push({ path: "/fixture/private", scope: "tree" });
  const result = compileMacosSeatbeltPolicy(p, "/fixture/node", "/fixture");
  expect(result.profile).toContain("(deny default)"); expect(result.profile).toContain("(deny network*)");
  expect(result.profile).toContain('(deny file-read* file-write* file-map-executable (subpath "/fixture/private"))');
  expect(result.profile).not.toContain("allow mach-lookup");
  expect(result).toMatchObject({ resourceLimitsApplied: false, processTreeCleanupProven: false });
});
it("escapes profile syntax and rejects invalid paths, ungranted launch and expanded network", () => {
  const p = permissions('/fixture/quote"(allow default)');
  expect(compileMacosSeatbeltPolicy(p, p.filesystem.read[0].path + "/node", p.filesystem.read[0].path).profile).toContain('quote\\"(allow default)');
  expect(() => compileMacosSeatbeltPolicy({ ...permissions(), network: "direct" }, "/fixture/node", "/fixture")).toThrow("network deny");
  expect(() => compileMacosSeatbeltPolicy(permissions(), "/other/node", "/fixture")).toThrow("read grants");
  const invalid = permissions("/fixture/../other");
  expect(() => compileMacosSeatbeltPolicy(invalid, "/fixture/node", "/fixture")).toThrow();
});
it("keeps host-only system services separate and requires per-client method filtering", () => {
  const p = permissions();
  const baseline = compileMacosSeatbeltPolicy(p, "/fixture/node", "/fixture").profile;
  const grants = { iokitServiceClasses: ["NotificationService"], iokitUserClientClasses: ["NotificationClient"], machLookupServices: ["example.notification"] };
  const expanded = compileMacosSeatbeltPolicy(p, "/fixture/node", "/fixture", grants).profile;
  expect(baseline).not.toContain("NotificationClient");
  expect(expanded).toContain('(iokit-user-client-class "NotificationClient") (apply-message-filter (deny iokit-external-method) (deny iokit-async-external-method))');
  expect(expanded).toContain('(global-name "example.notification")');
  expect(expanded).toContain("(deny network*)");
  expect(expanded).toContain("SYS_setsid SYS_setpgid");
  expect(compileMacosSeatbeltPolicy(p, "/fixture/node", "/fixture").profile).toBe(baseline);
  for (const invalid of ["*", 'x") (allow default)', "x\n", "x".repeat(129)]) {
    expect(() => compileMacosSeatbeltPolicy(p, "/fixture/node", "/fixture", { ...grants, machLookupServices: [invalid] })).toThrow("system service grant");
  }
  expect(() => compileMacosSeatbeltPolicy(p, "/fixture/node", "/fixture", { ...grants, iokitServiceClasses: Array(17).fill("Service") })).toThrow("system service grant");
});

describe.skipIf(process.env.TRACEFORGE_TEST_MACOS_SEATBELT !== "1")("real macOS Apple Silicon Seatbelt", () => {
  it("characterizes rejection of nested sandbox initialization without weakening the outer policy", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "traceforge-nested-probe-")));
    try {
      const binary = join(root, "probe");
      await execute("/usr/bin/clang", ["-Wno-deprecated-declarations", fileURLToPath(new URL("./test-fixtures/macos-nested-sandbox-probe.c", import.meta.url)), "-o", binary], { timeout: 15000 });
      const baseline = JSON.parse((await execute(binary, [], { timeout: 3000 })).stdout);
      expect(baseline).toEqual({ result: 0, error: 0 });
      const policy = compileMacosSeatbeltPolicy(permissions(root), binary, root);
      const nested = JSON.parse((await execute("/usr/bin/sandbox-exec", ["-p", policy.profile, binary], { timeout: 3000 })).stdout);
      expect(nested).toEqual({ result: -1, error: 1 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("prevents descendants from detaching into another session or process group", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "traceforge-group-probe-")));
    try {
      const binary = join(root, "probe");
      await execute("/usr/bin/clang", [fileURLToPath(new URL("./test-fixtures/macos-group-probe.c", import.meta.url)), "-o", binary], { timeout: 15000 });
      const policy = compileMacosSeatbeltPolicy(permissions(root), binary, root);
      const actual = JSON.parse((await execute("/usr/bin/sandbox-exec", ["-p", policy.profile, binary], { timeout: 5000, env: {}, maxBuffer: 4096 })).stdout);
      expect(actual).toEqual({ setsid: -1, setsidError: 1, setpgid: -1, setpgidError: 1 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("characterizes RLIMIT_RSS rather than claiming it is a hard memory quota", async () => {
    expect(process.platform).toBe("darwin"); expect(process.arch).toBe("arm64");
    const root = await mkdtemp(join(tmpdir(), "traceforge-resource-probe-"));
    try {
      const binary = join(root, "probe");
      await execute("/usr/bin/clang", [fileURLToPath(new URL("./test-fixtures/macos-resource-probe.c", import.meta.url)), "-o", binary], { timeout: 15000 });
      const measured = JSON.parse((await execute(binary, [], { timeout: 5000, maxBuffer: 4096 })).stdout);
      console.info("macOS bounded RSS probe", measured);
      if (!measured.setSucceeded) expect(measured.error).toBeGreaterThan(0);
      else {
        expect(measured.declaredBytes).toBe(8 * 1024 * 1024);
        expect(measured.residentBytes).toBeGreaterThan(measured.declaredBytes);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  async function fixture(run: (f: { root: string; allowed: string; outside: string; node: string; p: EffectivePermissionProfile;
    sandbox: (script: string, args?: string[]) => Promise<string> }) => Promise<void>) {
    expect(process.platform).toBe("darwin"); expect(process.arch).toBe("arm64");
    const root = await realpath(await mkdtemp(join(tmpdir(), "traceforge-seatbelt-")));
    try {
      const allowed = join(root, "allowed"), outside = join(root, "outside.txt"), node = await realpath(process.execPath);
      await mkdir(allowed); await writeFile(outside, "fixture private content"); await writeFile(join(allowed, "read.txt"), "allowed");
      await symlink(outside, join(allowed, "escape"));
      const p = permissions(allowed); p.filesystem.read.push({ path: node, scope: "exact" });
      p.filesystem.write.push({ path: allowed, scope: "tree" });
      const sandbox = async (script: string, args: string[] = []) => {
        const policy = compileMacosSeatbeltPolicy(p, node, allowed);
        const result = await execute("/usr/bin/sandbox-exec", ["-p", policy.profile, node, "-e", script, ...args],
          { cwd: allowed, env: {}, timeout: 7000, maxBuffer: 65536 }).catch(error => {
            throw new Error(JSON.stringify({ code: error.code, signal: error.signal, stderr: error.stderr }));
          });
        return result.stdout;
      };
      await run({ root, allowed, outside, node, p, sandbox });
    } finally { await rm(root, { recursive: true, force: true }); }
  }
  it("allows authorized reads/writes and denies outside files and symlink escape", async () => fixture(async f => {
    const output = await f.sandbox(`const fs=require('node:fs'); const failures=[];
      if(fs.readFileSync('read.txt','utf8')!=='allowed') throw Error('control failed'); fs.writeFileSync('written.txt','ok');
      for(const path of process.argv.slice(1)) { try {fs.readFileSync(path);throw Error('escaped');}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e;failures.push(e.code);} }
      process.stdout.write(JSON.stringify(failures));`, [f.outside, join(f.allowed, "escape")]);
    expect(JSON.parse(output)).toHaveLength(2);
  }));
  it("blocks a live loopback listener which is reachable outside the sandbox", async () => fixture(async f => {
    const server = createServer(socket => socket.end());
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    try {
      const address = server.address(); if (!address || typeof address === "string") throw Error("No listener");
      const script = `const net=require('node:net'); const s=net.connect(${address.port},'127.0.0.1');
        s.on('connect',()=>{process.stdout.write('connected');s.end();});s.on('error',e=>process.stdout.write(e.code));`;
      expect((await execute(f.node, ["-e", script], { timeout: 5000 })).stdout).toBe("connected");
      expect(await f.sandbox(script)).toMatch(/^(EPERM|EACCES)$/);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  }));
  it("retains file restrictions in a spawned child", async () => fixture(async f => {
    const script = `const cp=require('node:child_process'); const result=cp.spawnSync(process.execPath,['-e',
      "try{require('node:fs').readFileSync(process.argv[1]);process.stdout.write('escaped')}catch(e){process.stdout.write(e.code)}",process.argv[1]],{env:{},encoding:'utf8',timeout:3000});
      if(result.error||result.status!==0)throw Error('child control failed');process.stdout.write(result.stdout);`;
    expect(await f.sandbox(script, [f.outside])).toMatch(/^(EPERM|EACCES)$/);
  }));
});
