import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { LocalExecutionNode, BrokeredHttpGateway, MacosProcessLauncher } from "@traceforge/execution-node";
import { BrokeredBrowserRuntime, ExecutionNodeBrowserController, sha256File,
  type BrowserArtifactPort, type BrowserDomNode, type BrowserSessionOwner, type BrowserProcessConfiguration } from "./index.js";
import { MACOS_BROWSER_SYSTEM_SERVICES } from "./macos-system-services.js";

const execute = promisify(execFile);
const outerOnly = process.env.TRACEFORGE_TEST_MACOS_BROWSER_OUTER_ONLY === "1";
// Explicit opt-in: real native execution, not part of default mock/fast coverage.
it.skipIf(process.env.TRACEFORGE_TEST_MACOS_BROWSER !== "1")(
  `runs real Chromium through Execution Node, authorization, HTTP receipts and persisted artifacts (${outerOnly ? "diagnostic outer-only; not product acceptance" : "production sandbox flags"})`, async () => {
    expect(process.platform).toBe("darwin"); expect(process.arch).toBe("arm64");
    const browser = await realpath(process.env.TRACEFORGE_REAL_CHROMIUM_PATH!);
    const browserRoot = await realpath(process.env.TRACEFORGE_REAL_CHROMIUM_ROOT!);
    const root = await realpath(await mkdtemp(join(tmpdir(), "traceforge-brokered-browser-")));
    const nodePath = await realpath(process.execPath);
    const controllerPath = join(root, "controller.mjs");
    const scratch = join(root, "scratch");
    const helperPath = resolve("packages/execution-node/native/darwin-arm64/traceforge-macos-sandbox");
    const helper = { path: helperPath, sha256: await sha256File(helperPath) };
    const hits: string[] = [], grants: string[] = [];
    const server = createServer((request, response) => {
      hits.push(request.url!);
      if (request.url === "/start") { response.writeHead(302, { location: "/page" }); response.end(); return; }
      if (request.url === "/asset") { response.setHeader("content-type", "text/javascript"); response.end("document.querySelector('#state').textContent='Asset loaded'"); return; }
      if (request.url === "/download") { response.setHeader("content-disposition", "attachment; filename=evidence.txt"); response.end("persisted evidence"); return; }
      response.setHeader("content-type", "text/html");
      response.end(`<h1>Authorized page</h1><p id="state">Waiting</p><script src="/asset"></script>
        <a href="/download" download aria-label="Save evidence">Save</a>
        <button aria-label="Denied request" onclick="fetch('/denied').catch(()=>{})">Denied</button>`);
    });
    let node: LocalExecutionNode | undefined, runtime: BrokeredBrowserRuntime | undefined, sessionId: string | undefined;
    let cleanup = false;
    let stage = "startup";
    try {
      await mkdir(scratch);
      await execute(resolve("node_modules/.bin/esbuild"), [resolve("packages/browser-runtime/src/test-fixtures/macos-browser-controller.ts"),
        "--bundle", "--platform=node", "--format=esm", "--target=node22", `--outfile=${controllerPath}`]);
      await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
      const address = server.address(); if (!address || typeof address === "string") throw new Error("No fixture address");
      const origin = `http://127.0.0.1:${address.port}`;
      let current = true;
      const expiresAt = new Date(Date.now() + 120000).toISOString();
      const authorize = (url: string) => {
        if (!current || !url.startsWith(`${origin}/`) || new URL(url).pathname === "/denied") throw new Error("Fixture scope denied");
        grants.push(url);
        return { authorizationRef: `grant:${grants.length}`, canonicalUrl: url, expiresAt };
      };
      node = new LocalExecutionNode(new MacosProcessLauncher(helper, MACOS_BROWSER_SYSTEM_SERVICES), {
        platform: "darwin", sandboxBackends: ["traceforge-macos-native"],
        sandboxMeasurements: { "traceforge-macos-native": helper.sha256 }, acceptedSampledResourceBackends: ["traceforge-macos-native"],
        httpBroker: new BrokeredHttpGateway({ authorizer: { authorize: input => authorize(input.url) } }),
        capabilities: { process: { spawn: true, stdio: true, tty: false, adoption: true, resourceLimits: false,
          resourcePolicy: "sampled_terminate", signals: ["terminate", "kill"] } },
      });
      const artifacts: Array<{ ref: string; bytes: Buffer; sha256: string; receipt?: string }> = [];
      const persist = async (input: Parameters<BrowserArtifactPort["recordObservation"]>[0] | Parameters<BrowserArtifactPort["recordDownload"]>[0]) => {
        const bytes = Buffer.from(input.bodyBase64, "base64"), ref = join(root, `artifact-${artifacts.length}`);
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(input.sha256);
        await writeFile(ref, bytes, { flag: "wx" });
        await writeFile(`${ref}.json`, JSON.stringify({ owner: input.owner, sha256: input.sha256,
          byteSize: input.byteSize, receipt: "receipt" in input ? input.receipt : null }), { flag: "wx" });
        artifacts.push({ ref, bytes, sha256: input.sha256, ...("receipt" in input ? { receipt: input.receipt.id } : {}) });
        return { ref };
      };
      runtime = new BrokeredBrowserRuntime({ executionNode: node,
        controller: new ExecutionNodeBrowserController({ executionNode: node, waitIntervalMs: 10 }),
        authorization: { assertSessionCurrent() { if (!current) throw new Error("Lease revoked"); }, async authorizeRequest(input) { return authorize(input.url); } },
        artifacts: { recordObservation: persist, recordDownload: persist },
      });
      const identity = { protocol: "traceforge.browser-controller.v1" as const, controllerVersion: "diagnostic",
        controllerSha256: await sha256File(controllerPath), browserVersion: process.env.TRACEFORGE_REAL_CHROMIUM_PRODUCT!, browserSha256: await sha256File(browser) };
      const owner: BrowserSessionOwner = { caseId: "fixture", runId: "fixture", workId: "fixture", workerId: "fixture", scopeRef: "fixture",
        leaseId: "fixture", leaseExpiresAt: expiresAt, authorizationAction: "browser.request" };
      const configuration: BrowserProcessConfiguration = {
        controlTransport: "pipe", controllerIdentity: identity, expectedSandboxBackend: "traceforge-macos-native",
        expectedBackendMeasurement: helper.sha256, acceptedResourcePolicy: "sampled_terminate",
        executable: nodePath, arguments: [controllerPath, browser, scratch, JSON.stringify(identity),
          ...(outerOnly ? ["--diagnostic-outer-only"] : [])], workingDirectory: scratch, environment: {},
        timeoutMs: 60000, outputLimitBytes: 4 * 1024 * 1024,
        resources: { cpuTimeMs: 20000, memoryBytes: 1024 * 1024 * 1024, maximumProcesses: 32, writeBytes: 64 * 1024 * 1024 },
        permissions: { version: 1, platform: "darwin", network: "brokered", secrets: "deny", sources: ["diagnostic"],
          process: { access: "sandboxed", interactive: false, background: false }, filesystem: {
            read: [{ path: nodePath, scope: "exact" }, { path: controllerPath, scope: "exact" }, { path: browserRoot, scope: "tree" }, { path: scratch, scope: "tree" }],
            write: [{ path: scratch, scope: "tree" }], deny: [] } },
      };
      const session = await runtime.open(owner, configuration);
      sessionId = session.id;
      stage = "initial DOM";
      let initial: Awaited<ReturnType<BrokeredBrowserRuntime["observe"]>> | undefined;
      await eventually(async () => {
        try { initial = await runtime!.observe(session.id, { kind: "dom" }); return true; }
        catch { return false; }
      });
      stage = "navigation";
      await runtime.act(session.id, { id: "navigate", kind: "navigate", view: initial!.view, url: `${origin}/start` });
      stage = "loaded DOM";
      let nodes: BrowserDomNode[] = [];
      await eventually(async () => {
        await runtime!.observe(session.id, { kind: "dom" });
        nodes = JSON.parse(artifacts.at(-1)!.bytes.toString()).nodes;
        return nodes.some(item => item.name === "Asset loaded");
      });
      const download = nodes.find(item => item.name === "Save evidence")!.element!;
      stage = "download";
      await runtime.act(session.id, { id: "download", kind: "click", element: download });
      await eventually(async () => artifacts.some(item => item.receipt && item.bytes.toString() === "persisted evidence"));
      expect(hits).toEqual(expect.arrayContaining(["/start", "/page", "/asset", "/download"]));
      expect(runtime.snapshot(session.id)!.records.filter(item => item.outcome === "fulfilled").every(item => item.receiptRef)).toBe(true);
      stage = "screenshot";
      const screenshot = await runtime.observe(session.id, { kind: "screenshot" });
      expect(screenshot.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(artifacts.at(-1)!.bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      for (const artifact of artifacts) {
        expect(await readFile(artifact.ref)).toEqual(artifact.bytes);
        const metadata = JSON.parse(await readFile(`${artifact.ref}.json`, "utf8"));
        expect(metadata.sha256).toBe(artifact.sha256);
        expect(metadata.owner.runId).toBe(owner.runId);
        if (artifact.receipt) expect(metadata.receipt.id).toBe(artifact.receipt);
      }
      stage = "takeover";
      const takeover = await runtime.beginManualControl(session.id);
      await expect(runtime.observe(session.id, { kind: "dom" })).rejects.toThrow();
      await runtime.observeManual(session.id, takeover.takeoverId, { kind: "dom" });
      await runtime.resumeManualControl(session.id, takeover.takeoverId);
      stage = "authorization denial";
      await runtime.observe(session.id, { kind: "dom" });
      const freshNodes: BrowserDomNode[] = JSON.parse(artifacts.at(-1)!.bytes.toString()).nodes;
      await runtime.act(session.id, { id: "deny", kind: "click", element: freshNodes.find(item => item.name === "Denied request")!.element! });
      await eventually(async () => runtime!.snapshot(session.id)!.records.some(item => item.outcome === "blocked"));
      expect(hits).not.toContain("/denied");
      await runtime.close(session.id);
      // Authorizer errors intentionally fail closed. Use a fresh session to
      // independently verify lease revocation, not an already failed controller.
      const renewed = await runtime.open(owner, configuration);
      sessionId = renewed.id;
      current = false;
      stage = "revocation";
      await expect(runtime.observe(renewed.id, { kind: "dom" })).rejects.toThrow();
      expect(runtime.snapshot(renewed.id)!.status).toBe("frozen");
      await runtime.close(renewed.id);
      await node.shutdown(); cleanup = true;
    } catch (error) {
      const diagnostic = await readFile(join(scratch, "diagnostic-error.json"), "utf8").catch(() => "");
      throw new Error(`Real browser stage ${stage} failed: ${diagnostic}`, { cause: error });
    } finally {
      if (runtime && sessionId) await runtime.close(sessionId).catch(() => undefined);
      if (node) { await node.shutdown(); cleanup = true; }
      await new Promise<void>(done => server.close(() => done()));
      if (cleanup || !node) await rm(root, { recursive: true, force: false });
    }
  }, 60000);

async function eventually(check: () => Promise<boolean>) {
  const until = Date.now() + 10000;
  while (Date.now() < until) { if (await check()) return; await new Promise(done => setTimeout(done, 30)); }
  throw new Error("Real browser condition timed out");
}
