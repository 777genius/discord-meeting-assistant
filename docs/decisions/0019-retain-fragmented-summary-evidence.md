---
id: ADR-0019
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0019: Retain fragmented summary evidence

## Status

Accepted on 2026-08-06.

## Context

ADR-0019 refines the bounded-output decision in ADR-0018. Authoritative
transcription can split one semantic commitment across separate
turns for its task, owner, deadline, acceptance condition, and result
destination. The previous two-reference final-summary limit forced providers to
either lose that relationship or emit several misleading action items.

## Decision

- Final summary policy v12 keeps all compact list and text bounds from v11 and
  refines ADR-0018's evidence-reference bound.
- One final topic, decision, action item, or open question may reference up to
  four authoritative turns instead of two.
- Adjacent fragments that form one commitment remain one action item. The
  provider must not split its deadline or result destination solely to fit an
  evidence-reference limit.
- Evidence references remain exact, bounded, and validated against the final
  transcript. No post-provider heuristic invents or merges business semantics.

## Consequences

- Fragmented commitments retain their owner, deadline, deliverable, and result
  destination in one evidence-backed item.
- Final schema and prompt hashes change, so policy v12 receives a new
  deterministic request identity and cannot reuse v11 output.
- The larger bound is still compact and does not change the authoritative role
  of the transcript.
