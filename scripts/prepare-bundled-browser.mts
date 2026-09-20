import { generateKeyPairSync, createPublicKey, createHash } from "node:crypto";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { assembleBrowserRuntimeRelease, extractBrowserRuntimeSourceArchive, measureBrowserRuntimeTree, sha256File,
  createBrowserRuntimeSourceReview, upstreamArtifactSha256, UPSTREAM_ARTIFACT_PROFILE,
  type BrowserRuntimeSourceTarget, type BrowserUpstreamArtifact } from "../packages/browser-runtime/src/index.js";

// Deliberate local preparation, never invoked by a model tool or at app startup.
// Downloads are acquired separately over HTTPS and must match these reviewed pins.
if (process.platform !== "darwin" || process.arch !== "arm64" || process.versions.node.split(".")[0] !== "22")
  throw new Error("Prepare the bundled browser on macOS ARM64 with Node 22");
const root = resolve("."), destination = resolve(process.argv[2] ?? "apps/desktop/runtime/browser-runtime");
const archive = resolve("data/browser-source/153.0.8010.52/chrome-headless-shell-mac-arm64.zip"), metadata = resolve("data/browser-source/153.0.8010.52/metadata.json");
const metadataSha256 = await sha256File(metadata);
if (metadataSha256 !== "3a1930e895405e1d40eef6851b7b77a3d4e88bd965c394eda38090fd2899fecd") throw new Error("Official revision metadata changed");
try { await lstat(destination); throw new Error("Destination exists; preparation never overwrites a browser installation"); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
await mkdir(resolve("apps/desktop/runtime"), { recursive: true });
const staging = await mkdtemp(resolve("apps/desktop/runtime/.browser-stage-"));
try {
  const target: BrowserRuntimeSourceTarget = { platform: "darwin", architecture: "arm64", archiveFormat: "zip",
    url: "https://storage.googleapis.com/chrome-for-testing-public/153.0.8010.52/mac-arm64/chrome-headless-shell-mac-arm64.zip",
    archiveBytes: 98786919, archiveSha256: "47fe02eae3a1b6e9ba298c7a8aea4ca1be87741ef8fa2da55b8a6f76d636e894",
    rootDirectory: "chrome-headless-shell-mac-arm64", executable: "chrome-headless-shell" };
  const extracted = await extractBrowserRuntimeSourceArchive({ target, archivePath: archive, destination: join(staging, "measure") });
  const upstream = JSON.parse(await readFile(metadata, "utf8"));
  if (upstream.version !== "153.0.8010.52" || upstream.revision !== "1681091"
    || !upstream.downloads?.["chrome-headless-shell"]?.some((entry: {platform: string; url: string}) => entry.platform === "mac-arm64" && entry.url === target.url))
    throw new Error("Official metadata does not describe this artifact");
  const version = `HeadlessChrome/${upstream.version}`, tree = await measureBrowserRuntimeTree(extracted.browserRootPath);
  const now = new Date().toISOString(), expires = new Date(Date.now() + 30 * 86400000).toISOString();
  const decision = await readFile(resolve("docs/browser-source-adoption.md"));
  const decisionSha256 = createHash("sha256").update(decision).digest("hex");
  const attestation: BrowserUpstreamArtifact = { format: 1, profile: UPSTREAM_ARTIFACT_PROFILE, createdAt: now,
    version, revision: upstream.revision, metadataUrl: "https://googlechromelabs.github.io/chrome-for-testing/153.0.8010.52.json", metadataSha256,
    target: { ...target, browserTreeSha256: tree.sha256 }, securityAssessmentSha256: decisionSha256, licenseReviewSha256: decisionSha256,
    assurance: "official-binary-adoption-not-reproducible-build" };
  const lock = { format: 1, profile: "traceforge-browser-runtime-source-lock-v1", sourceId: "google-official-headless-shell",
    version, revision: upstream.revision, createdAt: now, buildAttestationSha256: upstreamArtifactSha256(attestation),
    securityReviewRef: `sha256:${decisionSha256}`, licenseReviewRef: `sha256:${decisionSha256}`, targets: [target] };
  // This preparation makes a new adoption root. Private material is ephemeral,
  // never written to source, configuration, logs or a plaintext credential file.
  const pair = generateKeyPairSync("ed25519");
  const privateKeyPem = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const publicKeyPem = createPublicKey(privateKeyPem).export({ format: "pem", type: "spki" }).toString();
  const keyId = `project-browser-${createHash("sha256").update(publicKeyPem).digest("hex").slice(0, 16)}`;
  const authority = { format: 1, profile: "traceforge-browser-runtime-source-authority-v1", keyId, publicKeyPem,
    sourceIds: ["google-official-headless-shell"], validFrom: now, validUntil: expires, revokedAt: null };
  const review = createBrowserRuntimeSourceReview({ sourceLock: lock, keyId, privateKeyPem, issuedAt: now, expiresAt: expires });
  const bundle = join(staging, "bundle"); await mkdir(bundle);
  const controller = join(staging, "traceforge-browser-controller.mjs");
  execFileSync(resolve("node_modules/.bin/esbuild"), [resolve("packages/browser-runtime/src/controller-main.ts"), "--bundle", "--platform=node", "--target=node22", "--format=esm", `--outfile=${controller}`], { stdio: "pipe" });
  await assembleBrowserRuntimeRelease({ destination: join(bundle, "release"), controllerSource: controller, controllerVersion: "0.1.0-bundled",
    sourceLock: lock, sourceReview: review, sourceAuthority: authority, buildAttestation: attestation, sourceArchivePath: archive, platform: "darwin", architecture: "arm64" });
  await writeFile(join(bundle, "source-authority.json"), JSON.stringify(authority, null, 2));
  await writeFile(join(bundle, "ADOPTION.md"), decision);
  await cp(process.execPath, join(bundle, "node"), { errorOnExist: true, force: false }); await chmod(join(bundle, "node"), 0o755);
  const installation = { format: 1, platform: "darwin", architecture: "arm64", nodeSha256: await sha256File(join(bundle, "node")),
    expectedSandboxBackend: "traceforge-macos-native", expectedBackendMeasurement: await sha256File(join(root, "packages/execution-node/native/darwin-arm64/traceforge-macos-sandbox")),
    resources: { cpuTimeMs: 900000, memoryBytes: 2147483648, maximumProcesses: 64, writeBytes: 268435456 } };
  await writeFile(join(bundle, "installation.json"), JSON.stringify(installation, null, 2));
  await rename(bundle, destination);
  console.log(JSON.stringify({ destination, version, revision: upstream.revision, treeSha256: tree.sha256, assurance: attestation.assurance, expiresAt: expires }));
} finally { await rm(staging, { recursive: true, force: true }); }
