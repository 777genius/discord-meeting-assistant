---
id: ADR-0015
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0015: Meeting Core feature modules

## Status

Accepted.

## Context

`packages/meeting-core` was organized as one `domain` layer and one
`application` layer. Files were grouped by technical role, but Foundation saw
the entire package as one `core.meeting` boundary. Conversation, live meeting,
recording, transcription, intelligence, publishing, and post-call processing
could therefore deep-import each other without an explicit architectural edge.
The root package barrel also exposed every capability as one undifferentiated
API.

## Decision

Meeting Core remains one bounded-context package and one deployable unit. Its
production source is organized into real feature modules under
`packages/meeting-core/src/features`:

- `recording` owns authoritative recording artifacts and speaker identity;
- `transcription` owns final transcript versions and transcription ports;
- `meeting-intelligence` owns evidence-backed summaries and generation ports;
- `publishing` owns publication identity, receipts, and publication ports;
- `meeting-lifecycle` owns meeting identity, the authoritative aggregate,
  processing stages, and persistence;
- `post-call-workflow` coordinates transcription, intelligence, and publishing
  without owning their domain models;
- `live-meeting` owns derived live state, timeline, summary, generation, and
  projection behavior;
- `conversation` owns addressed live conversation and playback coordination.

A feature creates only layers that contain real artifacts. Empty DDD folders
are forbidden. Tests mirror these modules under
`packages/meeting-core/test/features`.

Every feature has one curated `index.ts` entrypoint. External consumers import
explicit package subpaths such as `@discord-meeting/meeting-core/transcription`.
The broad package-root export is removed. Cross-feature imports target the
provider feature's `index.ts`; deep imports are rejected by Foundation.

The allowed production graph is directed and deny-by-default:

```text
recording
  <- transcription
  <- meeting-intelligence
transcription + meeting-intelligence
  <- publishing
recording + transcription + meeting-intelligence + publishing
  <- meeting-lifecycle
meeting-lifecycle + transcription + meeting-intelligence + publishing
  <- post-call-workflow
meeting-lifecycle + transcription + meeting-intelligence + publishing
  <- live-meeting
conversation
```

An arrow points from a provider toward its consumer. Conversation owns its own
failure/result vocabulary and has no dependency on post-call lifecycle state.
Other capability ports likewise own their failure contracts. Shared mechanics
must not be reintroduced as `shared`, `common`, `utils`, a universal result, or
a universal domain error module.

Foundation classifies every feature directory as a separate opaque boundary,
declares only the edges above, and treats each feature `index.ts` as its public
entrypoint. Package consumers are granted only the feature boundaries they
actually import.

## Consequences

- Adding behavior starts in an explicit feature instead of a global layer.
- Foundation rejects unclassified files, undeclared cross-feature edges, deep
  imports, and dependency cycles.
- Provider adapters depend on narrow feature APIs rather than the full Meeting
  Core surface.
- Moving behavior between features becomes an explicit architectural decision.
- This refactoring changes module paths but preserves business behavior and
  persisted contract shapes.
