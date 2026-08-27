# Scenario control-plane API

TraceForge exposes the event-sourced security-agent control plane under `/api/scenarios`. The server owns command timestamps, scheduling, lease creation, lease expiry, and authorization enforcement. Clients must supply a unique `commandId` and the last observed `expectedRevision` for every state-changing Run or Work command.

`GET /api/scenarios/definitions` returns the registered Scenario Profiles, including phases, Worker topology, required capabilities, and the authorization actions that an operations client may present. The workbench consumes this contract instead of hard-coding one profile's action list.

## Operating sequence

1. Record an explicit scope authorization with `POST /api/scenarios/authorizations`.
2. Register each execution Worker with `POST /api/scenarios/workers` and maintain its heartbeat.
3. Start a Web black-box Run with `POST /api/scenarios/runs` using the authorization id as `scopeRef`.
4. The independent Planner evaluates semantic Run and Evidence Graph changes and creates, cancels, or reprioritizes queued Work Packages. Operators may still add Work explicitly through `POST /api/scenarios/runs/:runId/work` as an auditable override.
5. The server scheduler assigns compatible queued work automatically. A Worker reads its leases from `GET /api/scenarios/workers/:workerId/assignments`.
6. While executing, the Worker renews its lease and writes durable checkpoints.
7. If an action crosses the policy threshold, the Worker checkpoints the complete resumable state and requests approval. The control plane releases its lease while the Work waits.
8. An operator approves or rejects the exact checkpointed action. Approval requeues the Work with a durable grant; rejection blocks it with an auditable reason.
9. The Worker completes, fails, or blocks the Work using its `workerId` and `leaseId`.
10. The deterministic Run kernel advances only after the active phase transition predicates are satisfied; the Planner cannot bypass those predicates.

## Authorization

An authorization is bound to one Case and one scenario kind. Its scope records targets, allowed actions, denied actions, the approving operator, and an expiry time. Missing, expired, revoked, or mismatched authorization prevents Run creation.

Web black-box authorization actions use the same stable capability identifiers exposed by the scenario profile: `scope.read`, `web.browser.navigate`, `web.traffic.read`, `web.request.replay`, `evidence.write`, `artifact.analyze`, and `report.write`. Arbitrary legacy action labels are rejected. Every network tool reloads the authorization by `scopeRef` immediately before execution, so revocation and expiry take effect without restarting a Worker.

Revoking an authorization immediately cancels every running or paused Run that references it and deletes their active Worker leases. The background scheduler and Worker assignment endpoint also enforce expiry, so expired work cannot continue to be delivered. Resuming a paused Run revalidates the authorization before any Work can be leased again.

## Concurrency and retries

Every successful event increments `revision`. A stale `expectedRevision` returns HTTP `409` with the expected and actual revisions; callers must reload the Run before deciding whether to retry.

Reusing a `commandId` with the same semantic command returns the original result without appending events. Reusing it with different command content returns HTTP `409`.

## Pause, recovery, and deterministic replay

Pausing is a durable Run lifecycle boundary, not a UI-only flag. `POST /api/scenarios/runs/:runId/pause` appends `run_paused`, releases every running Work lease in the same event-store transaction, and returns leased Work to `queued`. Durable checkpoints and pending approvals remain attached to their Work Packages. Work with a checkpoint is marked resumable, so claiming it after `POST /api/scenarios/runs/:runId/resume` does not consume another logical attempt. Resume requires the Run's authorization to still be active.

At server startup, recovery reloads every running or paused Run from its event stream. A live Worker with a matching, unexpired lease continues. Expired, orphaned, projection-mismatched, or stale-Worker leases are deterministically reclaimed and their Work is requeued from its checkpoint where possible. A paused Run is preserved without acquiring leases. If a Worker cannot load the referenced checkpoint, it blocks that Work with an explicit recovery error instead of entering a retry loop.

- `GET /api/scenarios/runs/:runId/recovery` compares query projections with the replayed aggregate and returns active leases, resumable queued Work, pending approvals, and suspension state.
- `GET /api/scenarios/runs/:runId/replay?revision=:revision` reconstructs the Run at an exact revision and returns a canonical SHA-256 state digest. It is read-only and never executes Work or reapplies historical effects.

## Worker execution endpoints

- `POST /api/scenarios/workers`
- `POST /api/scenarios/workers/:workerId/heartbeat`
- `POST /api/scenarios/workers/:workerId/status`
- `GET /api/scenarios/workers/:workerId/assignments`
- `POST /api/scenarios/runs/:runId/work/:workId/renew`
- `POST /api/scenarios/runs/:runId/work/:workId/checkpoint`
- `POST /api/scenarios/runs/:runId/work/:workId/request-approval`
- `POST /api/scenarios/runs/:runId/work/:workId/complete`
- `POST /api/scenarios/runs/:runId/work/:workId/fail`
- `POST /api/scenarios/runs/:runId/work/:workId/block`

The assignment response contains the immutable Work Package, current Run revision, lease metadata, goal, Case, scope reference, and active phase. Only the Worker and lease recorded on the Work Package may mutate it.

## Agent collaboration topology

Agent instances are declared by the Scenario Profile rather than hard-coded by the server. The Web black-box profile has four isolated execution pools:

- `web-research`: resident and elastic from one to four Research Workers.
- `web-validation`: one on-demand Validator; the Run kernel still enforces the global single-validation execution slot.
- `web-review`: one on-demand Reviewer that does not execute the original validation role.
- `web-report`: one on-demand Reporter created only while report Work is queued or running.

The independent Run Planner is also outside the Worker lease pool. It receives a bounded snapshot only when the semantic investigation state changes, so lease claims, heartbeats, and checkpoint transport do not cause repeated model calls. A Planner decision is persisted before effects are applied. It may propose bounded Work, cancel queued Work, or reprioritize queued Work; Work identifiers, idempotency keys, lifecycle transitions, capability matching, and phase advancement remain server-owned and deterministic. Planner proposals must use graph-backed Hypothesis and Evidence identifiers and must match a Worker pool declared by the active Scenario Profile.

- `GET /api/scenarios/runs/:runId/planner/evaluations` returns the Planner's durable decision history.

An independent Run Observer is outside the Worker lease pool. It subscribes to revision changes in the Run event stream and Evidence Graph, evaluates a bounded global snapshot, and persists every decision before applying it. Its allowed decisions are continue, inject a structured steering directive into one Work, terminate one branch, or terminate the Run. Observer directives are immutable Run events and are refreshed into the target Worker's steering context on every reasoning turn. The Worker-local `LoopGuardObserver` remains only a tactical duplicate-action safeguard; it is not the global Observer Agent.

- `GET /api/scenarios/runs/:runId/observer/evaluations` returns the Observer's durable decision history.

`GET /api/scenarios/runs/:runId/collaboration` returns the operations-facing collaboration snapshot. It combines the bounded recent Planner and Observer decisions, cognitive-agent availability, Worker pool demand, Worker heartbeat health, capacity and current Run leases, Evidence Graph counts and bounded node/edge summaries, plus explicit Work-to-Hypothesis/Evidence links. Optional `evaluationLimit` and `nodeLimit` query parameters are server-bounded. The endpoint is a read-only projection: it does not initialize or mutate the Evidence Graph, claim Work, renew leases, or trigger model evaluation.

The workbench refreshes this lightweight collaboration projection while a Run is active. This polling is intentionally separate from cognitive scheduling: observing heartbeats and leases never changes semantic fingerprints or causes Planner/Observer model calls.

Committed Run and Evidence Graph transactions publish lightweight in-process Blackboard change notifications after SQLite commit. These notifications contain only ownership, revision and event-type metadata; consumers always reload durable state before acting. Planner, Observer and elastic Worker-pool reconciliation wake immediately from this channel. A 30-second scan remains as a recovery path for process restarts or missed in-process notifications, rather than serving as the normal scheduling mechanism.

Planner, Observer and execution Workers use one deterministic context distiller. Raw events, graph state and tool output remain in durable storage, while model input receives bounded recent Work, outputs, directives, graph nodes, relations and events. Every assembled context includes a manifest of source revisions and omitted item counts. Semantic fingerprints exclude lease ownership and transport churn, and the Observer's fingerprint cursor is persisted so a restart does not turn heartbeats into new reasoning work.

Every Planner, Observer and Worker model call creates a durable cognitive snapshot before contacting the provider. The snapshot stores the exact system instruction, user payload and JSON Schema actually sent to the model, along with Run/Graph revisions, the context manifest and ownership references. Its lifecycle is `prepared`, then `completed` with the validated structured decision or `failed` with the provider/validation error. This separates what the model actually saw from later Blackboard changes.

- `GET /api/scenarios/runs/:runId/cognitive-snapshots?consumer=planner` lists lightweight snapshot metadata without expanding prompts or outputs.
- `GET /api/scenarios/cognitive-snapshots/:snapshotId` returns one complete input/output snapshot.
- `POST /api/scenarios/cognitive-snapshots/:snapshotId/replay` submits the exact stored request again and records a child `replay` snapshot. Replay never applies the returned decision to Run, Work, Session or Evidence Graph state.

## Model execution control

Planner, Observer and Worker calls pass through a role-aware model runtime. Each role has an ordered route chain, request timeout, bounded retry count, persistent circuit-breaker threshold/reset window, maximum estimated input size and per-Run token budget. Budget reservation and call creation occur in one SQLite transaction, so concurrent Workers cannot independently spend the same remaining budget. Actual provider usage replaces the reservation when it is larger; calls without usage telemetry remain conservatively charged at their reservation.

Before a Provider attempt starts, it must acquire a permit from the model admission controller. The controller enforces global, per-role and per-Run concurrency limits, a bounded queue and a maximum queue wait. Observer, Planner and Worker priorities are configurable; waiting requests gain priority over time so a sustained stream of high-priority work cannot starve older requests. Queue, admission, release, timeout, cancellation and restart interruption are persisted independently from model-call records. Cancelling a Run or Work cancels its queued requests and aborts active Provider calls without counting an operator cancellation as a Provider circuit failure.

- `GET /api/model-execution/capacity`
- `GET /api/scenarios/runs/:runId/model-admissions`

## Unified Agent event protocol

Scenario Agents publish the version 2 durable protocol stream using the same lifecycle shape for replay and live WebSocket delivery. A cognitive evaluation is a `turn`; model admission, Provider execution, Worker tool execution, approval and control-plane transitions are typed `item`s. A Turn is owned by the runtime, names its `agentInstanceId`, and advances through explicit `turn/progress` phases: `prepared` → `contextBuilt` → `modelInvoked` → `decisionProduced`, followed when applicable by `actionRequested` → `toolExecuted` → `observationApplied` → `checkpointed`. Item progress follows `item/started` → optional `item/updated` → `item/completed`. The terminal `turn/completed` records the outcome (`continue`, `finish`, `waitingApproval`, or `blocked`) and checkpoint reference. Events carry only structured metadata, bounded summaries and evidence references—never raw credentials, private reasoning or unrestricted tool output. Protocol v1 Turn objects are intentionally unsupported.

The design follows the Codex app-server principle that clients consume typed Turn and Item lifecycle notifications instead of reconstructing state from console logs. TraceForge adds `runId`, `caseId`, `workId`, role and durable per-Run sequence numbers. SQLite remains the source of truth; startup reconciliation backfills terminal events for model calls, admissions and cognitive snapshots interrupted between a projection commit and event publication.

- `GET /api/scenarios/runs/:runId/agent-events?after=<sequence>&limit=<1..1000>`
- Existing `/ws` subscribers receive `{ "type": "scenario_agent_event", "event": ... }` for newly committed protocol events.

The workbench consumes the same protocol through a deterministic client projection. It selects the newest Scenario Run for the active Case, replays from cursor `0` on first load, and resumes from the last contiguous sequence after reconnect. WebSocket events received beyond a sequence gap remain buffered until cursor replay supplies the missing events; they are never applied out of order or converted into the retired chat event model.

The primary provider is route `primary`. Additional OpenAI-compatible or Anthropic routes are declared in `alternativeRoutes` in `config/llm.json`, while `rolePolicies` selects the ordered routes and overrides limits independently for `planner`, `observer` and `worker`. Route API keys are masked in configuration responses. A timed-out structured request receives an AbortSignal all the way down to the provider SDK.

- `GET /api/scenarios/runs/:runId/model-calls` returns every route attempt, status, snapshot reference, usage and failure.
- `GET /api/scenarios/runs/:runId/model-usage?role=worker` returns committed and conservatively accounted Run usage.

## Security Tool Runtime V2

Worker tools are registered as versioned capability providers rather than assembled into a fixed model-visible array. Each provider declares its discovery source, supplied capabilities, transitive capability dependencies, priority, permission requirements, risk and timeout. The active Work Package supplies capability demand; the gateway intersects that demand with Worker capabilities and effective authorization, then resolves the smallest deterministic provider set. Only that set's schemas is included in the Worker model request. The request also records requested capabilities, unresolved dependencies and the registry revision so a decision can be traced to the exact runtime catalog.

Provider discovery is synchronized per source. Newly discovered providers become active, disappeared providers enter `draining`, and a changed version retires and replaces the prior provider. Health is tracked independently as `healthy`, `degraded` or `unavailable`; retryable execution failures degrade a provider and remove it after the configured threshold, allowing an eligible fallback to be selected without changing Planner logic. Retired providers cannot be silently reactivated. These lifecycle rules are generic and do not encode targets, vulnerability classes or scenario-specific attack logic.

The standalone composition root owns one shared discovery runtime for all elastic Workers. Built-in tools and explicitly injected external discovery sources use the same contract. Due sources are refreshed before a Work receives its model-visible catalog, concurrent refreshes for one source are coalesced, and a failed refresh preserves the last successfully validated catalog while marking the source degraded. A complete discovery result is validated before any provider lifecycle is changed.

`GET /api/security-tools/runtime` returns the registry revision, aggregate runtime status, source refresh state and provider lifecycle/health metadata. It never returns executable implementations, credentials or unrestricted tool output. External sources can be installed only through the trusted standalone composition root; discovering a tool does not bypass Worker capability matching, Scenario permissions, risk policy or approval gates.

External process providers use Tool Provider RPC version 1 over private length-prefixed stdio. Signed Manifests provide the static tool catalog. For each invocation, the host launches a fresh process without a shell under the invoking Run/Work ownership, performs an explicit protocol and signed-identity handshake, bounds frame size, request time, stderr retention and in-flight calls, and validates the result. Provider execution errors explicitly marked retryable feed the shared provider-health circuit. Runtime diagnostics expose only bounded lifecycle and sandbox metadata.

Process separation is not treated as a security boundary. The local process client rejects an unsandboxed provider unless development mode is explicitly enabled. Production packages are signature and full-tree hash verified, atomically copied into a read-only managed directory, and launched with a verifiable sandbox attestation; their declared tools still receive only the effective Work context selected by the Tool Gateway. A provider version change stops the old source generation from accepting calls, publishes the new catalog, atomically persists new `enabled`/old `draining`, waits for old in-flight calls, and only then closes and disables the old generation. Restart reconciliation never adopts those old processes under a synthetic owner. Durable invocation-receipt reconciliation and old-package reclamation remain follow-up work.

## Web black-box Worker tools

The standalone Worker runtime currently exposes these foundation-native tools; none delegates execution to the retired chat-oriented AgentRuntime:

- `scope.authorization.snapshot` reads the exact active Run authorization.
- `knowledge.graph.snapshot` reads a bounded typed Evidence Graph snapshot with lifecycle state and relations.
- `knowledge.graph.mutate` appends one generic node, relation, lifecycle transition, or invalidation. Evidence nodes may reference only durable tool receipts, traffic, or artifacts, and Case/Run ownership is injected by the Worker gateway.
- `web.traffic.snapshot` reads bounded, Case-attributed traffic metadata.
- `execution.session.open` creates a Run- and authorization-bound Session using an operator-provisioned identity reference.
- `web.http.request` uses a Session and the Execution Node Network Broker to send one independently re-authorized request, refuses implicit redirects, redacts credential headers, atomically persists its Traffic and Network Receipt, and updates encrypted Cookie state.
- `web.browser.observe` has an isolated headless-browser adapter, but the brokered-only Web profile does not expose it until browser traffic has an enforceable proxy backend. It cannot fall back to direct networking.

HTTP and Browser actions are classified as `bounded_write` because they interact with the authorized target even when the protocol method is observational. Tool exceptions are converted into durable failed observations and returned to the Worker model; they do not crash the Work executor. Privileged and destructive tools remain subject to the native checkpoint-and-approval protocol.

## Execution identities and Sessions

- `POST /api/execution/identities`
- `GET /api/execution/identities?caseId=:caseId`
- `POST /api/execution/identities/:identityId/revoke`
- `GET /api/execution/sessions?runId=:runId`
- `POST /api/execution/sessions/:sessionId/close`

Operators provision identity headers and Cookies through the identity endpoint. Secret material is AES-256-GCM encrypted at rest with per-record nonces and authenticated references. API responses, Worker tool schemas, tool results, traffic headers, receipts and model transcripts expose identity/version references rather than header or Cookie values. The master key comes from `TRACEFORGE_VAULT_KEY` or a generated mode-0600 key under the TraceForge data directory.

An Execution Session is bound to one Case, Run and `scopeRef`. Each use records its Worker, Work, lease id and lease expiry. HTTP and Browser tools share its encrypted Cookie state. Expired leases cannot use a Session; authorization or identity revocation freezes every dependent active Session, and closing a Session destroys its mutable secret state.

## Unified Evidence Graph

- `GET /api/knowledge-graph/:caseId`
- `GET /api/knowledge-graph/:caseId/nodes/:nodeId?depth=1`
- `POST /api/knowledge-graph/:caseId/commands`

The graph is the foundation-owned investigation state for every Scenario Profile. Its generic node kinds are `entity`, `fact`, `hypothesis`, `evidence`, `task`, `validation_conclusion`, `finding`, and `limitation`; scenario packages add domain meaning through properties and relations rather than introducing separate stores.

Credential material discovered or supplied during an investigation may be stored in graph node properties and is returned by the graph API so the user can inspect it directly. Such nodes are therefore user-visible Blackboard data, not implicitly redacted secret references. The encrypted Execution Identity vault remains available for credentials that must be bound to an executable Session without copying them into traffic records.

Every graph mutation is an idempotent command with `commandId` and `expectedRevision`. The server appends immutable events and updates query projections in one SQLite transaction. A stale revision or reused command id with different content returns HTTP `409`. Case ownership comes from the route or Worker assignment and cannot be supplied by the model.

Evidence nodes require an auditable source. A Finding cannot enter `verified` until it has a traceable originating Hypothesis, an impacted Entity, an active Validation Conclusion containing causal mechanism, reproduction and concrete impact, and at least two distinct active Evidence signals. Invalidating a source or dependency automatically moves affected downstream conclusions and Findings to `needs_review`; it never silently deletes history.

## Approval endpoints

- `GET /api/scenarios/approvals?caseId=:caseId&status=:status`
- `POST /api/scenarios/approvals/:approvalId/resolve`

An approval is bound to one Work Package, one tool invocation action key, and the payload reference of that Work's latest checkpoint. Requesting approval atomically changes the Work to `waiting_approval` and releases its Worker lease. The approval query is backed by a durable projection for operations consoles and audit integrations.

Approving an action records the operator reason, adds only that exact action key to the Work's durable grants, and returns the Work to `queued`. A new lease may then resume from the checkpoint and retry the exact invocation. Rejecting the request changes the Work to `blocked`. Cancelling the Work or Run cancels any pending approval; a cancelled or otherwise resolved request cannot be reused.

## Run endpoints

- `GET /api/scenarios/runs?caseId=:caseId`
- `GET /api/scenarios/runs/:runId`
- `POST /api/scenarios/runs`
- `POST /api/scenarios/runs/:runId/work`
- `POST /api/scenarios/runs/:runId/tick`
- `POST /api/scenarios/runs/:runId/advance`
- `POST /api/scenarios/runs/:runId/pause`
- `POST /api/scenarios/runs/:runId/resume`
- `POST /api/scenarios/runs/:runId/cancel`
- `GET /api/scenarios/runs/:runId/recovery`
- `GET /api/scenarios/runs/:runId/replay?revision=:revision`

`tick` exists for deterministic operations and diagnostics. Normal execution uses the server's automatic scheduler.
