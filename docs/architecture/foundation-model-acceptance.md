# Foundation real-model acceptance

This is an opt-in, bounded integration run, separate from deterministic regression tests.
The CLI uses the configured production `createProvider` adapter. It has no simulated-model fallback.
An API connection alone is not a pass: both the normal and checkpoint-restart cases must satisfy the checks below.

## Run

```sh
env pnpm_config_verify_deps_before_run=false pnpm verify:foundation:model --allow-model-api --config /absolute/path/to/llm.json
```

The default configuration is `config/llm.json`; the existing LlmConfig schema supplies provider, model, key, endpoint and JSON mode.
Only the primary endpoint is used: alternative routes are not silently called. Do not put API keys in command arguments or chat.
The explicit opt-in acknowledges external API usage. Without it, or without a valid configured model/key, the command exits 2 with
`status: not_run` and `modelApiCalls: 0`. It never counts missing configuration as a skipped successful acceptance.

Local TCP/child-process permission and network access to the configured model endpoint are required. Permission failures are not model failures.
No user case, production database, repository content, actual security target or installed MCP server is used.
Only the generic Worker instructions, synthetic task/context, tool schema and synthetic observations are sent to the selected model service.

## What runs

- Real TCP Foundation Host, automatic scheduler, embedded Worker, StructuredWorkerModel, model runtime and production model adapter.
- A new on-disk SQLite database per case, actual RPC child tool process and existing checkpoint/receipt/continuation controls.
- Deterministic tool behavior, **not** deterministic model decisions: the tool alone knows a fresh random observation token.
  The token is absent from the first model prompt and is never supplied as a prewritten model answer.
- Normal case: the model requests the exposed read-only tool with valid input, receives its result through normal context construction,
  and completes with the exact observed token. No tool call, guessed completion, missing observation, or extra calls fail acceptance.
- Restart case: after the model chooses a tool and its receipt is persisted, the result-checkpoint HTTP request is deliberately rejected.
  The host is closed and recreated against the same database; explicit test-only authorized continuation must recover the receipt into
  the next real model request, complete using that token and make **zero** tool calls after restart. Work identity and attempt stay unchanged.

Both cases require one receipt, persisted checkpoints/model snapshots, completed model-call records, and SQLite integrity `ok`.
The model is not asked to verify a finding; structured security outputs remain empty. Completing these tasks does not measure vulnerability
discovery, reasoning quality across scenarios, prompt-injection resilience, production authorization deployment, or native sandbox isolation.
The tool child explicitly uses a test-only unsandboxed mode, has no real target, and its observation-token branch exists only in test fixtures.
Restart here recreates the host in one process; the existing independent SIGKILL suites test actual host crashes separately.

## Limits, records and failures

The CLI allows at most six logical model adapter calls across both cases, a 120-second workload deadline, and 30 seconds per model call.
Shutdown/drain can add cleanup time. The harness caps serialized model input at 128 KiB and returned JSON at 64 KiB before persistence.
That returned-JSON check does not bound the SDK's initial response allocation. Logical calls are not raw HTTP requests: existing SDK/adapter
retries and JSON-format fallbacks may issue more requests. This is **not a hard output-token or financial budget**, and cancellation does not
prove remote inference or billing stopped. Configure provider-side spend limits where needed.

Each run owns a fresh directory under `data/foundation-model-acceptance` (override with `--output-parent`). It retains the two test databases,
model snapshots and a `report.json` with mode, model identity, status, check failure code, timing, logical-call count, usage when supplied,
prompt/response/result hashes, tool counts, checkpoint/receipt counts and observation hashes. Missing usage is `null`, not fabricated zero.
The CLI does not print the config's key or endpoint; upstream exception bodies/URLs/headers are not propagated into the harness report/database.
Reports contain no private chain-of-thought. Test databases may contain the model's synthetic-task responses and should still be treated as local records.

A provisional failed/incomplete report is written before work starts, so abrupt termination cannot leave a stale successful report in a reused directory.
SIGINT/SIGTERM requests cancellation, drains the host and saves a failed report. Normal failure exits 1, pass exits 0; no automatic acceptance retry
or background/24–72-hour run is scheduled. A process kill or filesystem failure can still leave an incomplete report requiring inspection.

Offline tests explicitly use `mode: simulated_harness_test`, including one real HTTP loop through the production API adapter against a local
simulated endpoint. Those tests verify the acceptance mechanism, reject false positives, and check cancellation/budgets/redaction; they do not
establish that an external model has passed. They are included in fast regression and the independent foundation gate; the external CLI is not.

## Current result — 2026-08-31

External-model acceptance is **not run**: the repository's `config/llm.json`, checked TraceForge desktop config locations and checked model-key
environment variables provide no usable configuration. The real entry point returned `not_run / model_configuration_missing_or_invalid`,
with zero model API calls. The user must supply a configuration path before real inference can be validated; offline passes cannot replace it.

Scheduling update (2026-08-31): the user explicitly deferred this acceptance and will provide model configuration later.
It remains **deferred / not run**, but no longer blocks foundation development, including generic Skills/knowledge-resource/MCP assembly.
Retain this entry point and the unverified model-behavior/compatibility risks. Resume when the user supplies the configuration;
do not borrow other applications' credentials, substitute another model, or schedule background retries.
