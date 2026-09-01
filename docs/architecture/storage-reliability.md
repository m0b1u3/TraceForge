# Storage reliability and acceptance

Implemented 2026-08-31. This is foundation infrastructure; no application, security scenario, live target or model policy is introduced.
See [execution-recovery.md](execution-recovery.md) for invocation ownership, original-reference recovery and archive semantics.

## Actual storage observation and admission

`createDb` registers filesystem observation before migrations and installs physical admission triggers after logical storage initialization.
Production file-backed databases use synchronous, constant-file-count `lstat`/`statfs` observations of the main DB, WAL, SHM and available
filesystem bytes. SQLite page count, page size and reusable free-page bytes are reported separately. Observation errors fail new admission
closed without disclosing filesystem paths. In-memory databases are explicitly reported as unmetered, not production disk acceptance.

Persisted deployment policies default to:

| Limit | Behavior |
| --- | --- |
| 256 MiB execution free-space floor | New receipt reservations, process claims and new checkpoints must additionally leave twice the outstanding receipt reservations plus twice the requested entry bytes. Process claims include their own journal reservation. This is a conservative headroom check, not a disk allocation. |
| 32 MiB recovery free-space floor | New recovery records, archive blobs/audits and unreserved receipts must also leave twice the new entry's size (64 KiB estimate for reconciliation/retry audits). Recovery can proceed below the new-execution floor. |
| 8 GiB main DB + WAL | Blocks the above new admissions even when logical pools have room; reusable pages are reported but not subtracted from physical file sizes. |
| 256 MiB WAL | Blocks new execution admission; recovery writes remain possible subject to their other checks. |

Existing reserved results and process settlements are not rejected merely because new-admission thresholds were crossed. Checkpoint save
still precedes a new tool dispatch, and failed physical receipt reservation leaves the invocation prepared. Old receipts remain readable
and duplicate checkpoint saves do not charge or require new admission. The same fences apply to direct source-table inserts, not only HTTP.

These are **observed headroom gates**, not OS quotas or guarantees against another process filling the disk after the check. They do not
cover every table/file writer, reserve blocks, cap a whole volume, or make batches/SQLite write amplification physically deterministic.
Other tables, artifacts, package staging and external files can still grow. Existing settlement, maintenance intent and schema migrations
may write under pressure; true `SQLITE_FULL`/I/O failure is still possible. Logical permanent-key/entry/pool bounds remain independent.
Production has no HTTP policy override. Trusted host schema administration and exclusive ownership of storage directories are prerequisites.

## Independently authorized maintenance

`storageMaintenanceAuthorizer` defaults to denial. It receives the exact strict request; an allowed grant needs a nonempty reference and
current expiry. Actor labels are not credentials. Deployment HTTP authentication remains required, including for status/history endpoints.

- `GET /api/security-tools/storage/physical`: redacted observations, policies and advisory admission state. A future admission includes its new entry size.
- `GET /api/security-tools/storage/legacy-checkpoints`: at most 2,000 directory entries, one Worker-directory level, byte totals and completeness.
  Symlinks, deeper directories, unknown files and unsupported legacy names are flagged; an incomplete scan is not a complete usage figure.
- `GET /api/security-tools/storage/maintenance?after=...&limit=50`: bounded summaries, maximum 100, no grant/request content.
- `POST /api/security-tools/storage/maintenance`: one of the requests below; no caller-supplied filesystem root, SQL or quota mutation.

Common fields are `commandId`, `actor`, `reason`. WAL maintenance adds `action: "checkpoint_wal"` and `mode: "PASSIVE" | "TRUNCATE"`.
The control persists intent before the pragma, temporarily limits SQLite busy waiting to 50 ms and restores the prior busy timeout.
Pinned readers/incomplete checkpoints leave a prepared command and return 503; retry the same request after readers finish. No process
is killed to release a reader and no automatic `VACUUM` runs. A final audit can append a small new WAL transaction, so success does not
promise the WAL stays zero bytes. Replaying a completed command reports its historical result rather than checkpointing newer writes.

Checkpoint consolidation adds `action: "migrate_checkpoint"`, `name`, `digest` and `retireSource`:

1. Only shared-root `sha256-<64 lowercase hex>.json` or its exact UUID-suffixed writer temporary name is admitted. Paths, symlinks, hardlinks,
   non-files and oversized inputs are refused. Reads are bounded to 1 MiB + one detection byte and verify file identity, stable metadata,
   SHA-256 and lossless UTF-8. The root must resolve to itself and be protected from untrusted/concurrent legacy writers.
2. Validate the v2 document and its existing Run/Case/Work/work-key attribution. Do not invent missing v1 identity. Insert the exact original
   body under its canonical original checkpoint ref with the normal logical and physical quota gates; commit the `imported` command phase
   in that same transaction. Existing identical content is reused, including when archived.
3. If requested, remove only that exact source after revalidating the durable imported body, source hash and default 24-hour file retention.
   A SQLite immediate transaction checks absence of all Work leases and fences new leases while unlinking. The separately committed import
   survives a later rollback. Thus a crash after unlink but before final audit can resume from the imported phase with no source file.
4. Resume incomplete commands only with current authorization. Completed commands replay without another mutation, while validating the
   migrated original reference. Conflicting input under the same command ID is refused.

Complete orphan temporary snapshots can therefore be consolidated before removal. Partial/malformed temporary files, v1/worker-local
legacy names and unknown files remain intact for explicit offline investigation; age alone is not evidence that they can be deleted.
File removal frees the duplicate source only; its recoverable content remains in the quota-managed DB. No real user checkpoint files were
migrated or removed during this development cycle—only isolated test fixtures exercised removal.

Maintenance commands have permanent IDs, at most 10,000 rows, 4 KiB requests/results and 1 KiB grant references. This is a separate finite
audit allowance, not an unbounded escape hatch. Pending commands survive capacity/I/O errors; already prepared commands can resume even
when the new-command count is full. Native Windows filesystem behavior and power-loss durability are not certified by macOS tests.

## Capacity exhaustion and lifecycle policy

Never delete permanent execution identities to restart at a zero counter, discard uncertainty, or copy only a live main DB while ignoring
its WAL. Pause new workload admission at the relevant limit; inspect reservations, old references, WAL readers, legacy inventory and physical
headroom. Use authorized WAL maintenance or eligible cold archive/consolidation when appropriate. Cold storage and key counts can also fill.
If no safe maintenance can release sufficient capacity, the host must remain blocked until the deployment supplies capacity or performs a
verified whole-state migration preserving the DB, cold records, pending ledgers, trust material and any still-referenced external files.
Cross-database key sharding, signed offline export/import, physical DB shrinking and automatic policy increases are not implemented.

## Reproducible acceptance runner

The following commands always create a new `traceforge-reliability-*` output directory and never accept an application DB path:
Install the workspace dependencies and run `build:foundation` first; the runner uses the built generic runtime packages and does not install dependencies itself.

```sh
env pnpm_config_verify_deps_before_run=false pnpm verify:reliability --duration-seconds 120 --interval-ms 500
env pnpm_config_verify_deps_before_run=false pnpm verify:reliability --duration-seconds 86400 --interval-ms 10000
env pnpm_config_verify_deps_before_run=false pnpm verify:reliability --duration-seconds 259200 --interval-ms 10000
```

`--output-parent` selects the parent of a fresh artifact directory; `--max-cycles` caps each lane at 30,000. The default 60-second run is
a smoke run, not a soak certification. Each crash-lane cycle checks physical pre-dispatch denial, exact receipt restoration, result-checkpoint
failure (post-receipt phases), cold-pool exhaustion/rollback and old-key fences. It kills an actual host at one of three rotating boundaries:
receipt committed, archive insertion uncommitted, archive committed. Two fresh hosts resume/read back the result. Local exclusive effect
files detect duplicate dispatches. The same cumulative DB retains prior Run identities. WAL maintenance runs every twentieth cycle.

A separate resident process repeatedly executes the neutral Gateway/checkpoint/archive flow, with a 512 MiB sampled RSS ceiling. It reuses
the process/modules but reopens the DB between cycles; this does not represent a full production server/model/Provider workload. File-based
artifacts remain for inspection. Each short host has a 30-second deadline and bounded output; reports keep only 128 recent crash-lane samples,
aggregate counters and resident observations. Signal interruption/failure writes a non-passing report; reaching a cycle cap is reported as
`cycle_limit_reached`, not as a completed requested duration. Fewer than three crash cycles cannot pass duration acceptance.

The runner injects free-space pressure without filling the user's disk. A separate integration test induces a real SQLite engine
`SQLITE_FULL` via a test DB page ceiling, verifies reservation/accounting rollback, raises that ceiling and recovers the same result.
Neither is certification of a completely full filesystem or hardware power loss. Selected migration SIGKILL tests additionally cover
import uncommitted, source already removed and final audit committed, each with two fresh-host readbacks.

### Recorded short-run acceptance, 2026-08-31

- Requested 120 seconds; completed 120.826 seconds, status `passed`.
- 74 crash-lane cycles, 296 short-host runs, 74 SIGKILL restarts; the resident process completed 234 cycles.
- Sampled short-host peak RSS: 193,249,280 bytes; resident peak RSS: 165,576,704 bytes (below 512 MiB).
- Sampled crash-lane peak main DB: 2,031,616 bytes; WAL: 8,272 bytes. These are sample maxima after recovery, not continuous OS peak measurements.
- Machine-local report: `/var/folders/cx/zrg4y7p12lx828vw7vf8jyx40000gn/T/traceforge-reliability-TMl39e/report.json` (temporary host artifact, not a portable repository fixture).

Scheduling override, 2026-08-31: the user requested skipping the actual 24/72-hour runs. They are deferred and unexecuted, not a prerequisite
for further foundation development. Keep the runner and recorded short-run evidence; do not start an automatic/background long run unless
the user requests it again. This does not establish multi-day stability or grant production acceptance.

Real filesystem exhaustion, native Windows restricted-token/AppContainer acceptance, trusted native signer acceptance and full
production-server resource validation remain separate requirements. A passing short run or skipped soak never clears those requirements.
