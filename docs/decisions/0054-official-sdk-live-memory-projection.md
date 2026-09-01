---
id: ADR-0054
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0054: Official-SDK finalized-live memory projection

## Status

Accepted on 2026-08-26 for the Meeting Knowledge active-memory slice.

## Context

ADR-0032 established the finalized-human application outbox, local hot tail,
generation fencing, canonical rehydration, and shared grounded-answer use case.
The meeting-specific slice also needs qualified transient retrieval through the
official Infinity SDK without making remote text authoritative or weakening
the locator-only V2 read boundary.

## Decision

- The finalized-human-turn transaction writes one text-free outbox mutation.
  Interim STT, automation speech, captions, summaries, bot answers, and full
  transcript prefixes cannot create this mutation.
- A consumer-owned application port projects one canonical finalized human
  turn per document. Composition alone selects the Infinity adapter. The
  adapter uses only the official SDK, a stable HMAC document identity, opaque
  topology and actor keys, and the active identity generation.
- A request that expires in flight or returns `outcome_unknown` enters a
  distinct durable state. Restart recovery reconciles the exact scope, source
  type, and stable document identity before retrying the same mutation. It
  never retries first or generates a new identity.
- Corrections remain append-only finalized turns. Accepting the corrected final
  historical generation atomically ends local live authority, clears its hot
  tail, and changes applied live documents to durable retirement intent.
  Source withdrawal performs the same retirement. A lost delete response is
  reconciled to scoped absence before another delete.
- PostgreSQL enqueue and applied timestamps define ingest-to-query latency.
  Query admission reports `pending`, `degraded` at exactly 5,000 milliseconds,
  and `backpressured` above 128 pending mutations. The metrics adapter exports
  a labeled histogram with a five-second bucket for the p95 qualification.
- Discord reply admission, ACL and effect reconciliation remain Publishing and
  Meeting Knowledge responsibilities. Voice uses the same
  `AnswerGroundedMeetingQuestion` path and live generation. Remote text is not
  evidence; bounded locators are always canonically rehydrated locally.

## Consequences

- Crashes on either side of an SDK mutation do not duplicate ingest or delete.
- The accepted final transcript supersedes transient evidence atomically at the
  local authority boundary while remote retirement remains durable and
  replayable.
- Provider failure degrades only derived meeting memory. It cannot alter or
  delete the recording, transcript, meeting row, summary, or publication.
