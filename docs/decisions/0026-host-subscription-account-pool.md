---
id: ADR-0026
status: proposed
supersedes: []
superseded_by: []
---

# ADR-0026: Host subscription account pool

Status: Proposed

Date: 2026-08-08

## Context

ADR-0005 permits a dedicated account subset from the host inventory but the V1
sidecar materialized and used only one account. A single exhausted quota or
invalid provider session could therefore delay final summaries even while
other reserved subscription accounts were healthy.

The audited Social Monitor deployment also selects from the host inventory,
but its lease and mutable auth state are project-local. Directly sharing those
files would reintroduce OAuth refresh and session-chain races.

## Decision

Bounded context: Subscription Runtime infrastructure. The feature owner is the
Subscription Runtime sidecar composition. Its production paths are
`apps/subscription-runtime-sidecar` and `infra/subscription-runtime`; both stay
classified by `architecture/foundation/source-dependencies.yaml`.

The host allocator reserves a deduplicated Meeting Assistant subset from the
common host account inventory. Every reserved identity is excluded from all
other project candidate manifests before deployment. A host-only reservation
manifest atomically materializes the subset into an immutable, project-private
generation containing sequential opaque slots. Account names and source paths
never enter Compose, application configuration, logs, health, or attestations.

The sidecar owns one process-local account selector across final summary,
incremental summary, and conversation purposes. It applies no task-count
admission limit and keeps no waiting queue: every request selects an account
round-robin immediately. A failed attempt tries every account at most once for
`quota_limited`, `needs_reconnect`, `provider_session_invalid`, or
`backend_unavailable`. Timeout, cancellation, policy, schema, and attestation
failures do not trigger an immediate account retry.

Every persistent conversation account retains one prewarmed
`FileBackendCodexWorker`. If that worker is busy, each overlapping request gets
another native worker immediately; overflow workers are disposed after their
request. A retained worker that throws is disposed and lazily replaced with a
new prewarmed worker. There is deliberately no sidecar task-count cap. The native bounded
pool is not used because bounded slots and queueing contradict this admission
policy. Subscription Runtime still owns each worker's app-server and packaged
exec fallback, session cache, file-backed refresh lease, and session-generation
compare-and-swap. Final and incremental purposes keep using the audited CLI
bridge and the same runtime refresh/session safeguards.

Streaming conversation may fail over only before the first non-empty text delta
is delivered. After text is visible to the caller, the attempt is terminal so
the user never hears duplicated answer prefixes.

The first opaque slot retains the existing provider-instance identity so its
encrypted session state survives migration. Additional slots receive stable
opaque provider-instance suffixes. Existing reservation entries therefore keep
their order. Replacing or reordering an identity requires stopped maintenance
and removal of that slot's provider state. The sidecar remains a singleton;
horizontal replication requires a host-wide fenced lease service or
Subscription Runtime Gateway.

## Consequences

- Healthy reserved capacity is used automatically without exposing identities.
- Summary and conversation work can use one account concurrently without an
  application task-count limit or bypassing Subscription Runtime's refresh
  lease and generation safeguards.
- Host resources and provider quotas remain natural failure boundaries; the
  sidecar does not convert either into a fixed concurrency setting.
- Publishing a new pool manifest never mutates auth files watched by a running
  sidecar; old immutable generations can be pruned during stopped maintenance.
- Social Monitor and Meeting Assistant share a host inventory and allocator,
  but never the same concurrently eligible identity or mutable project state.
- Provider failure still cannot invalidate the original recording or final
  transcript.
