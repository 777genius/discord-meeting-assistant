---
id: ADR-0032
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0032: Live finalized grounded memory

## Status

Accepted on 2026-08-14.

## Context

ADR-0030 introduced a durable grounded Discord reply after a final meeting, and
ADR-0031 introduced final-release historical retrieval. Addressed voice needs
fresh facts from the active meeting without admitting interim STT, Botik output,
summary prose, or remote snippets as evidence. A restart between final STT
commit and projection must not lose a turn, and Discord and voice must not drift
into different provider-generation or citation validators.

## Decision

- Meeting Knowledge admits active memory only from lifecycle generation 3 with
  the exact trusted actor-semantics capability and consistent observations. An
  active unsealed roster may authorize transient memory; final historical and
  Infinity indexing still require the sealed final roster. Automation and
  unknown actors are never admitted.
- Each locally finalized human STT turn is appended with a text-free,
  deterministic mutation in the same PostgreSQL transaction. A fenced worker
  reloads and hashes the canonical local turn, applies generations in order,
  retries with a bound, dead-letters corruption, and maintains a maximum
  64-locator hot tail. Registration backfills pre-existing finalized turns
  idempotently after restart. Source and applied watermarks make incomplete
  freshness observable and fail closed.
- Live candidate search is bounded and text-free at its application boundary.
  The selected locators are separately rehydrated from the append-only local
  transcript, checked against the exact scope, room, active participant roster,
  generation, and content hash, and only then become evidence. Cross-room and
  cross-tenant reads are denied. Live display captions, interim STT, growing
  prefixes, complete transcripts, summaries, questions, answers, and provider
  metadata are never fallback evidence.
- One provider-neutral `GroundedMeetingAnswer` use case owns size admission,
  Subscription Runtime execution, cancellation fencing, strict structured
  output, citation membership, exact-quote validation, and complete-result
  validation. Durable Discord processing and live voice share that use case.
  Discord reply identity anchors the current meeting and room but does not
  restrict authorized same-room evidence to that one meeting.
- Voice obtains an opaque short-lived participant principal, combines the
  generation-current live hot tail with locally rehydrated same-room historical
  blocks, and passes only the bounded selection to the shared use case. A fully
  validated buffered answer becomes literal TTS; cancellation, replacement,
  stale memory, invalid output, or authorization drift yields no late PCM.
- Count, absence, universal, all-item, and broad questions never use focused
  top-k as completeness proof. Final Discord questions use ADR-0031's
  every-block checkpoint, structured select-all extracts, bounded reduction,
  generation and authorization recheck, and final canonical rehydration before
  synthesis. An active meeting is not a complete corpus, so live voice runs the
  historical coverage path but abstains until the active meeting has an
  accepted final release.
- Capability configuration is fail closed. Grounded conversation requires the
  encrypted-principal key. Infinity serving remains independently disabled in
  production until ADR-0031's immutable package provenance and retained live
  endpoint qualification are configured. Local active-memory fallback does not
  claim a live Infinity deployment.

## Consequences

- Finalized-turn freshness survives process restart without making live memory
  authoritative or weakening final transcript admission.
- Discord and voice use one citation and provider-output validator while
  retaining separate transport anti-corruption layers and durability needs.
- A provider, projection, exhaustive-checkpoint, or voice failure cannot alter
  the recording, final transcript, meeting database, summary, or publication.
- The bounded hot tail can answer recent focused questions; it deliberately
  abstains rather than pretending to prove live-meeting completeness.
