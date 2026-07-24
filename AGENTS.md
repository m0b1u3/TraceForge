# TraceForge project rules

## Product-level abstraction

TraceForge is a general-purpose AI security-agent workbench. It is not designed around any single target, challenge, vulnerability class, protocol, status code, artifact, provider, or tool.

- Never turn one run's sample, incident, target behavior, vulnerability type, response code, artifact, or tool failure directly into a product-wide rule.
- Product logic must be expressed through domain-independent concepts such as investigation state, hypothesis, task, evidence, causal validation, execution ownership, authorization scope, and lifecycle transitions.
- Concrete examples may appear in fixtures or regression tests only when the behavior under test remains generic. Prefer neutral names such as `first candidate` and `second candidate`.
- Do not add special-case orchestration for SQL injection, Heapdump, HTTP 500, CTF targets, or any other sample unless the product explicitly needs a reusable capability for that entire class and the abstraction is documented.
- A single signal never verifies a security finding. Verification requires a traceable evidence chain, reproducible causal mechanism, concrete security impact, and the required lifecycle transitions.
- When several suspicious points exist, preserve all of them as separate hypotheses and queued tasks, but execute only one validation task at a time within a Run.

Before committing an orchestration or reasoning change, review it against these rules and remove sample-specific assumptions.
