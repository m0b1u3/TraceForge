import { mkdtemp, realpath, readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { runMacosOwnedExecution } from "../packages/execution-node/src/macos-owned-execution.js";
import { MACOS_BROWSER_SYSTEM_SERVICES } from "../packages/browser-runtime/src/macos-system-services.js";

// Compatibility diagnostic only: no production trust registration and no websites.
if (!process.argv[2] || !process.argv[3]) throw new Error("Supply browser executable and its read-only root");
const browser = await realpath(process.argv[2]), browserRoot = await realpath(process.argv[3]);
// Explicit diagnostic opt-in only; production transport continues rejecting this flag.
const outerSandboxOnly = process.argv.includes("--outer-sandbox-only");
const part = relative(browserRoot, browser);
if (part.startsWith("..") || isAbsolute(part)) throw new Error("Browser must be inside its grant root");
const root = await realpath(await mkdtemp(join(tmpdir(), "traceforge-browser-probe-")));
const path = resolve("packages/execution-node/native/darwin-arm64/traceforge-macos-sandbox");
const suite = process.argv.includes("--isolation-suite");
let confirmed = true;
let hits = 0;
const server = createServer((_request, response) => { hits++; response.end("traceforge-network-marker"); });
const secretRoot = await realpath(await mkdtemp(join(tmpdir(), "traceforge-browser-denied-")));
try {
  await writeFile(join(secretRoot, "fixture.html"), "<p>traceforge-denied-marker</p>");
  await writeFile(join(root, "allowed.html"), "<p>traceforge-allowed-marker</p>");
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture listener");
  const networkUrl = `http://127.0.0.1:${address.port}/`;
  if (!(await (await fetch(networkUrl)).text()).includes("traceforge-network-marker")) throw new Error("Fixture unavailable");
  hits = 0;
  const cases = [
    { name: "render", url: "data:text/html,<p>traceforge-native-fixture</p>", marker: "traceforge-native-fixture", deny: false, cancel: false },
    ...(suite ? [
      { name: "allowed-file", url: pathToFileURL(join(root, "allowed.html")).href, marker: "traceforge-allowed-marker", deny: false, cancel: false },
      { name: "denied-file", url: pathToFileURL(join(secretRoot, "fixture.html")).href, marker: "traceforge-denied-marker", deny: true, cancel: false },
      { name: "denied-network", url: networkUrl, marker: "traceforge-network-marker", deny: true, cancel: false },
      { name: "cancel", url: "data:text/html,<script>while(true){}</script>", marker: "", deny: false, cancel: true },
    ] : []),
  ];
  for (const test of cases) {
  const abort = new AbortController();
  const timer = test.cancel ? setTimeout(() => abort.abort(), 1000) : undefined;
  confirmed = false;
  let result;
  try {
  result = await runMacosOwnedExecution({ requestId: "compatibility", attribution: {
    caseId: "fixture", runId: "fixture", workId: "fixture", workerId: "fixture", scopeRef: "fixture", leaseId: "fixture",
    leaseExpiresAt: new Date(Date.now() + 30000).toISOString(), actionId: "fixture", idempotencyKey: "fixture",
  }, executable: browser, arguments: ["--headless=new", "--no-first-run", "--disable-background-networking", "--disable-component-update",
    ...(outerSandboxOnly ? ["--no-sandbox"] : []),
    `--user-data-dir=${root}`, "--dump-dom", test.url], workingDirectory: root,
    environment: {}, stdin: "closed", timeoutMs: 10000, outputLimitBytes: 16384,
    resources: { cpuTimeMs: 5000, memoryBytes: 1073741824, maximumProcesses: 32, writeBytes: 33554432 },
    permissions: { version: 1, platform: "darwin", network: "deny", process: { access: "sandboxed", interactive: false, background: false },
      secrets: "deny", sources: ["compatibility"], filesystem: { read: [{ path: browserRoot, scope: "tree" }, { path: root, scope: "tree" }],
        write: [{ path: root, scope: "tree" }], deny: [] } },
  }, { path, sha256: createHash("sha256").update(await readFile(path)).digest("hex") }, abort.signal,
  undefined, process.argv.includes("--browser-services") ? MACOS_BROWSER_SYSTEM_SERVICES : undefined);
  } finally { clearTimeout(timer); }
  confirmed = result.cleanupConfirmed;
  const passed = confirmed && (test.cancel ? result.reason === "cancelled" : result.reason === "exited" && result.exitCode === 0
    && (test.deny ? !result.stdout.toString().includes(test.marker) : result.stdout.toString().includes(test.marker)))
    && (test.name !== "denied-network" || hits === 0);
  console.log(JSON.stringify({ ...result, case: test.name, networkRequests: hits, outerSandboxOnly, stdout: result.stdout.toString(), stderr: result.stderr.toString(), passed }, null, 2));
  if (!passed) process.exitCode = 1;
  if (!confirmed) break;
  }
} finally {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(secretRoot, { recursive: true, force: false });
  if (confirmed) await rm(root, { recursive: true, force: false });
  else console.error(`Cleanup unconfirmed; retaining ${root}`);
}
