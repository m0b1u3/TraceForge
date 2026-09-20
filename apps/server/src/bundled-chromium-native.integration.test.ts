import { readFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { expect, it, vi } from "vitest";
import { BrokeredBrowserRuntime, type BrowserArtifactPort } from "@traceforge/browser-runtime";
import { BrokeredHttpGateway, type ExecutionNode } from "@traceforge/execution-node";
import type { ToolExecutionContext } from "@traceforge/worker-runtime";
import { createInstalledBrowserDeployment } from "./browser-installation.js";

it.skipIf(process.env.TRACEFORGE_TEST_BUNDLED_CHROMIUM !== "1")(
  "verifies bundled material and runs Chromium-only navigation, pixels, manual input, handback and cleanup", async () => {
    const root = await realpath(resolve(process.env.TRACEFORGE_BUNDLED_CHROMIUM_ROOT ?? "apps/desktop/runtime/browser-runtime"));
    const scratch = await realpath(await mkdtemp(join(tmpdir(), "traceforge-owned-native-")));
    const metadata = JSON.parse(await readFile(join(root, "installation.json"), "utf8"));
    const bodies = new Map<string, Buffer>();
    const save: BrowserArtifactPort["recordObservation"] = input => { const ref = `artifact:${bodies.size}`;
      bodies.set(ref, Buffer.from(input.bodyBase64, "base64")); return { ref }; };
    const deployment = createInstalledBrowserDeployment({ isolation: "chromium", releaseDirectory: join(root, "release"),
      sourceAuthorityPath: join(root, "source-authority.json"), nodeExecutable: join(root, "node"), scratchDirectory: scratch,
      nodeSha256: metadata.nodeSha256, expectedSandboxBackend: metadata.expectedSandboxBackend,
      expectedBackendMeasurement: metadata.expectedBackendMeasurement, resources: metadata.resources },
      { recordObservation: save, recordDownload: save });
    const hits: string[] = [];
    const server = createServer((request, response) => {
      hits.push(request.url!); response.setHeader("Content-Type", "text/html");
      response.end('<input aria-label="Entry" style="position:fixed;left:0;top:0;width:300px;height:60px" oninput="document.querySelector(\'p\').textContent=this.value"><p style="margin-top:80px">Initial</p>');
    });
    let runtime: BrokeredBrowserRuntime | undefined, id: string | undefined, cleaned = false;
    const context: ToolExecutionContext = { caseId: "fixture", runId: "fixture", workId: "fixture", workerId: "fixture",
      scopeRef: "fixture", leaseId: "fixture", leaseExpiresAt: new Date(Date.now() + 120000).toISOString(), idempotencyKey: "native",
      effectivePermissions: { version: 1, platform: "darwin", network: "brokered", secrets: "deny", sources: ["fixture"],
        filesystem: { read: [], write: [], deny: [] }, process: { access: "sandboxed", interactive: false, background: false } } };
    try {
      await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
      const address = server.address(); if (!address || typeof address === "string") throw new Error("No fixture listener");
      const url = `http://127.0.0.1:${address.port}/`;
      const authorize = (value: string) => { if (value !== url) throw new Error("Denied fixture scope");
        return { authorizationRef: "fixture", canonicalUrl: value, expiresAt: context.leaseExpiresAt }; };
      const broker = new BrokeredHttpGateway({ authorizer: { authorize: request => authorize(request.url) } });
      const startProcess = vi.fn(() => { throw new Error("Outer sandbox must not run"); });
      const node = { startProcess, requestHttp: (request: Parameters<ExecutionNode["requestHttp"]>[0]) => broker.execute("fixture", request) } as unknown as ExecutionNode;
      runtime = new BrokeredBrowserRuntime({ executionNode: node, controller: { attach: async () => { throw new Error("Outer controller must not run"); } },
        chromiumProcess: deployment.chromiumProcess, authorization: { assertSessionCurrent() {}, authorizeRequest: async input => authorize(input.url) },
        artifacts: { recordObservation: save, recordDownload: save } });
      const configuration = await deployment.prepare(context, new AbortController().signal);
      configuration.timeoutMs = 30000;
      const { effectivePermissions: _permissions, idempotencyKey: _key, ...owner } = context;
      const session = await runtime.open({ ...owner, authorizationAction: "browser.request" }, configuration); id = session.id;
      expect(session.isolation).toBe("chromium");
      const argumentsText = execFileSync("/bin/ps", ["-p", session.processId.slice("chromium:".length), "-o", "command="], { encoding: "utf8" });
      expect(argumentsText).toContain("--remote-debugging-pipe");
      expect(argumentsText).not.toMatch(/--no-sandbox|--disable-setuid-sandbox|traceforge-macos-sandbox/);
      const initial = await runtime.observe(id, { kind: "dom" });
      await runtime.act(id, { id: "navigation", kind: "navigate", view: initial.view, url });
      await eventually(async () => { const result = await runtime!.observe(id!, { kind: "dom" });
        return bodies.get(result.artifactRef)!.toString().includes("Entry"); });
      const takeover = await runtime.beginManualControl(id);
      await expect(runtime.observe(id, { kind: "dom" })).rejects.toThrow();
      const frame = await runtime.previewManual(id, takeover.takeoverId);
      expect(Buffer.from(frame.bodyBase64, "base64").subarray(0, 8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]));
      await runtime.actManual(id, takeover.takeoverId, { id: "pointer", kind: "input", view: frame.view, input: { type: "click", x: .02, y: .02 } });
      const next = await runtime.previewManual(id, takeover.takeoverId);
      await runtime.actManual(id, takeover.takeoverId, { id: "text", kind: "input", view: next.view, input: { type: "text", text: "Manual value" } });
      await runtime.resumeManualControl(id, takeover.takeoverId);
      await eventually(async () => { const result = await runtime!.observe(id!, { kind: "dom" });
        return bodies.get(result.artifactRef)!.toString().includes("Manual value"); });
      expect(hits).toEqual(["/"]); expect(startProcess).not.toHaveBeenCalled();
      expect(runtime.snapshot(id)!.records[0].receiptRef).toBeTruthy();
      await runtime.close(id); await deployment.release!(context, true); cleaned = true;
      const short = await deployment.prepare(context, new AbortController().signal); short.timeoutMs = 500;
      const expiring = await runtime.open({ ...owner, authorizationAction: "browser.request" }, short); id = expiring.id;
      await eventually(async () => runtime!.snapshot(id!)!.status === "frozen");
      await runtime.close(id); await deployment.release!(context, true);
    } finally {
      if (runtime && id) { await runtime.close(id); cleaned = true; }
      await new Promise<void>(done => server.close(() => done()));
      if (cleaned) { await deployment.release!(context, true); await rm(scratch, { recursive: true, force: false }); }
    }
  }, 60000);
async function eventually(check: () => Promise<boolean>) {
  const end = Date.now() + 5000;
  while (Date.now() < end) { if (await check()) return; await new Promise(done => setTimeout(done, 30)); }
  throw new Error("Browser state did not arrive");
}
