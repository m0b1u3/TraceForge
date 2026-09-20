# Application-owned browser material

**Historical standalone browser input, not the current desktop embedding.**
The desktop now uses its Electron Chromium engine and a sandboxed WebContentsView.
It neither reads nor ships this external tree. Prepared local material is retained
for standalone regression tests; the instructions below describe that earlier path.

The standalone resolver reads only `resources/browser-runtime`. It never searches
for Chrome or adopts a user's browser profile. Developer-only explicit deployment
configuration is not a packaged product fallback.

This directory is a build input, not a completed browser distribution. Following
the owner's 2026-09-20 approval, `scripts/prepare-bundled-browser.mts` prepares the
pinned macOS ARM64 Chrome Headless Shell with Node 22. Acquire the archive and version metadata from
the official URLs in `docs/browser-source-adoption.md` first. The script checks
both acquisition pins, safely extracts the tree, builds the controller, signs the
adoption lock with an ephemeral in-memory key, and installs only
to an absent destination. It does not download at app startup or claim a source
reproduction/security audit. The release gate stays closed.

Prepared `browser-runtime/` material:

- `installation.json`: strict format 1 metadata containing `platform`,
  `architecture`, `nodeSha256`, `expectedSandboxBackend`,
  `expectedBackendMeasurement`, and `resources` (`cpuTimeMs`, `memoryBytes`,
  `maximumProcesses`, `writeBytes`). There are no configurable executable paths.
- `node` (`node.exe` on Windows): the application-owned measured Node runtime.
- `source-authority.json`: the independent browser source authority, outside the
  release tree.
- `release/`: output of `assembleBrowserRuntimeRelease`, including the controller,
  browser tree, release manifest, signed adoption lock and explicit upstream
  artifact provenance, not a fabricated reproducible-build attestation.

The existing host verifier remains authoritative. Assembly metadata is not a
substitute for a valid source review or an OS sandbox measurement. Test fixtures
must never be placed here as product material. Do not create a nominal approval
signature just to satisfy the verifier.

Scratch and isolated profiles are created beneath application user data, not
inside resources or a normal Chrome profile. Browser redistribution, legal review,
signing/notarization and native acceptance remain separate release requirements.
The desktop release gate stays disabled until its acceptance requirements pass.

Desktop macOS now explicitly selects `isolation: chromium` in host assembly,
following the owner's decision: Chromium sandbox enabled, no outer macOS wrapper.
It retains verified material, private profiles, CDP request mediation and owned
process cleanup; it does not promise OS-denied network, per-task filesystem
isolation, or outer-backend CPU/memory enforcement. The metadata's legacy Node,
controller and backend measurements remain checked material for the explicit
outer-sandbox deployment; they are not execution proofs for this desktop mode.
Read `docs/browser-source-adoption.md` for the precise boundary.
