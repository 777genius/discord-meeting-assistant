---
id: ADR-0063
status: proposed
supersedes: []
superseded_by: []
---

# ADR-0063: Current retrieval generation fence and candidate isolation

## Status

Proposed on 2026-08-28 as the explicit successor to ADR-0050. On acceptance it
will supersede ADR-0050 while retaining its official-SDK custody and immutable
Retrieval V2 request rules.

## Context

ADR-0050 did not distinguish candidate-local failures from authority failures,
did not bind durable grounding to exact retrieval exchanges, and allowed source
or job drift between hydration and answer-provider input. Separate adapter and
SDK timers also made deadline versus cancellation classification race-dependent.

## Decision

The Retrieval V2 adapter computes one monotonic absolute operation deadline and
passes its remaining duration plus the caller's original abort signal to the
official SDK. The SDK alone owns request timers. Deadline exhaustion maps to
retryable `request_timeout`; caller cancellation takes deterministic precedence
and maps to nonretryable `cancelled`.

Every selected focused evidence item durably retains locator, provider lane and
query, rank and scores, capability/profile fingerprint, release/index/transcript
identity, and canonical request and selected-result digests. The decoder
recomputes those digests and binds them to the persisted question retrieval
binding. Provider prompts continue to receive only authoritative locally
rehydrated transcript text, never provider text or provenance sidecars.

After selection and measurement, one PostgreSQL transaction locks the active
question generation and selected meeting-source authorities, rehydrates all
references in one bounded snapshot batch, proves the current anchor projection,
release/index/transcript generations, withdrawal absence, and exact canonical
turn hashes, then persists the exact plan and measurement. Failure prevents the
answer-provider call. Source enumeration is repeated around generation checks;
overflow or churn aborts so no source can hide beyond the cap.

Hard actor and relative-meeting-time filters are reapplied to each canonical
turn after historical block rehydration and on the local exact-document lane.
A block-level match never admits another speaker or an out-of-window turn.

Candidate-local malformed locators, missing turns, stale hashes, and actor/time
mismatches isolate that candidate when a valid survivor remains. Batch query or
snapshot failure, anchor-authority drift, room-authorization failure, source
catalog ambiguity, pagination overflow/churn, or transaction failure aborts the
entire attempt because those failures cannot safely be attributed to one
candidate.

Composition derives each retrieval profile fingerprint from a canonical,
versioned preimage. Copied digest literals are not policy authority.

## Consequences

- Provider input is fenced by the same durable job and evidence identities that
  are persisted for retry and audit.
- Candidate corruption does not discard unrelated valid evidence, while an
  uncertain batch or authority never degrades into partial authorization.
- Deadline and cancellation outcomes are stable under timer ordering and load.
- PostgreSQL integration qualification still requires disposable infrastructure;
  absence of that infrastructure is reported rather than replaced by mocks.
