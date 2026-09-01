# Native execution cleanup boundary

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

Execution Node protocol 1.6 records schema-2 observations with node ID, fresh node generation, launch identity, request ID and request fingerprint. The original invocation attribution and lease remain fixed. Claim persistence precedes launch; settlement cannot replace provenance. Schema-1 observations remain readable and fenced, but cannot be promoted into schema-2 proof by backfilling fields.

The process tool drains terminal event pages, including an already-terminal start response. Event loss, a stalled/regressing cursor, failed transport or null exit code throws into Gateway uncertainty; it does not become an ordinary completed failure receipt. A genuine nonzero process exit remains a normal failed result. This distinction prevents watchdog failure from prematurely releasing invocation protection.

The general recovery control and deployment-pinned Ed25519 evidence verifier are described in [execution-recovery.md](execution-recovery.md). They are wired at the foundation composition boundary, with authorization and trust absent by default. Neither the helper nor the controller signs local observations into recovery proof. Process-attestation delegation requires a deployment-owned platform acceptance reference and an explicit node allowlist; the configuration reference itself is not an automated platform certification.

## What this does not establish

- The nonce can now be correlated with durable request/generation identity, but is not a signature or proof of helper authenticity. No built-in native cleanup attestor or signing endpoint is supplied, and no native trusted reconciliation authority is enabled by default.
- `ProcessExecutionObservation.cleanup` remains `unverified`, including when this helper completes. A missing record, helper crash, root PID disappearance, or completion frame cannot release uncertain invocation protection.
- Job emptiness concerns the owned job hierarchy. It does not undo prior effects or cover work delegated to external services/brokers. The full supported isolation boundary and inherited-handle exposure require Windows platform acceptance before making broader trust claims.
- Host-side watchdogs now bound caller waits, but do not prove native cleanup on expiry. Windows internal waits/profile cleanup can be interrupted, leaving recovery uncertain and possibly residual profile grants; Windows fault acceptance and durable cleanup receipts remain required.
- Stdio still exposes helper exit through its existing adapter, without a separate durable cleanup channel. It must not be promoted to a trusted proof based on its exit code.

## Verification

- `pnpm test:native-cleanup`: six platform-independent Rust state-machine tests. On Windows it also runs three native tests, including a root process that exits while its child remains in the job and verification of stdio job membership before resume. The two ignored Rust cases are subprocess fixtures, not skipped acceptance tests.
- `cargo check --locked --tests --target x86_64-pc-windows-gnu --manifest-path packages/windows-sandbox-helper/Cargo.toml`: Windows source/type checking from a configured cross host; does not link or run Windows code.
- `pnpm test:foundation`: includes watchdog timer/listener tests, native-terminal transport faults, real blocked stdio writes/held output pipes, protocol probes, and failure persistence across SQLite reopen. The transport fixtures are real Node subprocesses, not Windows isolation tests.
- `pnpm build:windows-sandbox`: Windows-only; runs native Rust tests before release build, copy, and probe. Failure prevents bundling.

Remaining acceptance requires a real Windows host: restricted-token and AppContainer modes, both stdio and ConPTY, descendants retaining pipes, explicit termination, resource limits, controller/helper loss, profile-cleanup errors, and inherited-handle/broker boundaries. Durable identity and verification plumbing now exist; the actual native trusted attestor, independent cleanup-report channel and residual-profile recovery remain unimplemented. A deployment may only delegate process assertions after its attestor and platform boundary have been accepted.

Windows semantics consulted: [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects), [process creation attributes](https://learn.microsoft.com/en-us/windows/desktop/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute), and [ClosePseudoConsole](https://learn.microsoft.com/en-us/windows/console/closepseudoconsole). These APIs do not make job emptiness equivalent to absence of external effects.
