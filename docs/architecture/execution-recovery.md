# Execution recovery control

This foundation milestone joins process observations, invocation reconciliation and authorized Work retry. It introduces no scenario policy, UI, automatic background retry or general claim of native sandbox acceptance.

## Outcome rules

| Situation | Durable outcome | May create a replacement Work? |
| --- | --- | --- |
| Process timeout, incomplete events, failed transport or unknown exit | Invocation remains uncertain; no ordinary receipt | No |
| Independently verified result | Receipt and reconciliation audit committed atomically | No whole-Work rerun |
| Independently verified absence of external effects | Invocation released with immutable reconciliation audit | Only through separate, current Work retry authorization and revision checks |
| Reconciliation succeeded but retry denied/conflicted | Reconciliation remains committed; retry rejection audited | No |
| Host dies between committed stages | Immutable command can be explicitly resumed | Committed stages replay; at most one replacement |

Cleaning an owned process tree does not prove absence of prior or delegated effects. A `confirmed_no_effect` attestor must establish both the outcome and the required cleanup condition. A successful result does not mean a security finding is verified; the evidence/lifecycle requirements remain unchanged.

## Evidence contract and deployment trust

`SignedToolRecoveryEvidenceVerifier` accepts strict `traceforge.invocation-recovery.v1` envelopes. Ed25519 covers canonical JSON of the format, key ID, assertion and optional process provenance; signature encoding must be canonical base64. Assertions include exact tool/source/version/contract hash, invocation/input identity, Case/Run/Work, original execution owner/lease, outcome, result hash, cleanup status/reference, issuance and expiry.

The foundation accepts an optional `toolRecoveryEvidenceAuthority(keyId)` resolver. Authorities are supplied by trusted deployment composition, never request bodies. Each pins a public key, exact sources, validity interval, maximum evidence age/lifetime and optional revocation. Non-process assertions require explicit `allowNonProcess`. Process assertions additionally require accepted node IDs and a nonempty platform acceptance reference. This reference records a deployment decision; it does not run or certify platform tests.

Observed processes require schema-2 durable provenance matching the signed request/launch identity. Missing or legacy records cannot establish process cleanup. No HTTP signer, private-key endpoint or automatic conversion of timeout/close events into proof exists. The separate reconciliation authorizer and Work retry authorizer remain required. With no deployment configuration, recovery is denied. A custom reconciliation verifier remains an explicit alternative trust boundary.

Verified envelopes are stored immutably under `recovery-evidence:<sha256>`; the audit references that object. A later verification using `{ "evidenceRef": "recovery-evidence:..." }` reloads and revalidates signature, current authority/revocation, time and ownership. Replaying an already-committed command returns its historical decision without reversing it when a key later expires; any new action still goes through its own authorization. Evidence is limited to 64 KiB and a recovery request to 512 KiB. Raw evidence must not contain secrets; it is retained as audit material, not supplied to model context.

## Unified control API

- `GET /api/security-tools/invocations/:idempotencyKey/recovery`: redacted execution/provenance/status view, without raw outputs, result bodies, credentials or signatures. At most 100 command summaries are returned, ordered oldest first; this is not a complete history/export API.
- `POST /api/security-tools/invocations/:idempotencyKey/recover`: body contains `commandId`, `actor`, `reason`, `resolution`, `evidence`, optional `result`, and optional `retry: { expectedRevision }`. Retry is allowed only with `confirmed_no_effect`.
- `POST /api/security-tools/recovery/commands/:commandId/resume`: body `{ "actor": "original actor" }` explicitly resumes the exact stored command. Actor labels are not credentials: deployment authorizers must bind them to authenticated identity.

The command is registered immutably before awaiting a stage. Deterministic subcommand IDs bind reconciliation and retry to their existing independent transactions. A repeated ID with different input is rejected. A denied stage is a durable decision, not a transient instruction to retry forever. If retry conflicts because state/revision changed, inspect the result and issue a new authorized Work retry command with the correct revision; the API never silently substitutes the latest revision. `retry_blocked` is an explicit structured recovery outcome even when the HTTP recovery request returns 200.

No recovery worker polls pending commands automatically. A command registered just before a crash is resumed explicitly and authorized when its unfinished stage executes. Reconciliation plus retry is a durable multi-stage operation, not one database transaction: a rejected retry does not undo a verified reconciliation.

## Process cancellation and history capacity (2026-08-30)

The process adapter consumes the Gateway's local AbortSignal. Cancellation issues one force-termination request for the owned process; a late start response is also cleaned up without sending stdin. The adapter stops awaiting normal results, while cleanup waits at most five seconds. Errors and cancellation never manufacture a receipt or a cleanup attestation. Gateway uncertainty remains fenced. This is the tool-timeout bridge, not yet a complete Run-cancel/ownership-revocation bus. Event consumption verifies process identity, consecutive sequence numbers, canonical base64, byte counts and the requested aggregate output limit.

LocalExecutionNode defaults to 128 resident process records, counting concurrent starts against admission. Under pressure it evicts only terminal records successfully persisted to the journal, with no active waiters, after a 60-second grace period. Without a journal, or after settlement failure, it refuses new work instead of erasing the only record. Each start request is limited to 128 KiB of JSON; each process accepts at most 64 simultaneous event waiters. These bounds do not prove OS process-tree cleanup and do not change Invocation ownership.

The SQLite journal defaults to 10,000 permanent keys and 512 MiB of logical JSON accounting. Each claim reserves 8 MiB before dispatch; settlement replaces the reservation with the actual observation size. An oversized observation or failed write leaves the original claim protected. Migration preserves old data and conservatively charges unresolved legacy observations. The limits are journal accounting, **not** a filesystem quota or a limit on SQLite/WAL, receipts, commands or evidence. Reaching the permanent-key limit still stops new execution after the controlled archive described below; archiving does not erase identities.

Before each new claim, maintenance checks at most 32 candidate records. Only matching completed bindings/executions with a validated receipt and a default 24-hour completed retention period may lose their event copy. The observation retains its identity, launch provenance, descriptor, original observation SHA-256 and purge time, with `lostEvents=true`. Receipts, evidence, commands and execution keys are untouched. A post-eviction or post-restart request using an old key is rejected by the durable claim. Purging cannot resolve uncertainty or authorize retry. Failed compaction is transactional and blocks dispatch.

`GET /api/security-tools/execution-history?caseId=...&runId=...&limit=50&after=...` returns scoped summaries and journal capacity. The page maximum is 100; `nextCursor` is a keyset cursor, not a snapshot/export guarantee under concurrent insertion. Entries exclude output, executable/arguments, filesystem paths and credentials. Deployment authentication remains the host API boundary. Existing single-invocation inspection also exposes purge metadata. Journal entries without an Invocation binding are retained but omitted from this invocation-scoped history.

## Unified execution/recovery storage admission (2026-08-30)

`createDb` installs `db/execution-storage.ts` before admitting Workers or controls. Persisted policies, permanent per-key accounting entries and incremental usage counters share the transactions of their source records. AFTER INSERT/UPDATE triggers cover normal receipts, trusted result backfill, process observations and recovery control writes. Quota failures roll back both data and counters. Duplicate `INSERT OR IGNORE` does not change accounting; destructive deletion and `INSERT OR REPLACE` replacement are rejected. Host schema/policy administration remains a trusted boundary; there is no HTTP quota-mutation endpoint.

| Store | Key limit | Logical byte limit | Single-entry/reservation limit |
| --- | ---: | ---: | ---: |
| Tool receipts | 100,000 | 512 MiB | 8 MiB |
| Process journal | 10,000 | 512 MiB | 8 MiB (journal budget) |
| Recovery commands | 50,000 | 128 MiB | 513 KiB including metadata; request body remains 512 KiB |
| Signed recovery evidence | 50,000 | 128 MiB | 65 KiB including metadata; envelope remains 64 KiB |
| Reconciliation audits | 50,000 | 128 MiB | 64 KiB |
| Work retry/continuation audits (shared ledger) | 50,000 | 128 MiB | 64 KiB |
| Worker checkpoints | 100,000 | 512 MiB | 1,025 KiB including metadata; document remains 1 MiB |

Process and receipt storage share a 1 GiB execution pool. The four recovery stores share a separate 512 MiB recovery pool, so execution growth cannot consume that pool's allowance. Recovery itself may still exhaust its own capacity. Logical accounting includes serialized source text fields (or the existing journal reservation), not SQLite/index/ledger/WAL overhead, Artifact files, Vault secrets or all other database tables. New accounting keys are limited to 1,024 UTF-8 bytes. Permanent-key counts also bound zero-payload tombstones.

Production checkpoint writes now use a third, independent 512 MiB pool. Cold records and archive command audits share a separate
1 GiB / 200,000-record budget, described below. None of these allowances guarantees free filesystem space.

Invocation `beginExecution` reserves receipt capacity atomically with execution ownership, before tool dispatch. A failed reservation leaves the invocation prepared. Result persistence consumes the reservation using actual stored size; later admission pressure does not invalidate already-reserved room. Uncertainty, timeout and write failure retain reservations. Only committed, independently authorized no-effect reconciliation with its audit can reduce the receipt reservation to a zero-payload permanent tombstone. A later receipt write to that released key is rejected.

Migration preserves historical oversized records and conservatively accounts for unresolved/legacy invocations. Existing verified no-effect records keep their zero-payload keys. Source data and counters recover in the same SQLite transaction after interruption; opening the database again does not reset quotas. This logical reservation is not a guarantee that physical disk writes cannot fail.

Evidence persistence failures are propagated as storage failures rather than permanent evidence rejections. A full reconciliation-audit store rolls back result backfill and ownership changes; a full retry-audit store rolls back replacement Work/events. Recovery commands remain explicitly resumable after capacity is restored, with already-committed stages replayed. Relevant recovery endpoints use 507 for capacity exhaustion and 503 for recognized transient storage failures. A failed/denied authorization still has its existing security meaning. Optional undefined request fields are normalized to JSON before immutable command registration, keeping registration and replay fingerprints identical.

New read-only endpoints:

- `GET /api/security-tools/storage`: seven-store and three-pool usage, separate cold-archive usage, persisted limits and reservation counts; no payloads.
- `GET /api/security-tools/recovery/commands?caseId=...&runId=...&limit=50&after=...`: command/stage summaries without raw requests, results or signatures.
- `GET /api/security-tools/invocations/reconciliations?limit=50&after=...&idempotencyKey=...`: existing audit view with bounded keyset pagination. Default 50, maximum 100; `listAudits` compatibility helper is capped at 100.

Cursor ordering is by immutable command ID, not creation time, and is not a snapshot/export guarantee while other commands are being inserted. Existing per-invocation recovery inspection remains compatible. Deployment authentication is unchanged.

## Exact checkpoint recovery and authorized continuation (2026-08-31)

Before dispatch, Worker Runtime commits a v2 checkpoint containing the exact invocation and JSON input, tool-contract fingerprint,
Case/Run/Work/work-key identity, completed invocation IDs and consecutive failure count. `turn` counts committed turns; a pending
invocation belongs to `turn + 1`. Pending, approval and result checkpoints have distinct command identities scoped to the lease.
Failure before the pending checkpoint commits prevents dispatch. Failure after the receipt commits leaves the old pending reference usable.

Checkpoint references are content addressed (`checkpoint://sha256-<digest>.json`), with a 1 MiB document limit. Production Workers and
explicit continuation now use `SqliteWorkerCheckpointStore`: immutable snapshot insertion and aggregate quota admission are transactional,
and duplicate saves reuse the same reference without additional accounting. Original references work before and after cold archive.
Digest, shape, attribution and lossless JSON input are checked when restoring. Checkpoint storage remains a trusted host boundary,
not a signed remote checkpoint-import channel.

The older `JsonFileCheckpointStore` still provides private files, file sync and atomic rename (plus directory sync on POSIX), but production
uses it only as a read fallback: shared historical root and, for the original Worker, its legacy worker-specific root. Explicit continuation
can use shared historical v2 snapshots; v1 still cannot authorize continuation. No new production snapshot files are written. Existing files
and crash-left temporary files are not automatically imported, counted by the new pool or deleted. Independently authorized consolidation
of verified shared-root v2 files and complete writer temporary files is now available; v1/unknown/partial files remain intact.
See [storage-reliability.md](storage-reliability.md). Windows directory/power-loss durability has not been certified.

On recovery the binding ledger must be fully represented by completed IDs or the one pending invocation (at most 10,000 bindings per Work
are examined). Missing/unrepresented receipts or binding/identity/contract disagreement blocks the Work before another model decision.
Pending recovery does not ask the model or Observer to recreate an action:

- A validated receipt is restored and its invocation completion bookkeeping repaired, without calling the provider, even if that provider is no longer available.
- A committed independent no-effect reconciliation marks the old invocation processed while keeping its key fenced. The transcript cites
  the reconciliation audit; no synthetic durable tool receipt is inserted.
- A proven never-started invocation may execute the saved input under current permissions/approval and the exact saved tool contract.
  Gateway checks the expected contract again after checkpoint commit, before binding/dispatch.
- Any unresolved execution remains blocked. Existing approval resume uses the same pending input and does not ask the model to regenerate it.

`POST /api/scenarios/runs/:runId/work/:workId/continue` accepts `commandId`, `actor`, `reason`, `expectedRevision` and `checkpointRef`.
The separate deployment `workContinuationAuthorizer` receives the Run and exact checkpoint reference; default is denial. Actor strings
are not authentication. This endpoint is distinct from recovery-command `/resume` and whole-Work `/retry`.

The control requires a matching immutable v2 checkpoint, no active lease, no pending approval/replacement Work and available execution
budget. The generic Core `continue_work` transition queues the same blocked/failed Work in its current phase without resetting its
idempotency key, grants, results or attempt/turn/failure budgets. Claim must use a lease identity never previously claimed in this Run.
The only binding reopened is the exact pending binding whose execution ledger still proves `prepared`; uncertainty cannot be reopened.
Validation, binding reopening, event and immutable audit commit in one transaction. Audits reuse `scenario_work_retry_audits` and the
bounded `retry` storage policy, with `operation=continue` included in the request fingerprint; a command cannot be reused across retry and
continuation. Quota/recognized I/O failure rolls back admission and remains retryable using the same request; committed requests replay
their historical audit without requeueing Work. HTTP uses 507 for logical capacity and 503 for recognized storage I/O failures.

Legacy v1 checkpoints remain readable, but cannot authorize this explicit continuation API. Automatic legacy restore is subject to the
same ledger-completeness gate; missing pending actions are not guessed. Exhausted runtime budgets are not extended by continuation.
This guarantees replay discipline for recorded invocation identities, not semantic exactly-once behavior for a later model decision using a new ID.

## Controlled execution archive and original-reference readback (2026-08-31)

`ExecutionArchiveControl` archives receipts, process observations, recovery commands, signed evidence, reconciliation audits,
retry/continuation audits and SQLite checkpoints. This is compressed cold storage **inside the same SQLite database**, not off-host
backup, filesystem quota or database shrinking. Entire source rows are preserved in versioned envelopes with their original field strings.
Source identity and metadata remain in place; large fields become digest references. Permanent source/accounting keys are never removed.

- `POST /api/security-tools/storage/archive`: strict command/actor/reason, Case/Run, expected revision and 1–32 distinct kind/key pairs.
- `GET /api/security-tools/storage/archive-candidates?caseId=...&runId=...&kind=...&after=...&limit=50`: unarchived keys and current revision.
- `GET /api/security-tools/storage/archives?caseId=...&runId=...&after=...&limit=50`: command outcomes, entry keys and byte summaries.

Both listings use keyset pagination capped at 100 and omit original payloads. Candidates are advisory; write admission repeats checks.
Deployment authentication still protects these endpoints. The separate `executionArchiveAuthorizer` defaults to denial; authorization
reference and expiry are required. An actor string cannot grant authority. Successful prior commands replay their historical audit and
verify their original records, without invoking the authorizer for a new mutation. A reused command ID with different input conflicts.

Admission requires the exact Case/Run/revision, completed or cancelled Run, a default 24-hour terminal retention interval, no active lease
and no unresolved or missing invocation execution ledger. Each selected record must belong to a Work in that Run. Receipt schema,
process integrity, evidence/checkpoint content hashes and recovery command integrity/stage completion are checked as applicable.
Unfinished recovery commands and claimed processes cannot be archived. Archive does not establish evidence trust or validate a Finding.

One SQLite transaction compresses and verifies the original rows, writes cold blobs, changes hot projections, updates existing hot usage
and inserts the immutable command audit. A private connection-local, exact-kind/key scope permits only the archive operation to rewrite
otherwise immutable source fields. Archived source rows, cold blobs, audits and permanent keys reject update, delete or replacement.
Trusted schema/policy administration is outside this fence; there is no HTTP bypass or delete endpoint. Connections register the archive
SQLite function before migrations, including on restart.

Each decoded envelope and the batch's source-row input are bounded at 16 MiB; archive command audits at 64 KiB. Cold blobs and audits
share incremental byte/record accounting (default 1 GiB and 200,000 records). Capacity or recognized transient storage failure rolls back
the whole batch and returns 507/503 without recording a permanent rejection; the exact command may be explicitly retried after recovery.
Permanent key counts remain charged, including after archival; cold capacity itself can also be exhausted.

Existing receipt, journal, evidence, command, retry/continuation and checkpoint readers transparently hydrate original rows. Readback
checks bounded decompression, SHA-256, envelope identity and exact source projection. Missing or corrupt cold data fails closed.
Evidence consumers still perform their own current signature/authority/time checks; replay of an already committed recovery decision
retains its historical semantics. Journal compaction skips cold records and cannot erase archived provenance. A future source-schema
migration must preserve or explicitly migrate this versioned projection contract; schema changes are not silently accepted.

Archiving reduces hot payload accounting, not permanent identities. Small records may cost more total space after compression/envelope
overhead. SQLite pages, WAL, indexes and historical checkpoint files remain outside this logical quota. Archive itself performs neither
VACUUM nor filesystem deletion. Separate physical headroom admission, authorized WAL maintenance and verified checkpoint consolidation
are described in [storage-reliability.md](storage-reliability.md); key scaling and external export remain future work.

## Acceptance and remaining boundaries

### Full foundation host wiring

`foundation-host.integration.test.ts` composes the real Foundation registration, TCP HTTP control plane, automatic scheduling,
embedded Worker, StructuredWorkerModel, model admission/snapshots, disk SQLite and an actual RPC child Provider. The model response
port is deterministic; the child explicitly opts into a test-only unsandboxed fixture. Neither is a live-model or native-isolation certification.
The restart test closes and recreates the full host against the same database in one test process; the separate SIGKILL fixtures below
remain the evidence for actual process crash recovery.

Embedded Workers wait until restore/reconciliation/recovery/discovery finishes. `/api/security-tools/runtime` adds `startupState`
(`not_started`, `starting`, `ready`, `failed`, `stopping`, `stopped`). Ready describes startup completion, not the health of every source.
Shutdown fences new pool reconciliation and drains startup before stopping Workers and sources; an injected discovery implementation
that never settles can still block this drain. Source-wide compulsory cancellation is not implemented.

Worker evaluation IDs now bind encoded Worker/Run/Work/lease/attempt/turn identities. Old checkpoint and event IDs are not rewritten.
Authorized checkpoint continuation is schedulable even at the ordinary attempt ceiling, matching Core claim semantics; it neither
grants another attempt nor changes tool idempotency keys. Capability, active-phase and Worker capacity gates remain in force.

Worker HTTP calls default to a 10-second headers-and-body deadline, 1 MiB request and 4 MiB response bounds, checked against actual
streamed bytes as well as Content-Length. Redirects are rejected and error messages capped at 1,024 characters. Constructor overrides
are positive safe integers capped at 60 seconds and 16 MiB. Writes are not automatically retried; custom fetch ports must honor abort.
Exceeding a response bound is a failure, never a successful truncated assignment/checkpoint response.

Model execution races provider completion against host cancellation/deadline. Even a non-cooperating asynchronous Provider cannot
keep the Worker awaiting a call or update completed records through late results/usage. Tests cover timeout, Run/Work cancellation,
shutdown and late completion. This settles local ownership only: it cannot prove remote inference stopped, stop remote billing,
kill arbitrary in-process code, or interrupt synchronous code blocking the event loop. Tool-side unknown effects still require independent reconciliation.

The eleven bounded host cases cover normal execution, duplicate Work names across Runs, lost result-checkpoint HTTP acknowledgement
and full-host recreation, same-Work model failure/continuation, physical headroom refusal, Provider crash, invalid/timeout model output,
zero installed packages, startup-time shutdown and shutdown during a non-cooperating model call. Confirmed tool output is restored to
model context without another Provider execution; an uncertain crashed invocation refuses continuation without reconciliation.

### Other crash and storage acceptance

Tests exercise a real timed-out Node subprocess through the actual process adapter/Gateway/SQLite chain, trusted test-only attestation, reconciliation and retry. Separate host processes are killed with SIGKILL after registration, reconciliation and retry, then resumed twice; SQLite integrity, single audit and single replacement are checked. Other tests cover revoked/expired/tampered/misbound evidence, default denial, authority scope, lost output, terminal pagination, old records and launch generation mismatch. Test attestors do not certify Windows isolation.

Storage tests additionally kill independent hosts after reservation, before receipt commit and after receipt commit, then inspect from two fresh processes. They cover bounded admission, old-database migration, full-pool recovery, transactional rollback and same-command resumption. These short tests are not a 24/72-hour soak test or a real full-disk certification.

Continuation adds three actual host SIGKILL boundaries: pending checkpoint committed, receipt committed before result-checkpoint commit,
and result checkpoint committed. Two fresh hosts then verify one action effect, one Work, restored context before model decision and SQLite
integrity. Integration tests also exercise actual approval resume, signed no-effect reconciliation, checkpoint transport/read failures,
audit capacity rollback, identity/contract mismatches, old-lease rejection and default-denied HTTP admission.

Archive/checkpoint admission adds 30 tests, including all seven source kinds, exact readback, mutation/replacement/deletion fences,
retention and ownership gates, corruption refusal, cold capacity and atomic rollback, bounded checkpoint admission before dispatch,
and partial-success continuation using the production SQLite store. Actual SIGKILL boundaries occur after cold insertion, after hot
replacement and after full commit. Two fresh hosts per boundary verify source/ref preservation, exact accounting and idempotent command
replay. These remain selected short crash windows, not a power-loss or long-duration full-disk certification.

Windows restricted-token/AppContainer acceptance and native trusted report generation are still required; see [native-execution-cleanup.md](native-execution-cleanup.md).
Partial-success continuation is implemented for valid v2 checkpoints; unresolvable legacy/uncertain Work remains blocked. Seven-store capacity
admission, controlled archive/readback, physical headroom admission, bounded WAL maintenance and authorized v2 checkpoint consolidation
are implemented. Physical gates do not preallocate disk or cover every writer. Unknown/partial/v1 historical file disposal, whole-volume
quotas, permanent-key scale implementation and actual 24/72-hour tests remain open. No raw receipt, signed evidence or recovery command is
automatically discarded to make space; reaching permanent-key limits still blocks new work. The reliability runner covers combined
pressure and restarts plus a separate resident workload; its 120-second passing run is not long-duration production acceptance.
As of 2026-08-31, actual 24/72-hour runs are deferred at the user's request and no longer block subsequent foundation development;
they remain unexecuted, with no automatic background run scheduled. Platform trust and other safety requirements are unchanged.
UI and concrete scenarios remain frozen.
