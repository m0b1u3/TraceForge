import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.platform !== "linux" || process.arch !== "x64") {
  throw new Error("Native Linux sandbox acceptance requires an x64 Linux host.");
}

const helper = realpathSync(
  process.env.TRACEFORGE_LINUX_SANDBOX_HELPER ??
    "packages/linux-sandbox-helper/target/release/traceforge-linux-sandbox",
);
const cgroupRoot = realpathSync(process.env.TRACEFORGE_LINUX_CGROUP_ROOT ?? "");
const scratchRoot = realpathSync(process.env.TRACEFORGE_LINUX_SCRATCH_ROOT ?? "");
const fixtureRoot = mkdtempSync(join(tmpdir(), "traceforge-linux-acceptance-"));
const inputRoot = join(fixtureRoot, "input");
const outputRoot = join(fixtureRoot, "output");
mkdirSync(inputRoot, { mode: 0o700 });
mkdirSync(outputRoot, { mode: 0o700 });
chmodSync(fixtureRoot, 0o700);
writeFileSync(join(inputRoot, "allowed.txt"), "allowed\n", { mode: 0o600 });
writeFileSync(join(inputRoot, "denied.txt"), "denied\n", { mode: 0o600 });

const executable = (name) => realpathSync(`/usr/bin/${name}`);
const runtimeReads = [realpathSync("/usr")];
for (const candidate of ["/etc/ld.so.cache", "/etc/localtime"]) {
  if (existsSync(candidate)) runtimeReads.push(realpathSync(candidate));
}

function encodedEnvironment(values = {}) {
  const env = { TRACEFORGE_ACCEPTANCE_HOST_ONLY: "must-not-leak" };
  for (const [key, value] of Object.entries(values)) {
    env[`TRACEFORGE_TARGET_ENV_${Buffer.from(key).toString("hex")}`] = Buffer.from(value).toString("hex");
  }
  return env;
}

let sequence = 0;
function invoke({
  name,
  command,
  read = [],
  write = [],
  deny = [],
  cpu = 2_000,
  memory = 128 * 1024 * 1024,
  processes = 16,
  writeBytes = 16 * 1024 * 1024,
  environment = {},
  networkMode = "deny",
}) {
  sequence += 1;
  const status = join(fixtureRoot, `status-${sequence}`);
  const args = [
    "run",
    "--network", networkMode,
    "--cwd", "/",
    "--status-file", status,
    "--cgroup-root", cgroupRoot,
    "--scratch-root", scratchRoot,
    "--cpu-time-ms", String(cpu),
    "--memory-bytes", String(memory),
    "--max-processes", String(processes),
    "--write-bytes", String(writeBytes),
  ];
  for (const path of [...runtimeReads, ...read]) args.push("--read-tree", path);
  for (const path of write) args.push("--write-tree", path);
  for (const path of deny) args.push("--deny-exact", path);
  args.push("--", ...command);
  const started = Date.now();
  const result = spawnSync(helper, args, {
    encoding: "utf8",
    env: encodedEnvironment(environment),
    timeout: 15_000,
  });
  if (result.error) throw new Error(`${name}: ${result.error.message}`);
  return {
    name,
    code: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    reason: existsSync(status) ? readFileSync(status, "utf8") : "",
    elapsedMs: Date.now() - started,
  };
}

function requireCase(result, predicate, expectation) {
  if (!predicate(result)) {
    throw new Error(
      `${result.name}: expected ${expectation}; got ${JSON.stringify(result)}`,
    );
  }
  console.log(JSON.stringify({
    case: result.name,
    code: result.code,
    reason: result.reason || null,
    elapsedMs: result.elapsedMs,
  }));
}

const FRAME_INPUT = 0x01, FRAME_RESIZE = 0x02, FRAME_CLOSE_INPUT = 0x03, FRAME_TERMINATE = 0x04;
const FRAME_STARTED = 0x81, FRAME_OUTPUT = 0x82, FRAME_EXITED = 0x83, FRAME_ACK = 0x84;
function frame(type, payload = Buffer.alloc(0)) {
  const value = Buffer.alloc(5 + payload.length); value[0] = type; value.writeUInt32BE(payload.length, 1); payload.copy(value, 5); return value;
}
function nativeTerminal(name, command, environment = {}) {
  sequence += 1;
  const nonce = sequence.toString(16).padStart(64, "0"), status = join(fixtureRoot, `terminal-status-${sequence}`);
  const child = spawn(helper, [
    "pty-run", "--execution-nonce", nonce, "--network", "deny", "--cwd", "/", "--columns", "80", "--rows", "24",
    "--status-file", status, "--cgroup-root", cgroupRoot, "--scratch-root", scratchRoot,
    "--cpu-time-ms", "5000", "--memory-bytes", String(128 * 1024 * 1024), "--max-processes", "8",
    "--write-bytes", String(1024 * 1024), "--read-tree", realpathSync("/usr"), "--", ...command,
  ], { env: encodedEnvironment(environment), stdio: ["pipe", "pipe", "pipe"] });
  let buffered = Buffer.alloc(0), stderr = "", output = "", closed = null;
  const messages = [], waiters = new Set();
  const publish = (message) => {
    if (message.type === FRAME_OUTPUT) output += message.payload.toString("utf8");
    messages.push(message); for (const wake of waiters) wake(); waiters.clear();
  };
  child.stderr.setEncoding("utf8"); child.stderr.on("data", value => { stderr = `${stderr}${value}`.slice(-16384); });
  child.stdout.on("data", chunk => {
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : Buffer.from(chunk);
    while (buffered.length >= 5) {
      const length = buffered.readUInt32BE(1);
      if (length > 1024 * 1024) throw new Error(`${name}: oversized terminal frame`);
      if (buffered.length < length + 5) break;
      publish({ type: buffered[0], payload: Buffer.from(buffered.subarray(5, length + 5)) });
      buffered = buffered.subarray(length + 5);
    }
  });
  child.once("close", (code, signal) => { closed = { code, signal }; for (const wake of waiters) wake(); waiters.clear(); });
  const wait = async (predicate, expectation) => {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const index = messages.findIndex(predicate);
      if (index >= 0) return messages.splice(index, 1)[0];
      if (closed) throw new Error(`${name}: closed before ${expectation}: ${JSON.stringify({ closed, stderr, output })}`);
      if (Date.now() >= deadline) throw new Error(`${name}: timed out waiting for ${expectation}: ${JSON.stringify({ stderr, output })}`);
      await new Promise(resolve => { const timer = setTimeout(() => { waiters.delete(wake); resolve(); }, 50);
        const wake = () => { clearTimeout(timer); resolve(); }; waiters.add(wake); });
    }
  };
  let operation = 0;
  const control = async (type, body = Buffer.alloc(0)) => {
    operation += 1; const id = Buffer.alloc(4); id.writeUInt32BE(operation);
    child.stdin.write(frame(type, Buffer.concat([id, body])));
    const ack = await wait(message => message.type === FRAME_ACK && message.payload.readUInt32BE(0) === operation, `operation ${operation} acknowledgment`);
    if (ack.payload[4] !== 0) throw new Error(`${name}: control rejected: ${ack.payload.subarray(5).toString("utf8")}`);
  };
  return { child, nonce, wait, control, output: () => output, closed: () => closed };
}

async function eventually(read, predicate, message) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const value = read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

try {
  const probe = spawnSync(helper, [
    "probe", "--cgroup-root", cgroupRoot, "--scratch-root", scratchRoot,
  ], { encoding: "utf8", timeout: 15_000, env: {} });
  if (probe.error || probe.status !== 0) {
    throw new Error(`probe failed: ${probe.error?.message ?? probe.stderr}`);
  }
  const proof = JSON.parse(probe.stdout);
  if (!proof.filesystemPolicy || !proof.seccomp || !proof.cgroupKill) {
    throw new Error("probe omitted required native isolation proofs");
  }
  console.log(JSON.stringify({ case: "probe", code: 0 }));

  const interactive = nativeTerminal("terminal-input-resize-terminate", [executable("bash"), "-c",
    "read -r value; printf 'terminal:%s:%s\\n' \"$value\" \"$(/usr/bin/stty size)\"; /usr/bin/sleep 30"]);
  const started = await interactive.wait(message => message.type === FRAME_STARTED && message.payload.length === 4, "terminal start");
  if (started.payload.readUInt32BE(0) < 1) throw new Error("terminal-input-resize-terminate: invalid target pid");
  const size = Buffer.alloc(4); size.writeUInt16BE(120, 0); size.writeUInt16BE(40, 2);
  await interactive.control(FRAME_RESIZE, size);
  await interactive.control(FRAME_INPUT, Buffer.from("accepted\n"));
  await eventually(interactive.output, value => value.includes("terminal:accepted:40 120"), "terminal input/resize output missing");
  await interactive.control(FRAME_TERMINATE, Buffer.from([1]));
  const terminalExit = await interactive.wait(message => message.type === FRAME_EXITED, "terminal cleanup completion");
  if (terminalExit.payload.length !== 68 || terminalExit.payload.subarray(4).toString("ascii") !== interactive.nonce) {
    throw new Error("terminal-input-resize-terminate: completion identity mismatch");
  }
  await eventually(interactive.closed, Boolean, "terminal helper did not close after cleanup completion");
  console.log(JSON.stringify({ case: "terminal-input-resize-terminate", code: 0 }));

  const interrupted = nativeTerminal("terminal-interrupt", [executable("bash"), "-c",
    "trap 'printf interrupted; exit 0' INT; while :; do /usr/bin/sleep 1; done"]);
  await interrupted.wait(message => message.type === FRAME_STARTED, "terminal interrupt start");
  await interrupted.control(FRAME_INPUT, Buffer.from([0x03]));
  await eventually(interrupted.output, value => value.includes("interrupted"), "terminal Ctrl-C did not reach the foreground process");
  const interruptedExit = await interrupted.wait(message => message.type === FRAME_EXITED, "terminal interrupt completion");
  if (interruptedExit.payload.readInt32BE(0) !== 0) throw new Error("terminal-interrupt: target did not exit cleanly");
  await eventually(interrupted.closed, Boolean, "terminal interrupt helper did not close");
  console.log(JSON.stringify({ case: "terminal-interrupt", code: 0 }));

  const closedInput = nativeTerminal("terminal-close-input", [executable("bash"), "-c",
    "if read -r value; then exit 9; else printf eof; fi"]);
  await closedInput.wait(message => message.type === FRAME_STARTED, "terminal EOF start");
  await closedInput.control(FRAME_CLOSE_INPUT);
  await eventually(closedInput.output, value => value.includes("eof"), "terminal EOF was not delivered");
  const closedInputExit = await closedInput.wait(message => message.type === FRAME_EXITED, "terminal EOF completion");
  if (closedInputExit.payload.readInt32BE(0) !== 0) throw new Error("terminal-close-input: target did not exit cleanly");
  await eventually(closedInput.closed, Boolean, "terminal EOF helper did not close");
  console.log(JSON.stringify({ case: "terminal-close-input", code: 0 }));

  const filesystem = invoke({
    name: "filesystem-environment",
    command: [executable("bash"), "-c", [
      "set -eu",
      '[ "$VISIBLE" = allowed ]',
      '[ -z "${TRACEFORGE_ACCEPTANCE_HOST_ONLY+x}" ]',
      `[ "$(/usr/bin/cat ${join(inputRoot, "allowed.txt")})" = allowed ]`,
      `[ ! -s ${join(inputRoot, "denied.txt")} ]`,
      `printf written > ${join(outputRoot, "result.txt")}`,
    ].join("; ")],
    read: [inputRoot],
    write: [outputRoot],
    deny: [join(inputRoot, "denied.txt")],
    environment: { VISIBLE: "allowed" },
  });
  requireCase(
    filesystem,
    (result) => result.code === 0 && readFileSync(join(outputRoot, "result.txt"), "utf8") === "written",
    "approved read/write, masked deny, and target-only environment",
  );

  symlinkSync("/usr/bin", join(outputRoot, "escape"));
  const symlinkEscape = invoke({
    name: "symlink-write-escape-deny",
    command: [executable("bash"), "-c", `printf exploit > ${join(outputRoot, "escape", "traceforge-escape")} 2>/dev/null && exit 1; exit 0`],
    write: [outputRoot],
  });
  requireCase(
    symlinkEscape,
    (result) => result.code === 0 && !existsSync("/usr/bin/traceforge-escape"),
    "absolute symlink cannot turn a writable grant into a host write",
  );

  writeFileSync(join(outputRoot, "overlap-denied.txt"), "hidden\n", { mode: 0o600 });
  const overlapping = invoke({
    name: "overlapping-read-write-deny",
    command: [executable("bash"), "-c", [
      `printf kept > ${join(outputRoot, "overlap-ok.txt")}`,
      `[ ! -s ${join(outputRoot, "overlap-denied.txt")} ]`,
    ].join("; ")],
    read: [outputRoot],
    write: [outputRoot],
    deny: [join(outputRoot, "overlap-denied.txt")],
  });
  requireCase(
    overlapping,
    (result) => result.code === 0 && readFileSync(join(outputRoot, "overlap-ok.txt"), "utf8") === "kept",
    "write grant remains usable while a nested deny stays masked",
  );

  const inputAlias = join(fixtureRoot, "input-alias");
  symlinkSync(inputRoot, inputAlias);
  const nonCanonicalGrant = invoke({
    name: "non-canonical-grant-fail-closed",
    command: [executable("true")],
    read: [inputAlias],
  });
  requireCase(
    nonCanonicalGrant,
    (result) => result.code === 125 && result.stderr.includes("not canonical"),
    "symlinked policy roots rejected before target execution",
  );

  const network = invoke({
    name: "network-deny",
    command: [executable("python3"), "-c", [
      "import socket,sys",
      "s=socket.socket()",
      "s.settimeout(.25)",
      "sys.exit(0 if s.connect_ex(('1.1.1.1',53)) != 0 else 1)",
    ].join(";")],
  });
  requireCase(network, (result) => result.code === 0, "no external network route");

  const seccomp = invoke({
    name: "seccomp-remount-deny",
    command: [executable("bash"), "-c", "/usr/bin/unshare --mount /usr/bin/true >/dev/null 2>&1 && exit 1; exit 0"],
  });
  requireCase(seccomp, (result) => result.code === 0, "namespace escape syscall denied");

  const orphan = invoke({
    name: "orphan-process-tree-cleanup",
    command: [executable("bash"), "-c", "(/usr/bin/sleep 30) & exit 0"],
  });
  requireCase(orphan, (result) => result.code === 0 && result.elapsedMs < 3_000, "fast whole-tree cleanup");

  const cpu = invoke({
    name: "cpu-limit",
    command: [executable("bash"), "-c", "while :; do :; done"],
    cpu: 100,
  });
  requireCase(cpu, (result) => result.code !== 0 && result.reason === "cpu_time", "CPU limit termination");

  const memory = invoke({
    name: "memory-limit",
    command: [executable("python3"), "-c", "x=bytearray(256*1024*1024); x[::4096]=b'x'*(len(x)//4096)"],
    memory: 48 * 1024 * 1024,
  });
  requireCase(memory, (result) => result.code !== 0 && result.reason === "memory", "memory limit termination");

  const processCount = invoke({
    name: "process-count-limit",
    command: [executable("bash"), "-c", "for i in {1..32}; do /usr/bin/sleep 30 & done; wait"],
    processes: 4,
  });
  requireCase(
    processCount,
    (result) => result.code !== 0 && result.reason === "process_count",
    "process-count limit termination",
  );

  const writes = invoke({
    name: "write-limit",
    command: [executable("python3"), "-c", [
      "import os",
      `f=open(${JSON.stringify(join(outputRoot, "large.bin"))},'wb')`,
      "f.write(b'x'*(8*1024*1024))",
      "f.flush()",
      "os.fsync(f.fileno())",
      "f.close()",
      "import time",
      "time.sleep(30)",
    ].join(";")],
    write: [outputRoot],
    writeBytes: 128 * 1024,
  });
  requireCase(writes, (result) => result.code !== 0 && result.reason === "write_bytes", "write limit termination");

  const unsupportedNetwork = invoke({
    name: "unsupported-network-fail-closed",
    command: [executable("true")],
    networkMode: "direct",
  });
  requireCase(
    unsupportedNetwork,
    (result) => result.code === 125 && result.stderr.includes("only deny networking"),
    "unsupported network mode rejected before execution",
  );

  const unsupportedCgroup = spawnSync(helper, [
    "probe", "--cgroup-root", fixtureRoot, "--scratch-root", scratchRoot,
  ], { encoding: "utf8", timeout: 15_000, env: {} });
  requireCase({
    name: "unsupported-cgroup-fail-closed",
    code: unsupportedCgroup.status,
    signal: unsupportedCgroup.signal,
    stdout: unsupportedCgroup.stdout,
    stderr: unsupportedCgroup.stderr,
    reason: "",
    elapsedMs: 0,
  }, (result) => result.code === 125 && result.stderr.includes("not a delegated cgroup v2"),
  "non-cgroup runtime root rejected");

  const killStatus = join(fixtureRoot, "helper-kill-status");
  const helperProcess = spawn(helper, [
    "run", "--network", "deny", "--cwd", "/",
    "--status-file", killStatus,
    "--cgroup-root", cgroupRoot,
    "--scratch-root", scratchRoot,
    "--cpu-time-ms", "30000",
    "--memory-bytes", String(128 * 1024 * 1024),
    "--max-processes", "8",
    "--write-bytes", String(1024 * 1024),
    "--read-tree", realpathSync("/usr"),
    "--", executable("sleep"), "30",
  ], { env: {}, stdio: "ignore" });
  const ownedCgroup = await eventually(
    () => readdirSync(cgroupRoot).find((name) => name.startsWith(`traceforge-execution-${helperProcess.pid}-`)),
    Boolean,
    "helper-kill: owned cgroup did not appear",
  );
  helperProcess.kill("SIGKILL");
  await new Promise((resolve) => helperProcess.once("exit", resolve));
  await eventually(
    () => readFileSync(join(cgroupRoot, ownedCgroup, "pids.current"), "utf8").trim(),
    (value) => value === "0",
    "helper-kill: target process tree survived helper death",
  );
  const recovery = spawnSync(helper, [
    "recover", "--cgroup-root", cgroupRoot, "--scratch-root", scratchRoot,
  ], { encoding: "utf8", timeout: 15_000, env: {} });
  if (recovery.error || recovery.status !== 0) {
    throw new Error(`helper-kill recovery failed: ${recovery.error?.message ?? recovery.stderr}`);
  }
  const recoveryReport = JSON.parse(recovery.stdout);
  if (recoveryReport.recoveredCgroups < 1 || recoveryReport.recoveredScratchTrees < 1) {
    throw new Error(`helper-kill recovery omitted owned residue: ${recovery.stdout}`);
  }
  console.log(JSON.stringify({
    case: "helper-kill-and-startup-recovery",
    code: 0,
    recoveredCgroups: recoveryReport.recoveredCgroups,
    recoveredScratchTrees: recoveryReport.recoveredScratchTrees,
  }));

  const beforeHostKill = new Set(readdirSync(cgroupRoot));
  const hostKillStatus = join(fixtureRoot, "host-kill-status");
  const hostKillArgs = [
    "run", "--network", "deny", "--cwd", "/",
    "--status-file", hostKillStatus,
    "--cgroup-root", cgroupRoot,
    "--scratch-root", scratchRoot,
    "--cpu-time-ms", "30000",
    "--memory-bytes", String(128 * 1024 * 1024),
    "--max-processes", "8",
    "--write-bytes", String(1024 * 1024),
    "--read-tree", realpathSync("/usr"),
    "--", executable("sleep"), "30",
  ];
  const launcher = spawn(process.execPath, [
    "-e",
    "const{spawn}=require('node:child_process');spawn(process.argv[1],JSON.parse(process.argv[2]),{env:{},stdio:'ignore'});setInterval(()=>{},1000)",
    helper,
    JSON.stringify(hostKillArgs),
  ], { stdio: "ignore" });
  const hostOwnedCgroup = await eventually(
    () => readdirSync(cgroupRoot).find((name) => name.startsWith("traceforge-execution-") && !beforeHostKill.has(name)),
    Boolean,
    "execution-host-kill: owned cgroup did not appear",
  );
  const helperPid = Number(hostOwnedCgroup.split("-")[2]);
  launcher.kill("SIGKILL");
  await new Promise((resolve) => launcher.once("exit", resolve));
  await eventually(
    () => {
      try { process.kill(helperPid, 0); return false; } catch { return true; }
    },
    Boolean,
    "execution-host-kill: helper survived its parent host",
  );
  await eventually(
    () => readFileSync(join(cgroupRoot, hostOwnedCgroup, "pids.current"), "utf8").trim(),
    (value) => value === "0",
    "execution-host-kill: target tree survived host and helper death",
  );
  const hostRecovery = spawnSync(helper, [
    "recover", "--cgroup-root", cgroupRoot, "--scratch-root", scratchRoot,
  ], { encoding: "utf8", timeout: 15_000, env: {} });
  if (hostRecovery.error || hostRecovery.status !== 0) {
    throw new Error(`execution-host-kill recovery failed: ${hostRecovery.error?.message ?? hostRecovery.stderr}`);
  }
  const hostRecoveryReport = JSON.parse(hostRecovery.stdout);
  if (hostRecoveryReport.recoveredCgroups !== 1 || hostRecoveryReport.recoveredScratchTrees !== 1) {
    throw new Error(`execution-host-kill recovery was not exact: ${hostRecovery.stdout}`);
  }
  console.log(JSON.stringify({
    case: "execution-host-kill-chain-and-restart-recovery",
    code: 0,
    recoveredCgroups: 1,
    recoveredScratchTrees: 1,
  }));

  console.log(JSON.stringify({ nativeLinuxAcceptance: "passed", cases: 19 }));
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
