# Linux sandbox helper deployment

The native helper is a trusted deployment component. Install the release binary at the exact root-owned path used by the AppArmor attachment:

```sh
install -d -o root -g root -m 0755 /usr/lib/traceforge
install -o root -g root -m 0755 traceforge-linux-sandbox /usr/lib/traceforge/traceforge-linux-sandbox
install -o root -g root -m 0644 packaging/apparmor/usr.lib.traceforge.traceforge-linux-sandbox /etc/apparmor.d/usr.lib.traceforge.traceforge-linux-sandbox
apparmor_parser -r /etc/apparmor.d/usr.lib.traceforge.traceforge-linux-sandbox
```

Ubuntu 24.04 restricts unprivileged user namespaces by default. The supplied profile grants `userns` only to the fixed helper path; do not disable `kernel.apparmor_restrict_unprivileged_userns` globally.

The Execution Node service must run as a dedicated unprivileged account in a systemd unit with `Delegate=yes`. Before starting Node, its launcher must:

1. create a `supervisor` child below the service cgroup;
2. move itself into that child by writing `0` to `supervisor/cgroup.procs`;
3. enable `+cpu +io +memory +pids` in the service cgroup's `cgroup.subtree_control`;
4. export the service cgroup as `TRACEFORGE_LINUX_CGROUP_ROOT`, a private directory owned by the service account as `TRACEFORGE_LINUX_SANDBOX_SCRATCH_ROOT`, and the fixed helper path as `TRACEFORGE_LINUX_SANDBOX_HELPER`;
5. execute the TraceForge service without returning to the cgroup root.

At service startup TraceForge runs the helper's exclusive `recover` operation before `probe`. Recovery only recognizes `traceforge-execution-*` cgroups and their `run-execution-*` scratch trees. It kills any surviving owned process tree, waits for `pids.current == 0`, and removes owned residue. A recovery failure keeps process execution disabled.

Build/release validation must run inside the same delegated topology:

```sh
pnpm build:linux-sandbox
```

That command runs Rust tests, builds the release helper, executes its real probe, and runs the native acceptance matrix. Changing the binary or AppArmor attachment path requires a new platform acceptance and deployment measurement; rollback must restore the matching binary, profile, and recorded SHA-256 together.
