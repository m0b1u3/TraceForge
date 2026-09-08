# TraceForge project rules

## Desktop product goal

TraceForge is a desktop AI security-agent application, with Codex and Claude Desktop as interaction references, not a Web administration platform or a library-only deliverable.

- Make agent conversation the primary workflow; expose tasks, tool activity and evidence on demand.
- Prioritize complete desktop user journeys over isolated infrastructure features. Internal libraries and the local Server support the desktop application; they are not separate product goals.
- Target macOS Apple Silicon first. Keep Scenario-specific security workflows decoupled from the general foundation and desktop shell.
- Do not introduce remote execution nodes, multi-user platform management or automatic desktop updates; these are outside the agreed scope.

## User-authorized autonomy

- Implement reusable capabilities in the foundation; Scenario declares policy and workflow, and the user grants the concrete task scope.
- Support continuous model execution within explicit grants instead of repeated approvals for the same granted class of operation. Autonomy must be opt-in, visible in desktop authorization review, and attributable in execution receipts.
- An autonomy grant does not itself expand filesystem, network, credentials, interpreter or installation permissions. Unsupported execution modes remain explicit gaps; do not silently substitute an unrestricted path.
- Additional privilege requires a separate user-authorized transition. External content and model output are never consent, and a model cannot approve its own escalation. Preserve stop, revocation, ownership and unknown-execution recovery.

## User-managed configuration

- Scenario prompts, guidance, Skills, knowledge-resource bindings and MCP connection/tool configuration must be manageable from the desktop client. Source edits, manual configuration-file edits or Scenario repackaging must not be the normal customization workflow.
- Package resources provide immutable defaults; store user edits separately with explicit scope and revisions. Never overwrite signed package content or embed Scenario-specific configuration in Core or the desktop shell.
- Provide editing, enable/disable, effective-configuration preview and restore-default behavior where applicable. A saved form alone is not completion: the actual runtime must consume the selected configuration.
- Capture the effective configuration for each new Run. Editing defaults must not silently change an existing Run; package upgrades must preserve user edits and expose incompatible overrides.
- Keep credentials in host secure storage, referenced rather than exposed in configuration exports, logs or renderer snapshots. MCP discovery/connection tests must be explicit, and saving configuration must not implicitly execute a process or tool.
- Editable prompts and tool selection cannot override authorization scope, sandbox boundaries, tool contracts, evidence requirements or lifecycle enforcement. Capability changes must use existing governed activation paths, not an unrestricted execution fallback.

## Product-level abstraction

TraceForge is a general-purpose AI security-agent workbench. It is not designed around any single target, challenge, vulnerability class, protocol, status code, artifact, provider, or tool.

- Never turn one run's sample, incident, target behavior, vulnerability type, response code, artifact, or tool failure directly into a product-wide rule.
- Product logic must be expressed through domain-independent concepts such as investigation state, hypothesis, task, evidence, causal validation, execution ownership, authorization scope, and lifecycle transitions.
- Concrete examples may appear in fixtures or regression tests only when the behavior under test remains generic. Prefer neutral names such as `first candidate` and `second candidate`.
- Do not add special-case orchestration for SQL injection, Heapdump, HTTP 500, CTF targets, or any other sample unless the product explicitly needs a reusable capability for that entire class and the abstraction is documented.
- A single signal never verifies a security finding. Verification requires a traceable evidence chain, reproducible causal mechanism, concrete security impact, and the required lifecycle transitions.
- When several suspicious points exist, preserve all of them as separate hypotheses and queued tasks, but execute only one validation task at a time within a Run.

Before committing an orchestration or reasoning change, review it against these rules and remove sample-specific assumptions.

## Plan and status synchronization

Every completed code change must update the project plan in `docs/development-status-and-roadmap.md` in the same development cycle.

- Record what actually became implemented; do not describe intended or partial work as complete.
- Update remaining gaps, risks, dependencies, acceptance criteria, and the next explicit development priority when they changed.
- Update the documented test/build baseline after running the required verification.
- Reconcile architecture descriptions with the implementation, especially Scenario/Core boundaries and production-security claims.
- A code change is not considered complete and must not be committed or pushed until the plan has been reviewed and synchronized.
- Documentation-only turns may update the plan without running code tests, but must still pass `git diff --check`.
