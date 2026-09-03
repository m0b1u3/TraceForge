# Linux native validation: Ubuntu 24.04 x64

> 历史证明状态：下列结果对应 helper 协议 1 和当时的 16 类矩阵。当前源码已经提升到协议 2，并加入 framed PTY，使矩阵扩为 19 类；协议 2 尚未在该 Linux 主机重跑，因此本页不能作为当前 PTY 的实机验收证明。旧结果保留用于追溯，发布当前协议前必须生成新的 helper 摘要并通过全部 19 类门禁。

- Validation date: 2026-09-02
- Architecture: `x86_64`
- Distribution: Ubuntu 24.04.4 LTS
- Kernel: `6.8.0-137-generic`
- Init/cgroup manager: systemd 255, cgroup v2
- Delegated controllers: cpu, io, memory, pids (cpuset was present but not required)
- Service identity: dedicated non-root account with `Delegate=yes`
- AppArmor: enabled; `kernel.apparmor_restrict_unprivileged_userns=1` remained enabled
- Helper attachment: `/usr/lib/traceforge/traceforge-linux-sandbox`
- Validated helper SHA-256: `00582fb1a0fbe4f6880cb270eb6680affcca679a08a4cbd7599f26048a57b5e6`

## Passed evidence

The release helper compiled offline with Rust 1.88.0 and passed 9 Linux-native Rust tests. The native acceptance runner passed 16 cases:

1. namespace/cgroup/seccomp probe;
2. approved filesystem read/write, deny masking, and environment allow-listing;
3. rejection of an absolute symlink attempting to turn a writable tree into a host `/usr/bin` write;
4. denied external networking;
5. seccomp rejection of namespace/remount escape;
6. orphaned descendant cleanup after root exit;
7. CPU-time termination and durable `cpu_time` reason;
8. OOM termination and durable `memory` reason;
9. process-count termination and durable `process_count` reason;
10. write-I/O termination and durable `write_bytes` reason;
11. fail-closed rejection of an unsupported direct network mode;
12. fail-closed rejection of a non-cgroup runtime root;
13. actual helper `SIGKILL`, target tree reaching `pids.current == 0`, and exclusive startup recovery removing exactly one owned cgroup and one owned scratch tree.
14. overlapping read/write grants with a nested deny remaining masked;
15. fail-closed rejection of a symlinked, non-canonical policy root;
16. actual Execution Node parent-process `SIGKILL`, propagation through helper `PDEATHSIG` to the target tree, and exact restart recovery of one cgroup and one scratch tree.

Final inspection found zero active `traceforge-execution-*` cgroups and zero `run-execution-*` trees in the configured scratch root. The AppArmor profile remained loaded and the global Ubuntu user-namespace restriction remained enabled.

## Findings fixed during validation

- Removed an invalid comparison with the host parent PID from inside a new PID namespace, where the namespace init correctly observes `getppid() == 0`.
- Recreated safe relative top-level runtime aliases (`/bin`, `/sbin`, `/lib`, `/lib64`) required by merged-`/usr` distributions inside the tmpfs root.
- Moved cgroup event baselines before `clone3`, preventing fast targets from consuming their own initial limit event.
- Fixed multi-line cgroup field lookup so `oom_kill` is read beyond the first `memory.events` row.
- Added bounded SIGKILL accounting settlement and exclusive crash-residue recovery.

## Scope boundary

This is a reproducible engineering validation record, not an independently signed production attestation. It proves this exact Ubuntu/kernel/architecture/helper combination only. A second distribution/kernel, Linux aarch64, full production-service/database restart composition, unsupported-syscall/old-kernel denial, and broader path fuzzing remain open acceptance work.
