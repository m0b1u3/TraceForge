import { spawn, type ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { isAbsolute, join } from "node:path";
import { ChromiumPipeTransport } from "./chromium-pipe-transport.js";
import { ChromiumCdpAdapter } from "./chromium-cdp-adapter.js";
import type { BrowserControllerConnection, BrowserControllerIdentity } from "./index.js";

/** Application-owned browser, with Chromium's own sandbox enabled. This is not
 * an OS filesystem or denied-network sandbox and cannot execute arbitrary tools.
 * Inputs come only from the verified installation, never renderer/Scenario RPC. */
export async function launchOwnedChromium(input: {
  browserExecutable: string; executableSha256: string; workingDirectory: string; identity: BrowserControllerIdentity; timeoutMs: number;
}): Promise<{ processId: string; connection: BrowserControllerConnection; terminate(): Promise<void> }> {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Owned Chromium currently requires macOS ARM64");
  if (![input.browserExecutable, input.workingDirectory].every(isAbsolute)
    || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 900000)
    throw new Error("Invalid owned Chromium installation or lifetime");
  let child: ChildProcess | undefined, exited = false;
  let closing: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const groupExists = () => {
    if (!child?.pid) return false;
    try { process.kill(-child.pid, 0); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
  };
  const terminate = () => closing ??= (async () => {
    clearTimeout(timer);
    if (!child?.pid) { if (child && !exited) throw new Error("Chromium startup outcome is unknown"); return; }
    // Kill the browser-owned process group, not an arbitrary user process. Wait
    // for absence before reporting success or deleting its isolated profile.
    if (groupExists()) {
      try { process.kill(-child.pid, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    const until = Date.now() + 5000;
    while (groupExists() && Date.now() < until) await new Promise(done => setTimeout(done, 25));
    if (groupExists()) throw new Error("Chromium process-group cleanup is unconfirmed");
  })().catch(error => { closing = undefined; throw error; });
  try {
    const cdp = await ChromiumPipeTransport.launch({ browserExecutable: input.browserExecutable,
      workingDirectory: input.workingDirectory, userDataDirectory: join(input.workingDirectory, "profile"),
      expectedIdentity: input.identity, expectedExecutableSha256: input.executableSha256,
      launcher(spec) {
        child = spawn(spec.executable, spec.arguments, { cwd: spec.workingDirectory, env: spec.environment,
          detached: true, stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
        child.once("exit", () => { exited = true; });
        timer = setTimeout(() => { void terminate().catch(() => undefined); }, input.timeoutMs);
        return Object.assign(child, { controlInput: child.stdio[3] as Writable,
          controlOutput: child.stdio[4] as Readable, stderr: child.stderr! });
      } });
    const adapter = new ChromiumCdpAdapter({ cdp, identity: input.identity, isolation: "chromium" });
    await adapter.initialize();
    const connection: BrowserControllerConnection = {
      proof: adapter.proof, start: (intercept, failure) => adapter.activate(intercept, failure),
      observe: request => adapter.observe(request), act: action => adapter.act(action),
      observeManual: (id, request) => adapter.observeManual(id, request), actManual: (id, action) => adapter.actManual(id, action),
      beginTakeover: () => adapter.beginTakeover(), resumeTakeover: id => adapter.resumeTakeover(id),
      async close() { try { await adapter.close(); } finally { await terminate(); } },
    };
    return { processId: `chromium:${child!.pid}`, connection, terminate };
  } catch (error) {
    try { await terminate(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Chromium launch failed; cleanup unconfirmed"); }
    throw error;
  }
}
