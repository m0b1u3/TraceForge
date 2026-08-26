# TraceForge security execution model

TraceForge separates investigation policy from execution security. Hypotheses,
tasks, evidence, causal validation, authorization scope, and lifecycle
transitions remain the product-level model. Tool security metadata describes
only what an execution can affect.

## Tool security profiles

Every tool must declare a `security` profile:

```ts
security: {
  capabilities: ["filesystem.write"],
  impactScope: "case",
  mutates: true,
  destructive: false,
  openWorld: false,
}
```

Capabilities are domain-independent: data, filesystem, network, process, and
secret access. Impact scopes distinguish case-local work, an authorized target,
an external service, and the host system. The profile describes effects only;
it cannot grant itself approval. Registration rejects tools without a complete
profile.

The approval policy is a separate runtime concern. `on-request` asks only when
execution crosses the declared authorization boundary, reaches the host or an
external service, accesses secrets, or declares destructive/open-world effects.
`never` rejects those escalations without prompting. Case-local reads and writes
remain automatic when their technical sandbox and authorization checks allow
them.

MCP tools import the protocol's `readOnlyHint`, `destructiveHint`, and
`openWorldHint` annotations. Missing annotations are treated conservatively as
potentially destructive and open-world. MCP server configuration has no trust
override. Annotations are advisory metadata supplied by the MCP server; they do
not replace target Scope Guard checks or human authorization.

## Command execution

The PoC MCP server exposes filesystem operations only. It has no process-spawn
tool. Workers that have the `process.execute` scenario capability use the
structured `process_execute` tool, which accepts an executable and argument
vector rather than a shell command string.

`process_execute` sends every operation through the authenticated local
Execution Node RPC protocol. The request carries Case, Run, Work, Worker, scope,
lease, action, and idempotency attribution. The node canonicalizes the
executable, working directory, and permission paths before launch. A launcher
must return an enforcement attestation whose SHA-256 permission-profile
fingerprint matches that exact materialized request; a mismatch terminates the
process and fails the operation.

Every process request also carries mandatory process-tree limits for CPU time,
committed memory, active process count, and aggregate write I/O bytes. The
launcher attestation contains a second SHA-256 fingerprint over those exact
limits. Missing, unsupported, weakened, or mismatched limits reject execution;
there is no unbounded default.

Execution is platform-native and fail-closed:

- On Windows, the bundled `traceforge-windows-sandbox.exe` compiles exact and
  recursive read, write, and deny grants into a deterministic restricted-token
  capability SID. It launches on a private desktop and places the process tree
  in a kill-on-close Job Object. A `deny` network profile additionally launches
  the process in a per-execution AppContainer with no network capabilities,
  opts out of the ambient `ALL APPLICATION PACKAGES` group, and verifies the
  resulting child token before resuming its primary thread. After the process
  tree exits, TraceForge revokes the temporary filesystem and Window Station
  ACL entries and deletes the AppContainer profile. The same Job Object applies
  the requested CPU-time, job-memory and active-process limits. A trusted helper
  monitor terminates the Job when its aggregate write-I/O counter reaches the
  requested byte limit. Resource-limit termination is returned through a native
  ConPTY frame or a helper-only status file outside the sandbox grants, never by
  parsing target-controlled stdout/stderr. A `direct` profile uses the restricted
  token without AppContainer network isolation. Brokered process networking
  remains unavailable until its explicit transport exists.
- On Linux, `bubblewrap` alone cannot prove process-tree CPU, memory, process-count
  and write-I/O budgets. The Linux compiler therefore rejects process execution
  until a managed cgroup backend is installed. It does not silently launch an
  unbounded bubblewrap process. Brokered networking and PTY execution remain
  unavailable until their native backends exist.

If the required native resource-limiting backend is absent, or the Windows helper
fails its versioned execution-contract probe, the server does not advertise an
Execution Node and does not register `process_execute`. The health response
exposes this as `executionNodeReady`. Desktop release verification executes the
same probe on the packaged helper. There is no direct-spawn, unbounded, or
unsandboxed compatibility path.
TraceForge packages and invokes its own helper;
it does not require the Codex application, CLI, configuration, or runtime to be
installed. Direct network permission is not target authorization, so Scope
Guard and human approval remain authoritative.

## Context and recovery

Conversation compaction prioritizes ordinary history first. Runtime evidence,
human steering, Observer corrections, and tool results carrying structured
evidence references are pinned. If a pinned item must be shortened, its leading
identifiers are retained with an explicit compaction marker.

Agent runs and usage are persisted by the server. A process restart does not
blindly replay an in-flight tool call: the unfinished run is marked interrupted,
and continuation rebuilds context from persisted investigation state and event
history. This fail-closed behavior avoids duplicate active testing. Automatic
resume should only be introduced together with durable execution checkpoints
and idempotency keys.

## Non-negotiable boundaries

- Scope Guard remains authoritative for target authorization.
- One validation task owns execution at a time within a Run.
- Tool success is not evidence of a verified security finding.
- Verification still requires traceable evidence, a reproducible causal
  mechanism, concrete impact, and the required lifecycle transitions.
- Tool capabilities must not encode a particular vulnerability class, target,
  status code, artifact, or provider.
