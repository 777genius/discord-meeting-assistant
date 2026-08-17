---
id: ADR-0028
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0028: Binding-aware post-call rollout

## Status

Accepted on 2026-08-18. This decision tightens ADR-0027's migration and rolling
deployment rules after implementation review. Its durable provider-binding and
rollback guarantees remain unchanged.

## Context

Inferring historical work from today's top-level backend can misclassify an
unbound legacy row during a backend change. Reusing the V1 BullMQ queue also
allows a pre-binding worker to claim newly bound work and route it through its
legacy provider before an upgraded worker can apply admission.

## Decision

- The deployment must provide
  `TRANSCRIPTION_LEGACY_EXECUTION_BINDING` as explicit historical provenance.
  It has no application default and is the only value used to backfill or pin
  a recoverable null binding. New rows are already created atomically with the
  currently selected binding and therefore keep that value.
- Binding-aware producers and consumers use the isolated
  `meeting-post-call-v2` queue, `process-post-call-v2` job name, and V2 job
  identity namespace. A V1 worker cannot claim newly bound work.
- Durable outbox reconciliation may enqueue unfinished legacy work into V2.
  Existing V1 Redis jobs are not authoritative and can remain until their
  normal retention or deployment cleanup boundary.
- Missing, unknown, or unsupported bindings remain held before business work or
  provider access. No runtime infers a provider from the current selection.

## Consequences

- Rolling deployments cannot route a new ElevenLabs-bound meeting through a
  legacy Deepgram-only worker.
- Late writes from a legacy binary retain their explicitly declared historical
  route instead of inheriting the active profile.
- Operators must record one historical binding in each deployment before the
  binding-aware runtime starts.
