---
id: ADR-0025
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0025: Cumulative live summary and layered Discord evidence

## Status

Accepted on 2026-08-08.

## Context

ADR-0007 deliberately made the live summary a selective snapshot. In a long
meeting that policy could replace material early context with the newest turns,
even though the finalized live transcript remained durable. The separate final
publication from ADR-0016 also left the last live draft visible after the final
summary was published, which made the stale draft easy to mistake for the final
result. Inline evidence made the Discord summary harder to scan while the full
evidence-backed result was not attached as its own artifact.

## Decision

- A live summary is a compact cumulative synthesis. Each revision receives the
  previous validated summary, the exact finalized turns cited by that summary,
  every newly unsummarized finalized turn, and a bounded recent context window.
- Material earlier topics, decisions, actions, and open questions remain unless
  later evidence explicitly resolves, contradicts, or supersedes them. Related
  information may be merged to stay within the compact live schema. Recency by
  itself is not a reason to forget earlier meeting meaning.
- The authoritative final Discord embed contains clean summary prose without
  inline quotes. The same publication attaches `meeting-summary.md` with the
  complete evidence rendering and `meeting-transcript.md` with the complete
  authoritative transcript.
- A retry that reconciles an already-created final message adds the localized
  note `Updated after final processing`. A fresh publication does not.
- In separate-message mode, successful final publication replaces the old live
  projection with a localized superseded notice. A missing/deleted live message
  is already retired; transient edit failures remain retryable.

This decision refines the selective-snapshot policy in ADR-0007 and the retained
live-draft consequence in ADR-0016. It does not change the separate durable
identities of live and final projections or the authority of the final recording,
transcript, and evidence-backed summary.

## Consequences

- Long meetings preserve their accumulated meaning while live summaries remain
  bounded and provider-neutral.
- Old live drafts no longer compete visually with the authoritative result.
- Discord stays readable, while full evidence remains available for audit.
- If final publication succeeds but live retirement fails transiently, the job
  retries idempotently and reuses the same final message.
