---
id: ADR-0039
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0039: Bounded evidence selector accounting

## Status

Accepted on 2026-08-18 as a clarification of ADR-0030's grounded final-reply
provider boundary.

## Context

Dense retrieval may return up to forty canonical candidate windows. Passing all
of them to answer generation weakens focus, while running a semantic selector
outside durable provider accounting permits ambiguous replay and misleading
audit state.

## Decision

- Subscription Runtime admits the dedicated Sol/medium, stateless,
  tools-disabled `discord_meeting.knowledge.evidence_select.v1` purpose.
- The selector receives only opaque candidate IDs, bounded snippets, speaker
  references, timestamps, and the question. Canonical turns remain local and
  are rehydrated only from returned IDs.
- The worker reserves one durable provider attempt before selection. Selector
  request identity is bound to that attempt ID, and a successful selection
  continues into answer generation under the same attempt.
- Deterministic refusal, fallback, or selector failure changes the attempt from
  `reserved` to terminal `failed` before a fixed reply is published. A crash
  while still reserved remains fail-closed and cannot authorize replay.

## Consequences

- Selector and answer execution share one auditable, replay-safe operation.
- Summary, conversation, answer, and coverage profiles cannot satisfy the
  selector purpose.
- Provider snippets never become authoritative evidence; citations still bind
  only to locally rehydrated canonical transcript turns.
