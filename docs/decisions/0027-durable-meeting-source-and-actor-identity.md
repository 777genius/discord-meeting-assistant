---
id: ADR-0027
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0027: Durable meeting source and actor identity

## Status

Accepted on 2026-08-13.

## Context

Meeting Lifecycle retained a recording, publication target, transcript,
summary, and publication receipt but dropped the provider-neutral source scope
and room received at recording ingress. It also had no durable actor-kind
vocabulary. Craig v1 exposes `participantIds`; ADR-0011 proves that Botik is
excluded from that list, but does not prove that every other automation actor is
excluded. An authoritative audio track cannot establish that its speaker is a
human because Botik correctly has an authoritative track too.

Local final-reply knowledge needs a fail-closed identity foundation before it
can admit transcript evidence. That foundation must preserve existing recording
and post-call behavior, remain provider-neutral inside Meeting Core, and restore
old JSON snapshots and recording spools without inventing identity.

## Decision

- Add the `meeting-knowledge` feature to Meeting Core with a curated
  `@discord-meeting/meeting-core/meeting-knowledge` entrypoint. Its first
  executable domain behavior admits knowledge identity only when both source
  and actor roster are durable and exposes only actors explicitly classified as
  `human`. It has no Discord Reply, retrieval, model, voice, or publication
  behavior in this phase.
- Meeting Lifecycle snapshots add `source: { scopeId, roomId } | null` and
  `actors: { actorId, kind }[] | null`, where kind is `human | automation |
  unknown`. New v2 meetings require non-null values. Actor rosters are
  canonical and duplicate or conflicting actor kinds fail closed.
- Snapshot restore maps absent legacy fields to explicit `null`. Legacy
  meetings remain valid for recording, transcription, summary, and publishing,
  but cannot be admitted by Meeting Knowledge.
- Craig lifecycle v2 carries an explicit actor roster at start and
  authoritative-ready, and explicit actor identity on participant changes. The
  inbound anti-corruption layer maps guild/channel and actor data to the
  provider-neutral application vocabulary. Craig v1 stays readable and
  operational, but yields `actors: null` because its human-only semantics are
  not proven for every automation actor.
- The recording spool stores the lifecycle contract generation and canonical
  actor roster, upgrades legacy missing fields to `null`, and retains source and
  actors in the completion receipt. Authoritative-ready must match the durable
  roster. Every v2 authoritative speaker track must have a roster actor; tracks
  for automation and unknown actors remain part of the authoritative recording.
- Initial Meeting persistence replay compares source and actors in addition to
  publication target and recording identity. A replay cannot rebind a recording
  ID to a different source or actor classification.
- Foundation owns the new feature boundary and its test path. External
  consumers receive no Meeting Knowledge edge until a real later application
  slice needs one.

## Consequences

- A restart between recording start and authoritative finalization cannot lose
  source or actor classification.
- Botik, other automation, unknown actors, and absent legacy rosters cannot
  support a knowledge answer, while their authoritative audio remains available
  to unchanged transcription and recovery workflows.
- Craig v1 recordings continue through the existing post-call path but are
  deliberately ineligible for knowledge features.
- Providers other than Craig can supply the same source and actor vocabulary at
  their own anti-corruption boundary without entering Meeting Core.
- Question admission, transcript evidence, generation, Discord Reply, and
  external-effect recovery remain later decisions and implementations.
