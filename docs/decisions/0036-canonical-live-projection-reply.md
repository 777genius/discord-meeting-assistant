---
id: ADR-0036
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0036: Canonical live-projection reply

## Status

Accepted by the product owner on 2026-08-15. This decision narrowly overrides
ADR-0030's exclusion of every live projection; its exact-current-final behavior
and all other security and grounding constraints remain unchanged.

## Context

Meeting Knowledge now has a durable, generation-fenced finalized live-turn
projection and a shared bounded current/same-room retrieval path. Publishing
also persists the exact external identity of its one mutable live-transcript
projection. Those two authorities make one live reply target distinguishable
from arbitrary captions and lookalike messages without trusting Discord text.

Participants need to ask about already-finalized evidence while a meeting is
still active. Waiting for final transcription loses that useful interaction,
while admitting arbitrary captions, drafts, or message content would cross the
evidence and scope boundary established by ADR-0030.

## Decision

- While a meeting is active, Meeting Knowledge may admit a reply only to
  Publishing's exact current bot-owned live-transcript projection. Meeting,
  guild, room, container, projection receipt, participant roster, and finalized
  evidence generation resolve from persisted projection ownership and active
  live-memory identity, never message text, embeds, nicknames, or a requester
  supplied meeting identifier.
- A replaced, stale, or deleted live projection; arbitrary draft or caption;
  non-bot message; wrong guild, channel, or thread; unauthorized participant;
  cross-scope reply; and ended, finalized, deleted, or ambiguous meeting fail
  closed without creating or rebinding a question job.
- Admission binds the exact current live projection receipt, its projection
  epoch, active meeting revision, bot application identity, live-memory source
  generation, canonical finalized-turn hash, human roster, and source scope.
  Atomic admission rechecks the same persisted authorities under locks.
- Retrieval uses the existing bounded finalized-live hot tail and same-room
  historical Infinity candidate path. Candidate DTOs remain text-free; every
  selected turn is locally rehydrated and reauthorized before generation.
  Evidence/citation validation, bounded candidates, dedupe, idempotency,
  concurrency fencing, one-attempt publication, and ambiguous-outcome
  reconciliation are unchanged. No complete transcript or growing prefix may
  enter an answer prompt.
- Ending the meeting immediately revokes live-projection admission. Once the
  accepted final transcript and canonical final projection exist, ADR-0030's
  exact-current-final target is the only admissible projection.
- The live transcript remains derived evidence. This decision changes neither
  final transcript nor final summary authority, rendering, publication, or
  replacement compatibility behavior.

## Consequences

- An authorized participant can receive a cited answer from bounded finalized
  live evidence and same-room history before final transcription completes.
- Exact persisted projection ownership provides the compatibility bridge while
  keeping caption lookalikes and cross-scope replies outside the trust boundary.
- Failure in live retrieval, generation, or answer publication cannot alter the
  recording, live timeline, final transcript, summary, or either canonical
  projection.
