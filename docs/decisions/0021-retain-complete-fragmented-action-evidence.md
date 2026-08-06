---
id: ADR-0021
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0021: Retain complete fragmented action evidence

## Status

Accepted on 2026-08-06.

## Context

ADR-0020 requires one action to retain evidence for its owner, deliverables,
deadline, and result destination. A real authoritative Deepgram transcript split
one such commitment across eight turns. The existing four-turn evidence bound
made the complete action impossible to prove even though its rendered summary
text was correct.

## Decision

- Final summary policy v14 permits an action item to cite up to eight existing
  authoritative transcript turns.
- Decisions, topics, and open questions retain their four-turn evidence bound.
- The provider prompt requires the smallest strong evidence set, while allowing
  all eight action evidence turns when fragmentation makes them necessary.
- Evidence verification continues to require every claimed action detail to be
  present in the cited turns.

## Consequences

- A fragmented action can prove its owner, deliverables, deadline, acceptance
  condition, and result destination without inventing or merging turn IDs.
- The wider action-only evidence bound does not increase rendered Discord prose
  or relax semantic evidence matching.
- Policy v14 receives a new deterministic request identity and cannot reuse v13
  provider output.
