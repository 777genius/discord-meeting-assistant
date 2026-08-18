---
id: ADR-0039
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0039: Fence binding recovery from legacy workers

## Status

Accepted on 2026-08-18. This decision extends ADR-0038 with a database-level
recovery fence and an explicit rollback boundary.

## Context

ADR-0038 separates new work onto the V2 queue, but a pre-binding worker can
still query the shared PostgreSQL outbox directly. If a newly bound row uses
the legacy retry clock, that worker can recover and settle work without
understanding its immutable provider binding. Recovery can also starve when a
page is filled by bindings unsupported by the current deployment.

After migration 0020, reverting application code without reverting durable
state would silently restore those legacy semantics unless schema readiness
rejects the older binary.

## Decision

- A binding-aware outbox row keeps the V1-visible `recovery_after` at PostgreSQL
  infinity and uses `binding_recovery_after` as its V2-only retry clock.
- Database constraints prevent a V1 settlement or retry update from making a
  binding-aware row visible to the legacy recovery query.
- V2 recovery filters supported execution bindings before applying its page
  limit. Legacy unbound rows remain recoverable through the explicit historical
  binding path.
- Operational rollback changes both provider profiles to Deepgram on the same
  binding-aware release. Existing in-flight bindings remain immutable.
- A code revert to a pre-migration binary is unsupported after migration 0020.
  Exact schema readiness rejects that binary, making it a deliberate stop-only
  boundary instead of a silent mixed-version rollback.

## Consequences

- A V1 worker cannot discover newly bound work even when it polls PostgreSQL.
- Unsupported rows cannot starve supported work behind the recovery page limit.
- Provider rollback remains reversible without rewriting in-flight work.
- Rollback runbooks must distinguish a supported profile rollback from an
  unsupported pre-binding code revert.
