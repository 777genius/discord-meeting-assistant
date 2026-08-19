---
id: ADR-0033
status: superseded
supersedes: []
superseded_by: [ADR-0034]
---

# ADR-0033: Adaptive bounded current grounding

## Status

Accepted on 2026-08-14. Superseded by ADR-0034 on 2026-08-14.

## Context

ADR-0030 established reference-first local rehydration and ADR-0031 established
same-room Infinity candidate retrieval. A bounded current meeting has a stronger
local completeness property than a historical top-k result: every accepted
current human turn can remain available while retrieval only highlights likely
evidence. The same rule is unsafe for an oversized meeting or historical room
corpus because neither a prefix nor top-k proves completeness.

## Decision

- Meeting Knowledge adds `current_complete` as an explicit persisted grounding
  mode. It is available only when every canonical human turn in the bound current
  transcript fits the 256-turn structural limit and the pinned runtime's measured
  request/token budget.
- The text-free focused-memory result carries the complete current reference set
  separately from bounded priority candidates. PostgreSQL derives the complete
  set from the immutable current release. Infinity candidates remain opaque
  locators until local rehydration and same-room authorization.
- `currentTranscriptEvidenceIds` binds every current turn in canonical order.
  `priorityEvidenceIds` is only a relevance hint and may include rehydrated
  same-room historical turns. A retrieval hit cannot remove or replace current
  evidence. The request mapper serializes both sets under runtime policy
  `meeting-knowledge.answer.subscription-runtime.v2`.
- A current transcript above the structural or measured safety limit never uses
  a prefix, truncation, summary, live text, remote chunk text, or metadata. It
  uses a separately qualified bounded `focused_retrieval` path or returns an
  honest fixed outcome. The synthetic two-hour corpus therefore remains
  retrieval-first; it is never sent as `current_complete`.
- Historical absence, universal, count, broad, and exhaustive questions still
  require ADR-0031's every-block `exhaustive_coverage` path. Top-k and
  `current_complete` do not prove historical completeness.
- The voice path remains bounded focused retrieval under ADR-0032. This decision
  changes only the narrow final-reply/same-room grounding contracts.

## Consequences

- A bounded current-meeting retrieval miss cannot hide canonical current
  evidence, while same-room hits can reduce positional attention risk.
- Large meetings retain strict bounded behavior and cannot silently widen a
  prompt.
- Persisted plan codecs and provider prompts distinguish complete current
  evidence, priority hints, focused selections, and exhaustive coverage.
