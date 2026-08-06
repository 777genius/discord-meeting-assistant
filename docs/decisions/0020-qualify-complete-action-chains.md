---
id: ADR-0020
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0020: Qualify complete action chains

## Status

Accepted on 2026-08-06.

## Context

One owner can state several neighboring deliverables, then give them one shared
deadline and reporting destination. Fragmented transcription and a nearby
third-party assignment can cause a compact summary to drop one deliverable or
emit a second partial action with no owner.

## Decision

- Final summary policy v13 treats neighboring first-person commitments as one
  action when the speaker explicitly calls them one task or gives them a shared
  deadline or result destination.
- That action retains every stated deliverable and enough authoritative turns
  to support its deliverables, owner, deadline, and destination.
- A less complete nearby assignment from another speaker does not become a
  second partial or unassigned action when it describes the same follow-up.
- The deterministic E2E manifest names every required action deliverable. The
  verifier requires an exact action count and confirms those terms, the owner,
  and the deadline are supported by the cited transcript turns.
- Retained E2E evidence v4 also binds the Subscription Runtime deployment and
  records bounded, non-secret processing and model-execution latency evidence.

## Consequences

- A summary that drops one named deliverable or emits a garbled extra action can
  no longer pass the real Discord acceptance gate.
- Policy v13 receives a new deterministic request identity and cannot reuse v12
  provider output.
- Historical retained evidence v2 and v3 remains readable; new acceptance
  campaigns produce v4 evidence.
