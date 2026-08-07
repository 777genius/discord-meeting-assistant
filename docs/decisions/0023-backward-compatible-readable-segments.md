---
id: ADR-0023
status: accepted
supersedes: [ADR-0022]
superseded_by: []
---

# ADR-0023: Backward-compatible readable segments in batch v2

## Status

Accepted on 2026-08-07. This decision replaces ADR-0022's separate wire-version
rollout while preserving its provider-neutral model, evidence rules, bounded
validation, and raw-turn fallback.

## Context

Readable transcript segments are optional derived metadata. Introducing batch
contract v3 solely for this additive response field creates coordinated rollout,
identity migration, and rollback work without strengthening the authoritative
transcript. JSON consumers already tolerate unknown fields, and new consumers
can safely normalize a missing field to an empty projection.

## Decision

- Keep the Voicetext batch wire contract at version 2. Remove runtime version
  selection and expose optional `readable_segments` only as an additive v2
  response field.
- Keep the existing v2 request fingerprint, job identity, and turn identity.
  Readability metadata does not affect transcription identity, so previously
  completed v2 jobs remain replayable and may legitimately have no segments.
- Voicetext may request provider sentence metadata internally and normalize it
  into bounded text, timing, and source-utterance references. Provider names,
  paragraph structures, source JSON, and parsing rules stay in the backend and
  transcription adapter.
- The adapter maps provider references to the existing v2 raw turn IDs and emits
  only the provider-neutral `TranscriptReadableSegmentSnapshot`. Meeting Core
  validates and persists that neutral projection without knowing its source.
- Raw turns remain authoritative for evidence, summaries, and complete transcript
  attachments. The compact final timeline uses readable segments only when the
  entire projection is valid; otherwise it renders raw turns unchanged.
- Deployments are independently reversible: old consumers ignore the additive
  field, while new consumers accept responses without it. Rolling either service
  back therefore preserves transcription and publication behavior.

## Consequences

- Readability improves without a second live wire version or branching runtime
  paths.
- Existing v2 idempotency and persisted jobs stay valid. Reprocessing is needed
  only when readable segments are desired for an older completed job.
- Rollback can temporarily remove the readability projection but cannot remove
  or invalidate authoritative raw turns, summaries, or recordings.
