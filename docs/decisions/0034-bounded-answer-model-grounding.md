---
id: ADR-0034
status: accepted
supersedes: [ADR-0033]
superseded_by: []
---

# ADR-0034: Bounded answer-model grounding

## Status

Accepted on 2026-08-14.

## Context

ADR-0033 admitted a complete-current grounding mode. Answer-model request size
must instead remain independent of transcript length, and remote retrieval must
not become evidence authority.

## Decision

- Answer-model requests use only `focused_retrieval` or deterministic
  `exhaustive_coverage`.
- `current_complete`, a full transcript, any summary, a transcript
  prefix, and raw SDK text are forbidden model input.
- Infinity returns opaque locators only. Meeting Knowledge locally rehydrates
  and authorizes every cited evidence item before it reaches the answer model.

## Consequences

- Focused misses abstain rather than widening the prompt.
- Completeness claims require deterministic exhaustive coverage.
