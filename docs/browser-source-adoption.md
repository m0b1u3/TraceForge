# Official browser binary adoption — 2026-09-20

## Current desktop: Electron-owned Chromium view

The desktop now uses `WebContentsView` from the locked Electron dependency
(37.10.3), with Chromium renderer sandboxing and no guest Node integration or
preload. It does not load the Headless Shell tree below. `electron_debugger`
identifies the page-scoped control channel; the version-derived identity hash
is a build identifier, not a measured executable digest or independent source audit.
The desktop package no longer copies the unused external browser tree.
Electron/Chromium security maintenance and signed distribution acceptance remain
release requirements; this embedding change does not establish either.

## Historical standalone material: official Headless Shell

The full Chromium snapshot below aborts in macOS application registration under
the existing outer sandbox. It is not the selected runtime. The preceding standalone experiment
selected Google's official Chrome Headless Shell `153.0.8010.52`, revision
`1681091`, listed in the upstream Stable channel on the acquisition date. This is
the standalone Chromium/Blink engine with application-owned presentation, not an
installed user Chrome or a native browser window embedded into Electron.

Official metadata: https://googlechromelabs.github.io/chrome-for-testing/153.0.8010.52.json
Official artifact: https://storage.googleapis.com/chrome-for-testing-public/153.0.8010.52/mac-arm64/chrome-headless-shell-mac-arm64.zip
Archive: 98786919 bytes, SHA-256
`47fe02eae3a1b6e9ba298c7a8aea4ca1be87741ef8fa2da55b8a6f76d636e894`.
Metadata SHA-256: `3a1930e895405e1d40eef6851b7b77a3d4e88bd965c394eda38090fd2899fecd`.

Keep `LICENSE.headless_shell`, ABOUT and the complete upstream tree. Upstream
positions these binaries for automation/testing, not a claim of safety for hostile
pages. Our external content remains untrusted. Product security and redistribution acceptance are
not established by choosing a Stable-channel artifact.

## Rejected full-snapshot experiment

The project owner explicitly approved using an official Chromium distribution
and establishing project-owned source verification in this task. This record is
an adoption decision, **not** an independent browser security audit or legal opinion.

Source: Chromium's official download instructions at
https://www.chromium.org/getting-involved/download-chromium/ link to the
`commondatastorage.googleapis.com/chromium-browser-snapshots` bucket.
Selected macOS ARM64 revision: `1701457`; upstream commit recorded in REVISIONS:
`465958ae2e20ea0a650a163ce4ca42fc5e80350c`.

The archive was retrieved over HTTPS from that official bucket and pinned to
SHA-256 `240a84649b57b0d12c293a7dafb59fa3c202bd9f5eb993c74768a15bf3eb7952`
(174576502 bytes). REVISIONS SHA-256:
`d6e368baf361d3a94102ea140d8d7fce16605cf26e409e27c295e3b5870ff191`.
These are locally measured acquisition pins, not upstream detached signatures.

Official snapshots are best-effort builds, not supported stable Chrome releases;
they do not auto-update. No independent source reproduction, SBOM audit,
notarization, or absence-of-vulnerabilities claim is made. The separate upstream
artifact profile must never masquerade as the reproducible-build profile.
The project adoption signature binds the lock and this decision; it does not
turn the upstream binary into a Google-signed provenance statement.

Keep all bundled notices and licenses intact. Chromium and included third-party
components have separate notices; this development adoption is not clearance to
redistribute every component in a public installer. Public distribution retains
the existing legal/signing/native-acceptance gates. Do not replace these gaps with
dummy document digests or automatically disable Gatekeeper.

## Owner-selected Chromium-only isolation

On 2026-09-20 the owner explicitly selected Chromium's own sandbox without the
outer macOS execution sandbox for the application-owned browser. No `--no-sandbox`
flag is added. This does not relax terminal, script or MCP execution policies.
The browser-specific host lifecycle port is only supplied by the verified
installation, consumes one prepared launch, and is not a general process launcher.
The browser uses a private profile and CDP pipes; no user Chrome/profile is adopted.

This mode does **not** claim OS-denied networking or per-task filesystem isolation
for the privileged Chromium browser process. CDP intercepts supported page requests
for per-request authorization and broker receipts; it is application mediation,
not a kernel network firewall or a guarantee that every browser-internal protocol
has been intercepted. Chromium's renderer sandbox is retained, but compromise of
its privileged browser process has the app user's access. Resource CPU/memory
quotas from the outer execution backend are not enforced in this mode. A host
deadline, control-pipe ownership and process-group termination govern its lifetime.
Unknown termination preserves scratch and occupancy for later reconciliation.

Release material identity is still verified before launch. The in-process CDP
adapter belongs to the application build, not the separate bundled controller
executable; no separate-controller execution attestation is claimed in this mode.
The original outer-sandbox mode remains explicit for deployments which select it;
failure never triggers automatic fallback between isolation modes.

Runtime requirements remain: per-request broker authorization, no arbitrary
renderer HTML/JS, explicit manual ownership, bounded input, and
stop/revocation/unknown-result cleanup. Review and replace
the pinned build as a deliberate development operation; do not create an automatic
desktop updater or fall back to a user's normal Chrome installation.
