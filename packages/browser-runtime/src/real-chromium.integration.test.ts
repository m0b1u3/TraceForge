import { createHash, generateKeyPairSync } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ChromiumCdpAdapter,
  ChromiumPipeTransport,
  BROWSER_CONTROLLER_PROTOCOL,
  BROWSER_RUNTIME_SOURCE_LOCK_PROFILE,
  BROWSER_RUNTIME_SOURCE_AUTHORITY_PROFILE,
  browserRuntimeSourceLockSha256,
  browserRuntimeBuildAttestationSha256,
  createBrowserRuntimeSourceReview,
  verifyBrowserRuntimeSourceReview,
  createBrowserRuntimeReleaseManifest,
  encodeLengthPrefixedJson,
  LengthPrefixedJsonDecoder,
  measureBrowserRuntimeTree,
  sha256File,
  type BrowserDomNode,
  type BrowserObservationPayload,
  type BrowserResponseDirective,
  type InterceptedBrowserRequest,
  type BrowserRuntimeSourceLock,
} from "./index.js";
import { createTestBrowserRuntimeBuildAttestation } from "./test-fixtures/browser-runtime-material.js";

const browserExecutable = process.env.TRACEFORGE_REAL_CHROMIUM_PATH;
const browserProduct = process.env.TRACEFORGE_REAL_CHROMIUM_PRODUCT;
const browserRoot = process.env.TRACEFORGE_REAL_CHROMIUM_ROOT;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("real Chromium Browser Runtime", () => {
  it("keeps navigation, subresources, observations, actions and takeover on the brokered pipe chain", async () => {
    if (!browserExecutable?.startsWith("/") || !browserProduct?.trim()) {
      throw new Error("TRACEFORGE_REAL_CHROMIUM_PATH and TRACEFORGE_REAL_CHROMIUM_PRODUCT are required");
    }
    const directory = await mkdtemp(join(tmpdir(), "traceforge-browser-real-"));
    temporaryDirectories.push(directory);
    const browserSha256 = await sha256File(browserExecutable);
    const cdp = await ChromiumPipeTransport.launch({
      browserExecutable,
      workingDirectory: directory,
      userDataDirectory: join(directory, "profile"),
      expectedIdentity: {
        protocol: "traceforge.browser-controller.v1",
        controllerVersion: "real-integration-fixture",
        controllerSha256: "0".repeat(64),
        browserVersion: browserProduct,
        browserSha256,
      },
      startupTimeoutMs: 15_000,
      commandTimeoutMs: 15_000,
      shutdownTimeoutMs: 5_000,
    });
    const adapter = new ChromiumCdpAdapter({ cdp, identity: {
      protocol: "traceforge.browser-controller.v1",
      controllerVersion: "real-integration-fixture",
      controllerSha256: "0".repeat(64),
      browserVersion: browserProduct,
      browserSha256,
    } });
    const requests: InterceptedBrowserRequest[] = [];
    const failures: Error[] = [];
    try {
      await adapter.initialize();
      adapter.activate(async (request) => {
        requests.push(structuredClone(request));
        return fixtureDirective(request);
      }, (error) => failures.push(error));

      const initial = await eventually(() => adapter.observe({ kind: "dom" }));
      const navigation = await adapter.act({ id: "navigate:start", kind: "navigate", view: initial.view,
        url: "https://browser.fixture.invalid/start" });
      const dom = await eventually(async () => {
        const observed = await adapter.observe({ kind: "dom", pageId: navigation.view.pageId });
        const decoded = decodeDom(observed);
        if (!decoded.nodes.some((node) => node.name === "Load evidence")) throw new Error("fixture DOM is not ready");
        return observed;
      });
      const nodes = decodeDom(dom).nodes;
      const input = requireElement(nodes, "Operator input");
      const button = requireElement(nodes, "Load evidence");
      const popup = requireElement(nodes, "Open review");
      const download = requireElement(nodes, "Save artifact");

      await adapter.act({ id: "fill:operator", kind: "fill", element: input.element!, text: "reviewer" });
      await adapter.act({ id: "click:load", kind: "click", element: button.element! });
      await eventually(() => requests.some((request) => request.url === "https://browser.fixture.invalid/data") || undefined);
      const changed = await eventually(async () => {
        const observed = await adapter.observe({ kind: "dom", pageId: dom.view.pageId });
        if (!decodeDom(observed).nodes.some((node) => node.name === "Evidence ready")) throw new Error("fixture update is not ready");
        return observed;
      });
      expect(changed.summary.change?.changed ?? 0).toBeGreaterThanOrEqual(0);

      await adapter.act({ id: "click:popup", kind: "click", element: popup.element! });
      await eventually(() => {
        if (!requests.some((request) => request.url === "https://browser.fixture.invalid/review")) {
          throw new Error(`popup request not observed; requests=${requests.map((request) => request.url).join(",")}; failures=${failures.map((error) => error.message).join(",")}`);
        }
        return true;
      });
      await adapter.act({ id: "click:download", kind: "click", element: download.element! });
      await eventually(() => requests.some((request) => request.url === "https://browser.fixture.invalid/artifact") || undefined);

      const screenshot = await adapter.observe({ kind: "screenshot", pageId: dom.view.pageId });
      expect(screenshot.mimeType).toBe("image/png");
      expect(Buffer.from(screenshot.bodyBase64, "base64").subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

      const takeover = await adapter.beginTakeover();
      expect(takeover.pages.length).toBeGreaterThanOrEqual(2);
      const manual = await adapter.observeManual(takeover.takeoverId, { kind: "dom", pageId: dom.view.pageId });
      await expect(adapter.observe({ kind: "dom" })).rejects.toThrow(/manual (control|takeover)/);
      const resumed = await adapter.resumeTakeover(takeover.takeoverId);
      expect(resumed.generation).toBe(takeover.generation + 1);
      await expect(adapter.act({ id: "stale:after-takeover", kind: "click",
        element: requireElement(decodeDom(manual).nodes, "Load evidence").element! })).rejects.toThrow(/stale control generation/);

      expect(requests).toEqual(expect.arrayContaining([
        expect.objectContaining({ url: "https://browser.fixture.invalid/start", kind: "document", initiator: "navigation" }),
        expect.objectContaining({ url: "https://browser.fixture.invalid/landing", kind: "document", initiator: "redirect" }),
        expect.objectContaining({ url: "https://browser.fixture.invalid/frame", kind: "iframe" }),
        expect.objectContaining({ url: "https://browser.fixture.invalid/data", kind: expect.stringMatching(/^(fetch|xhr)$/) }),
        expect.objectContaining({ url: "https://browser.fixture.invalid/review", kind: "document", initiator: "popup" }),
      ]));
      expect(failures).toEqual([]);
      void cdp.send("Page.crash", {}, dom.view.pageId).catch(() => undefined);
      await eventually(() => failures.some((error) => error.message === "Chromium renderer target crashed") || undefined);
    } finally {
      await adapter.close();
    }
  }, 60_000);

  it("starts the reproducible Controller bundle from its reviewed manifest and completes the stdio protocol", async () => {
    if (!browserExecutable?.startsWith("/") || !browserRoot?.startsWith("/") || !browserProduct?.trim()) {
      throw new Error("TRACEFORGE_REAL_CHROMIUM_ROOT, TRACEFORGE_REAL_CHROMIUM_PATH and TRACEFORGE_REAL_CHROMIUM_PRODUCT are required");
    }
    const directory = await mkdtemp(join(tmpdir(), "traceforge-browser-bundle-real-"));
    temporaryDirectories.push(directory);
    const controllerPath = resolve("packages/browser-runtime/dist/traceforge-browser-controller.mjs");
    const controllerBytes = await readFile(controllerPath);
    const browserBytes = await readFile(browserExecutable);
    const browserTree = await measureBrowserRuntimeTree(browserRoot);
    const browserRelativeExecutable = browserExecutable.slice(browserRoot.endsWith("/") ? browserRoot.length : browserRoot.length + 1);
    const sourceTarget = {
        platform: process.platform as "darwin" | "linux" | "win32",
        architecture: process.arch as "arm64" | "x64",
        archiveFormat: "zip" as const,
        url: "https://example.invalid/test-only-browser.zip",
        archiveBytes: 1,
        archiveSha256: "0".repeat(64),
        rootDirectory: basename(browserRoot),
        executable: browserRelativeExecutable,
    };
    const buildAttestation = createTestBrowserRuntimeBuildAttestation({
      version: browserProduct, revision: "1".repeat(40), target: sourceTarget,
      browserTreeSha256: browserTree.sha256,
    });
    const sourceLock: BrowserRuntimeSourceLock = {
      format: 1,
      profile: BROWSER_RUNTIME_SOURCE_LOCK_PROFILE,
      sourceId: "local-real-browser-integration-fixture",
      version: browserProduct,
      revision: "1".repeat(40),
      createdAt: "2026-09-04T00:00:00.000Z",
      buildAttestationSha256: browserRuntimeBuildAttestationSha256(buildAttestation),
      securityReviewRef: `sha256:${buildAttestation.compliance.securityAssessmentSha256}`,
      licenseReviewRef: `sha256:${buildAttestation.compliance.licenseReviewSha256}`,
      targets: [sourceTarget],
    };
    const keys = generateKeyPairSync("ed25519");
    const sourceAuthority = { format: 1 as const, profile: BROWSER_RUNTIME_SOURCE_AUTHORITY_PROFILE,
      keyId: "local-real-browser-reviewer", publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      sourceIds: [sourceLock.sourceId], validFrom: "2026-09-01T00:00:00.000Z",
      validUntil: "2099-01-01T00:00:00.000Z", revokedAt: null };
    const sourceReview = createBrowserRuntimeSourceReview({ sourceLock, keyId: sourceAuthority.keyId,
      privateKeyPem: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      issuedAt: "2026-09-04T00:01:00.000Z", expiresAt: "2098-01-01T00:00:00.000Z" });
    const reviewSha256 = verifyBrowserRuntimeSourceReview({ sourceLock, sourceReview, authority: sourceAuthority,
      now: "2026-09-04T00:02:00.000Z" }).reviewSha256;
    const manifest = createBrowserRuntimeReleaseManifest({
      platform: process.platform as "darwin" | "linux" | "win32",
      architecture: process.arch as "arm64" | "x64",
      source: { lockSha256: browserRuntimeSourceLockSha256(sourceLock), sourceId: sourceLock.sourceId,
        version: sourceLock.version, revision: sourceLock.revision, archiveBytes: sourceLock.targets[0]!.archiveBytes,
        archiveSha256: sourceLock.targets[0]!.archiveSha256, securityReviewRef: sourceLock.securityReviewRef,
        licenseReviewRef: sourceLock.licenseReviewRef, reviewKeyId: sourceReview.keyId, reviewSha256,
        reviewExpiresAt: sourceReview.expiresAt, buildAttestationSha256: sourceLock.buildAttestationSha256 },
      controller: { executable: basename(controllerPath), version: "0.1.0", bytes: controllerBytes },
      browser: { root: basename(browserRoot), executable: browserRelativeExecutable, version: browserProduct,
        executableSha256: createHash("sha256").update(browserBytes).digest("hex"), tree: browserTree },
    });
    const manifestPath = join(directory, "release.json");
    const sourceLockPath = join(directory, "source-lock.json");
    const sourceReviewPath = join(directory, "source-review.json");
    const sourceAuthorityPath = join(directory, "source-authority.json");
    const buildAttestationPath = join(directory, "build-attestation.json");
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, { encoding: "utf8", flag: "wx" });
    await writeFile(sourceLockPath, `${JSON.stringify(sourceLock)}\n`, { encoding: "utf8", flag: "wx" });
    await writeFile(sourceReviewPath, `${JSON.stringify(sourceReview)}\n`, { encoding: "utf8", flag: "wx" });
    await writeFile(sourceAuthorityPath, `${JSON.stringify(sourceAuthority)}\n`, { encoding: "utf8", flag: "wx" });
    await writeFile(buildAttestationPath, `${JSON.stringify(buildAttestation)}\n`, { encoding: "utf8", flag: "wx" });
    const child = spawn(process.execPath, [controllerPath,
      `--release-manifest=${manifestPath}`,
      `--source-lock=${sourceLockPath}`,
      `--source-review=${sourceReviewPath}`,
      `--source-authority=${sourceAuthorityPath}`,
      `--build-attestation=${buildAttestationPath}`,
      `--browser-root=${browserRoot}`,
      `--browser=${browserExecutable}`,
      `--working-directory=${directory}`,
      `--user-data-directory=${join(directory, "profile")}`,
    ], { cwd: directory, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    const harness = new RealControllerHarness(child, fixtureDirective);
    try {
      const ready = await harness.ready;
      expect(ready).toMatchObject({ type: "ready", proof: { identity: {
        controllerSha256: manifest.controller.sha256,
        browserSha256: manifest.browser.tree.sha256,
        browserVersion: browserProduct,
      } } });
      await harness.command("activate", {});
      const initial = await eventually(() => harness.command("observe", { kind: "dom" }));
      const navigation = await harness.command("act", { id: "bundle:navigate", kind: "navigate",
        view: (initial as BrowserObservationPayload).view, url: "https://browser.fixture.invalid/start" });
      const observed = await eventually(async () => {
        const value = await harness.command("observe", { kind: "dom", pageId: (navigation as { view: { pageId: string } }).view.pageId });
        if (!decodeDom(value as BrowserObservationPayload).nodes.some((node) => node.name === "Load evidence")) {
          throw new Error("bundled Controller DOM is not ready");
        }
        return value as BrowserObservationPayload;
      });
      expect(observed.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(harness.requests.some((request) => request.url === "https://browser.fixture.invalid/start")).toBe(true);
      await harness.command("shutdown", {});
      await harness.exited;
      expect(harness.stderrBytes).toBe(0);
    } finally {
      harness.kill();
    }
  }, 60_000);
});

class RealControllerHarness {
  readonly requests: InterceptedBrowserRequest[] = [];
  readonly ready: Promise<Record<string, unknown>>;
  readonly exited: Promise<void>;
  stderrBytes = 0;
  private readonly decoder = new LengthPrefixedJsonDecoder(4 * 1024 * 1024, 8 * 1024 * 1024);
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  private resolveReady!: (value: Record<string, unknown>) => void;
  private rejectReady!: (error: Error) => void;
  private sequence = 0;

  constructor(private readonly child: ChildProcessWithoutNullStreams,
    private readonly broker: (request: InterceptedBrowserRequest) => BrowserResponseDirective) {
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.exited = new Promise((resolve) => child.once("exit", () => resolve()));
    child.stdout.on("data", (data: Buffer) => {
      try { for (const value of this.decoder.push(data)) this.receive(value); }
      catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    });
    child.stderr.on("data", (data: Buffer) => { this.stderrBytes += data.length; });
    child.once("error", (error) => this.fail(error));
    child.once("exit", (code, signal) => {
      if (code !== 0 && code !== null) this.fail(new Error(`Controller exited with code ${code} signal ${String(signal)}`));
    });
  }

  command(command: string, input: Record<string, unknown>): Promise<unknown> {
    const id = `real-command:${++this.sequence}`;
    const result = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.child.stdin.write(encodeLengthPrefixedJson({ protocol: BROWSER_CONTROLLER_PROTOCOL,
      type: "command", id, command, input }, 4 * 1024 * 1024));
    return result;
  }

  kill(): void {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
  }

  private receive(value: unknown): void {
    if (!value || typeof value !== "object") throw new Error("Controller returned a non-object frame");
    const frame = value as Record<string, unknown>;
    if (frame.protocol !== BROWSER_CONTROLLER_PROTOCOL || typeof frame.type !== "string") throw new Error("Controller protocol mismatch");
    if (frame.type === "ready") { this.resolveReady(frame); return; }
    if (frame.type === "response" && typeof frame.id === "string") {
      const pending = this.pending.get(frame.id);
      if (!pending) throw new Error("Controller returned an unknown response");
      this.pending.delete(frame.id);
      if (frame.ok === true) pending.resolve(frame.result);
      else pending.reject(new Error(`Controller command rejected: ${JSON.stringify(frame.error)}`));
      return;
    }
    if (frame.type === "request" && typeof frame.id === "string" && frame.request && typeof frame.request === "object") {
      const request = structuredClone(frame.request) as InterceptedBrowserRequest;
      this.requests.push(request);
      const directive = this.broker(request);
      this.child.stdin.write(encodeLengthPrefixedJson({ protocol: BROWSER_CONTROLLER_PROTOCOL,
        type: "request_result", id: frame.id, ok: true, directive }, 4 * 1024 * 1024));
      return;
    }
    throw new Error("Controller returned an unsupported frame");
  }

  private fail(error: Error): void {
    this.rejectReady(error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function fixtureDirective(request: InterceptedBrowserRequest): BrowserResponseDirective {
  const url = new URL(request.url);
  const bodies: Record<string, { type: string; body: string; artifact?: boolean; status?: number;
    headers?: Array<{ name: string; value: string }> }> = {
    "/start": { type: "text/plain", body: "", status: 302,
      headers: [{ name: "location", value: "https://browser.fixture.invalid/landing" }] },
    "/landing": { type: "text/html; charset=utf-8", body: `<!doctype html><html><body>
      <label>Operator <input aria-label="Operator input"></label>
      <button aria-label="Load evidence" onclick="fetch('/data').then(r=>r.text()).then(t=>document.querySelector('#status').textContent=t)">Load</button>
      <button aria-label="Open review" onclick="window.open('/review', '_blank')">Review</button>
      <a aria-label="Save artifact" href="/artifact" download>Save</a>
      <div id="status" aria-label="Waiting">Waiting</div><iframe src="/frame" title="Evidence frame"></iframe>
    </body></html>` },
    "/frame": { type: "text/html; charset=utf-8", body: "<!doctype html><p>Frame ready</p>" },
    "/data": { type: "text/plain; charset=utf-8", body: "Evidence ready" },
    "/review": { type: "text/html; charset=utf-8", body: "<!doctype html><h1>Review ready</h1>" },
    "/artifact": { type: "application/octet-stream", body: "artifact bytes", artifact: true },
    "/favicon.ico": { type: "image/x-icon", body: "" },
  };
  const fixture = bodies[url.pathname];
  if (!fixture) return { action: "block", requestId: request.id, reason: "policy_denied" };
  const body = Buffer.from(fixture.body, "utf8");
  return {
    action: "fulfill",
    requestId: request.id,
    status: fixture.status ?? 200,
    headers: [
      { name: "content-type", value: fixture.type },
      { name: "content-length", value: String(body.length) },
      ...(fixture.headers ?? []),
      ...(fixture.artifact ? [{ name: "content-disposition", value: "attachment; filename=artifact.bin" }] : []),
    ],
    bodyBase64: body.toString("base64"),
    receiptRef: `receipt:${createHash("sha256").update(request.url).digest("hex")}`,
    artifactRef: fixture.artifact ? "artifact:fixture" : null,
  };
}

function decodeDom(observation: BrowserObservationPayload): { nodes: BrowserDomNode[] } {
  if (observation.kind !== "dom") throw new Error("DOM observation required");
  return JSON.parse(Buffer.from(observation.bodyBase64, "base64").toString("utf8")) as { nodes: BrowserDomNode[] };
}

function requireElement(nodes: BrowserDomNode[], name: string): BrowserDomNode {
  const node = nodes.find((candidate) => candidate.name === name && candidate.element);
  if (!node) throw new Error(`Missing issued fixture element: ${name}`);
  return node;
}

async function eventually<T>(operation: () => Promise<T> | T, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  do {
    try {
      const value = await operation();
      if (value !== undefined && value !== false) return value as T;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  throw lastError instanceof Error ? lastError : new Error("Real Chromium integration condition timed out");
}
