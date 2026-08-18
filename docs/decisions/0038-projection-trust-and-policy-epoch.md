---
id: ADR-0038
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0038: Projection trust and cluster policy epoch

## Status

Accepted by the product owner on 2026-08-18 as the R89 projection-trust
remediation. This decision clarifies ADR-0030 and ADR-0036 without weakening
their final/historical sealed-roster requirements.

## Context

An active meeting normally has trusted lifecycle v3 provenance before its actor
roster receives the terminal seal. Requiring that seal together with active
state makes canonical live replies unreachable. Rolling pods also need one
durable answer-policy authority, and projection ownership needs an explicit
upgrade and rotation transition rather than configuration-based reassignment.

## Decision

- Transient live reply eligibility uses the named `attested_active` predicate:
  the durable live-memory schema, exact trusted producer capability and actor
  semantics, consistent v3 admission, active state, non-empty current human
  roster, generation fence, and exact authenticated current live projection.
  Both unsealed and sealed active rosters qualify. Final and historical evidence
  continue to require the terminal sealed roster.
- PostgreSQL owns one monotonic cluster-wide local-final-reply policy epoch.
  Atomic admission, worker leases, and every durable worker checkpoint must
  match its exact epoch plus grounding and authorization policy versions. A pod
  may activate only a higher epoch; an older pod cannot lower it, admit new
  work, lease another epoch, mutate its job, or pass the pre-publication fence.
- A legacy live snapshot may write-upgrade a missing publisher identity only
  after the publisher returns the same exact receipt at the already projected
  revision. Changing publisher identity requires a different authenticated
  receipt rendered from the exact current aggregate revision. Reassigning an
  existing receipt or rotating from a stale revision is rejected.

## Consequences

- Live replies remain available during the normal unsealed active phase without
  allowing capability-less, inconsistent, stale-generation, or lookalike input.
- Rolling policy changes converge on one durable epoch; old and new workers do
  not terminalize each other's jobs.
- In-flight projections can converge after a compatible upgrade or controlled
  bot rotation without silently claiming ownership of an old remote message.
