---
id: ADR-0056
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0056: Terminal-evidence greeting reconciliation

## Status

Accepted

## Context

ADR-0055 made incremental greetings durable, but an unknown PostgreSQL result
after committing `reserved -> commanded` could be observed as `in_flight` on
replay. Treating that observation as delivery allowed the obligation to become
terminal without provider playback or durable suppression evidence. Lifecycle
timestamps can also retain precision finer than the millisecond runtime clock,
while the obligation constraint binds occurrence and deadline exactly.

Meeting-start rosters still contain no individual join occurrence. Anchoring a
roster greeting to meeting start would invent participant timing evidence.

## Decision

A derived greeting obligation is delivered only after the live bridge observes
terminal playback or durable suppression. `reserved`, `commanded`, and
`in_flight` are non-terminal states and cannot settle the obligation.

If this process loses the result of a command transition, it records a local
recovery-required state. Same-process replay performs the existing fenced
takeover with the same stable provider command. Restart replay uses that same
takeover through restored ownership. An unrelated `in_flight` observation stays
pending; it is never converted to greeted. Recovery is bounded by the original
exclusive join deadline and the provider recovery window. At deadline expiry,
the obligation store atomically suppresses any reserved or commanded receipt and
expires the obligation. These transitions remain idempotent across duplicates
and crashes.

The derived obligation canonicalizes the accepted occurrence to the same exact
millisecond used to calculate its not-after instant. The public lifecycle
contract continues accepting finer valid fractional precision; only this
millisecond-owned derived state is canonicalized.

Meeting-start rosters establish presence only. Only an actor-qualified
incremental join, retaining its producer occurrence in the durable obligation,
can schedule or recover a greeting. No actual join time is inferred for an
initial-roster participant.

Reconcile interval callbacks observe and log dispatcher rejection so a transient
ledger failure cannot become an unhandled promise rejection.

## Consequences

An accepted incremental join remains pending through an ambiguous commit and is
either replayed once with its stable command or durably suppressed. Late crash
recovery emits zero audio. Initial-roster participants are not proactively
greeted until the producer supplies individual join evidence in a future
backward-compatible contract.

Authoritative recording ingestion still precedes this derived effect, and no
greeting failure changes recording or post-call evidence ordering. External
release proof remains the private-guild campaign required by ADR-0055.
