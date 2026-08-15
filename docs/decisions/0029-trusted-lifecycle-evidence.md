---
id: ADR-0029
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0029: Trusted lifecycle evidence

## Status

Accepted on 2026-08-13.

## Context

ADR-0027 established durable provider-neutral source and actor identity, but
Craig lifecycle v2 does not prove which producer capability or immutable source
revision classified its actors. Persisted rollout jobs also need to survive
upgrade and rollback without acquiring a newer identity generation. During an
active recording, a restart must not erase proven human kinds or undelivered
late joins, and contradictory actor observations must fail knowledge admission
without stopping the authoritative recording.

## Decision

- Craig owns lifecycle generation 3 and its canonical schema, fixture bundle,
  and digest. Start and authoritative-ready publish the exact sealed-roster
  capability, immutable producer revision, actor-semantics version, actor
  observation state, and explicit unsealed/sealed roster state.
- Craig durably fsyncs the provider-neutral source, capability, canonical actor
  observations, and exact ordered lifecycle events at start, join, and leave.
  Recovery replays that journal before terminal and authoritative-ready.
- Craig outbox readers drain legacy and current job formats in either rollout
  mode. A persisted recording keeps its original lifecycle generation; v1 and
  v2 jobs are never promoted into generation-3 identity.
- Recording ingress is the anti-corruption layer. Meeting Lifecycle is the sole
  canonicalizer and persists lifecycle generation plus nullable producer
  provenance through active spool, completion receipt, manifest, and meeting
  snapshot. Missing, unsupported, or conflicting trust evidence does not
  invalidate the original recording.
- Every actor observation is classified. The first canonical kind remains
  immutable; a contradictory kind permanently marks knowledge identity as
  conflicted while recording and post-call processing continue.
- Meeting Knowledge only checks the published sealed-roster capability,
  generation, observation consistency, and human eligibility. It does not
  recanonicalize provider observations. Capability-less v2, v1, unversioned,
  unsupported future capability, and conflicted evidence remain
  knowledge-ineligible.
- The consumer pins Craig's exact schema and fixture bytes plus bundle digest
  and parses every producer fixture with its public contract parser.

## Consequences

- Rolling upgrade, rollback, and restart preserve authoritative evidence and
  cannot manufacture trust for an older recording.
- Late human observations survive restart, while automation and unknown tracks
  remain in the authoritative recording without becoming human evidence.
- Provider SDK and transport types remain outside domain and application code.
- Future knowledge work can rely on one fail-closed, evidence-backed identity
  admission rule without weakening legacy recording availability.
