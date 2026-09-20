// Integration-only controller. Never bundled as the production entry point.
// Default to production launch flags. Outer-only is a separate diagnostic mode;
// a pass in that mode is never production-installation acceptance.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { ChromiumPipeTransport } from "../chromium-pipe-transport.js";
import { ChromiumCdpAdapter } from "../chromium-cdp-adapter.js";
import { BrowserControllerProcessRuntime } from "../controller-process-runtime.js";
import { NodeBrowserControllerProcessIo } from "../node-controller-entry.js";

const [browser, directory, identityJson] = process.argv.slice(2);
if (!browser || !directory || !identityJson) throw new Error("Missing diagnostic controller inputs");
const identity = JSON.parse(identityJson);
const cdp = await ChromiumPipeTransport.launch({
  browserExecutable: browser, workingDirectory: directory, userDataDirectory: `${directory}/profile`,
  expectedIdentity: identity,
  launcher(spec) {
    const child = spawn(spec.executable, [...spec.arguments,
      ...(process.argv[5] === "--diagnostic-outer-only" ? ["--no-sandbox"] : [])], {
      cwd: spec.workingDirectory, env: spec.environment, stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
    });
    return Object.assign(child, {
      controlInput: child.stdio[3] as Writable, controlOutput: child.stdio[4] as Readable, stderr: child.stderr!,
    });
  },
});
const io = new NodeBrowserControllerProcessIo(process.stdin, process.stdout, code => { process.exitCode = code; });
const write = io.write.bind(io);
io.write = async data => {
  const frame = JSON.parse(data.subarray(4).toString());
  if (frame.type === "response" && frame.ok === false) writeFileSync(`${directory}/diagnostic-error.json`, JSON.stringify(frame.error));
  await write(data);
};
await new BrowserControllerProcessRuntime({
  io,
  adapter: new ChromiumCdpAdapter({ cdp, identity }),
}).start();
