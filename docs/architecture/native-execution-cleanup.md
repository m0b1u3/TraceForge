# Native execution cleanup boundary

Linux helper implementation, local IPC reliability and acceptance gaps are documented separately in [local-native-execution-node.md](local-native-execution-node.md). The Linux Rust helper and fail-closed packaging path now exist; each supported platform still requires its own native audit and acceptance report before production use.

## Implemented contract

Windows helper protocol 4 requires `jobEmptyBarrier: true` and `atomicJobAssignment: true`. Protocol 2/3 binaries are rejected by the existing startup probe; rebuild the helper before deploying this controller. Version 4 also retains the control channel after target input EOF.

Both stdio and ConPTY execution retain a private, non-inheritable Job Object handle through cleanup. The helper checks `TerminateJobObject`, then polls accounting until `ActiveProcesses == 0`, with a five-second polling deadline. A failed termination request, failed query, or remaining members is an error, never completion. Job configuration does not enable breakaway. Error paths retain kill-on-close as a fallback, but that fallback alone is not a completion observation.

Both stdio and ConPTY use the job-list creation attribute. Stdio no longer has a create-then-assign window where watchdog termination could strand an unowned suspended child. Stdio still verifies the restricted token before resuming the thread. Resource monitor destruction stops and joins its thread before its job handle can close.

The ConPTY normal completion sequence is:

1. Wait for the root process, checking the wait result.
2. Terminate and observe the owned job as empty, before waiting for controller activity or draining output.
3. Invalidate the control thread's job reference, finish resource monitoring, close ConPTY, and join its output reader. Extra pipe endpoints are closed immediately after ConPTY creation so the output reader can reach EOF.
4. Reconfirm job emptiness in the owning caller, then finish profile cleanup.
5. Emit one completion frame and exit with the target's exit code.

The `0x83` completion payload is a signed 32-bit big-endian exit code followed by the 64 ASCII hex bytes supplied in `--execution-nonce`. LocalExecutionNode now generates and journals the random 256-bit launch identity before dispatch, and passes it to the ConPTY launcher as this nonce. Standalone launcher callers without that context still receive a random live-only nonce. The controller accepts completion only after the helper closes with a matching code, no signal/error, and no partial/trailing frame. A termination ACK still means only that the request was accepted. Callback replay registers errors and resource limits before exit so an already-buffered failure cannot become a successful runtime observation.

Linux helper protocol 2 now implements the same platform-neutral framed terminal transport over a real `openpty` session. The target becomes the session leader with a controlling terminal before entering the existing isolated filesystem and seccomp path. Input, resize, close-input and termination frames receive bounded acknowledgements; Ctrl-C travels as terminal input and is interpreted by the kernel terminal discipline. Output and resource-limit frames precede the nonce-bound completion frame. The helper still completes only after cgroup supervision reports the complete owned tree empty. This is production wiring, but its three new native PTY cases remain pending on a qualified Linux host; the earlier 16-case protocol-1 record cannot prove protocol 2.

## Host-side deadlines

Both shipped launchers use the shared watchdog. Trusted composition may configure positive timer-safe `ProcessWatchdogOptions`; these are not tool-supplied cleanup assertions.

| Stage | Default bound | Completion condition |
| --- | --- | --- |
| Launch policy preparation | 10 seconds | Resolver returns; late results never trigger dispatch |
| Startup after spawn | 10 seconds | PTY started frame; stdio OS spawn event (not target readiness) |
| Control/write/status operation | 5 seconds | Write callback and, for PTY, matching ACK; or adapter/status operation completes |
| Shutdown / pipe drain | 10 seconds from first shutdown signal | Actual transport close; PTY additionally requires its valid completion frame |
| Execution | Request `timeoutMs`, starting at spawn | Complete transport lifecycle within the budget |

The execution budget remains active through shutdown, so the earliest deadline wins. Termination, resource-limit frames, PTY completion, and OS exit start shutdown observation as applicable; repeated messages never extend it. PTY and stdio control writes have at most 64 concurrent tracked operations. Pipe write errors, close without drain, and cancellation settle pending writes and detach listeners. Normal completion clears timers; failure aborts every pending operation and clears timers once.

A watchdog failure reports an error first, attempts to kill only the owned child/helper handle, destroys local pipes, then terminates the local transport with null exit status. This null status is **not an observed OS exit or proof that descendants stopped**. Runtime records `failure_observed` with `cleanup=unverified`; startup failure leaves the pre-dispatch journal claim unresolved. Late close/completion cannot overwrite that outcome, and restart cannot replay the same durable key. Underlying policy/custom adapter promises are not magically cancelled; their late results are ignored. The watchdog requires a functioning host event loop and does not cover a dead host or blocked JavaScript thread.

## Durable identity and recovery

Execution Node protocol 1.8 records schema-2 observations with node ID, fresh node generation, launch identity, request ID and request fingerprint. The original invocation attribution and lease remain fixed. Claim persistence precedes launch; settlement cannot replace provenance. Schema-1 observations remain readable and fenced, but cannot be promoted into schema-2 proof by backfilling fields.

The process tool drains terminal event pages, including an already-terminal start response. Event loss, a stalled/regressing cursor, failed transport or null exit code throws into Gateway uncertainty; it does not become an ordinary completed failure receipt. A genuine nonzero process exit remains a normal failed result. This distinction prevents watchdog failure from prematurely releasing invocation protection.

The general recovery control and deployment-pinned Ed25519 evidence verifier are described in [execution-recovery.md](execution-recovery.md). They are wired at the foundation composition boundary, with authorization and trust absent by default. Neither the helper nor the controller signs local observations into recovery proof. Process-attestation delegation requires a deployment-owned platform acceptance reference and an explicit node allowlist; the configuration reference itself is not an automated platform certification.

### Local control-operation crash boundary

stdin writes, terminal resize, signals, termination and adoption each carry a stable caller-generated `operationId`. The node-local SQLite journal durably claims the complete operation identity before the managed-process effect and stores the response after that effect. A new local Execution Node host with the same node identity can therefore replay a completed response even though it has no resident copy of the old process. A claim-only entry is deliberately not retried: it reports an unconfirmed outcome and requires reconciliation, because a crash cannot prove whether the external effect occurred.

The foundation gate now exercises all five operations through the authenticated local pipe with a separate real Node host process and real WAL-backed SQLite. It sends `SIGKILL` at both durable boundaries: immediately after claim but before the deterministic managed-process adapter, and after completion is committed but before the RPC response is written. After each crash a fresh host reopens the same database. The first boundary preserves zero observed effects and stays unconfirmed; the second returns the committed response and preserves exactly one observed effect, including adoption-token rotation. The test adapter is intentionally not a native sandbox and does not count as Linux or Windows isolation acceptance; it establishes IPC, journal and restart semantics independently of a scenario or security tool.

Confirmed operation responses have a 24-hour default hot retention window and may then be gzip archived in bounded batches. Identity, observation digest and exact response replay remain available; claim-only records never enter compaction. Active records, total records, reserved bytes, individual response size and physical SQLite/WAL admission are bounded. The health summary exposes only aggregate capacity. Two additional real-host `SIGKILL` windows stop archival before transaction commit and after commit but before the caller continues; a fresh connection observes either the complete hot response or the complete digest-checked archive and passes SQLite integrity checking.

## What this does not establish

- The nonce can now be correlated with durable request/generation identity, but is not a signature or proof of helper authenticity. No built-in native cleanup attestor or signing endpoint is supplied, and no native trusted reconciliation authority is enabled by default.
- `ProcessExecutionObservation.cleanup` remains `unverified`, including when this helper completes. A missing record, helper crash, root PID disappearance, or completion frame cannot release uncertain invocation protection.
- Job emptiness concerns the owned job hierarchy. It does not undo prior effects or cover work delegated to external services/brokers. The full supported isolation boundary and inherited-handle exposure require Windows platform acceptance before making broader trust claims.
- Host-side watchdogs now bound caller waits, but do not prove native cleanup on expiry. Windows internal waits/profile cleanup can be interrupted, leaving recovery uncertain and possibly residual profile grants; Windows fault acceptance and durable cleanup receipts remain required.
- Stdio still exposes helper exit through its existing adapter, without a separate durable cleanup channel. It must not be promoted to a trusted proof based on its exit code.

## Verification

- `pnpm test:native-cleanup`: runs both native helper crates. The Windows crate retains six platform-independent state-machine tests and its Windows-only native cases; the Linux crate has nine parser/cleanup/configuration tests. Platform-independent tests do not replace either OS's native acceptance.
- `cargo check --locked --tests --target x86_64-pc-windows-gnu --manifest-path packages/windows-sandbox-helper/Cargo.toml`: Windows source/type checking from a configured cross host; does not link or run Windows code.
- `pnpm check:linux-sandbox`: checks the complete Linux-only source and test graph for `x86_64-unknown-linux-gnu`; on non-Linux it does not link or exercise kernel isolation.
- `pnpm test:foundation`: includes watchdog timer/listener tests, native-terminal transport faults, real blocked stdio writes/held output pipes, protocol probes, and failure persistence across SQLite reopen. The transport fixtures are real Node subprocesses, not Windows isolation tests.
- `pnpm test:foundation:execution-nodes`: additionally runs the five-operation, two-boundary local host `SIGKILL` matrix, the two archival transaction crash boundaries, and reopens the durable operation journal from a new host generation. The current suite is 7 files / 51 tests.
- `pnpm build:windows-sandbox`: Windows-only; runs native Rust tests before release build, copy, and probe. Failure prevents bundling.
- `pnpm build:linux-sandbox`: x64-Linux-only; requires an explicitly delegated cgroup v2 root, runs Rust tests, builds and bundles the helper, then exercises its real isolation probe. Linux desktop release construction and verification invoke the same fail-closed gate.

Remaining acceptance requires a real Windows host: restricted-token and AppContainer modes, both stdio and ConPTY, descendants retaining pipes, explicit termination, resource limits, controller/helper loss, profile-cleanup errors, and inherited-handle/broker boundaries. Durable identity and verification plumbing now exist; the actual native trusted attestor, independent cleanup-report channel and residual-profile recovery remain unimplemented. A deployment may only delegate process assertions after its attestor and platform boundary have been accepted.

Windows semantics consulted: [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects), [process creation attributes](https://learn.microsoft.com/en-us/windows/desktop/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute), and [ClosePseudoConsole](https://learn.microsoft.com/en-us/windows/console/closepseudoconsole). These APIs do not make job emptiness equivalent to absence of external effects.
