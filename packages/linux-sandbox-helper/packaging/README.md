# Linux sandbox helper deployment

The supported Linux Desktop distribution is the DEB package. Its lifecycle hooks install the native helper and matching release manifest at a fixed root-owned path, load the narrow AppArmor attachment and install `/usr/bin/traceforge` as the desktop launcher. A portable/direct launch may open the application, but Sandboxed Process remains unavailable because it has no proof that the host policy was installed.

The equivalent manual helper/Profile installation is:

```sh
install -d -o root -g root -m 0755 /usr/lib/traceforge
install -o root -g root -m 0755 traceforge-linux-sandbox /usr/lib/traceforge/traceforge-linux-sandbox
install -o root -g root -m 0644 release.json /usr/lib/traceforge/release.json
install -o root -g root -m 0644 packaging/apparmor/usr.lib.traceforge.traceforge-linux-sandbox /etc/apparmor.d/usr.lib.traceforge.traceforge-linux-sandbox
apparmor_parser -r /etc/apparmor.d/usr.lib.traceforge.traceforge-linux-sandbox
```

Ubuntu 24.04 restricts unprivileged user namespaces by default. The supplied profile grants `userns` only to the fixed helper path; do not disable `kernel.apparmor_restrict_unprivileged_userns` globally.

TraceForge is a single-user local Desktop product. The launcher therefore runs as the signed-in unprivileged user inside a transient systemd **user scope** with `Delegate=yes`; it does not create a product user, remote node or system daemon. Before starting the Desktop process, the launcher:

1. create a `supervisor` child below the service cgroup;
2. move itself into that child by writing `0` to `supervisor/cgroup.procs`;
3. enable `+cpu +io +memory +pids` in the service cgroup's `cgroup.subtree_control`;
4. exports the scope cgroup as `TRACEFORGE_LINUX_CGROUP_ROOT`, a mode-0700 per-user state directory as `TRACEFORGE_LINUX_SANDBOX_SCRATCH_ROOT`, and the fixed helper/manifest paths;
5. execute the TraceForge service without returning to the cgroup root.

At service startup TraceForge runs the helper's exclusive `recover` operation before `probe`. Recovery only recognizes `traceforge-execution-*` cgroups and their `run-execution-*` scratch trees. It kills any surviving owned process tree, waits for `pids.current == 0`, and removes owned residue. A recovery failure keeps process execution disabled.

Install and upgrade replace the helper/manifest together, then load AppArmor. If any installation step fails, the hook restores the previous helper, manifest, Profile and launcher. Uninstall unloads and removes these system-owned assets; it does not delete user data. No script disables AppArmor or changes a global user-namespace sysctl.

Repository-only validation, which does not claim kernel enforcement, is available on any development host:

```sh
pnpm verify:linux-deployment-assets
```

Build/release validation must run on real x64 Linux inside the same delegated topology:

```sh
pnpm build:linux-sandbox
```

That command runs Rust tests, builds the release helper, executes its real probe, and runs the 19-class native protocol-2 acceptance matrix. Changing the binary, launcher, cgroup topology or AppArmor attachment path requires a new platform acceptance and deployment measurement. Repository checks alone never change the platform status to production-ready.
