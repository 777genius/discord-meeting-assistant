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
even though finalized live turns remained available as derived working data.
The original Craig recording, final transcript, and meeting database are the
authoritative evidence and resolve conflicts; live transcripts and generated
summaries are derived. The separate final publication from ADR-0016 also left
the last live draft visible after the final summary was published, which made
the stale draft easy to mistake for the final result. Inline evidence made the
Discord summary harder to scan while the full evidence-backed result was not
attached as its own artifact.

## Decision

- A live summary is a compact cumulative synthesis. Each revision receives the
  previous validated summary, the exact finalized turns cited by that summary,
  every newly unsummarized finalized turn, and a bounded recent context window.
- Every earlier topic, decision, action, and open question has a distinct
  same-kind successor that retains all of its evidence-turn lineage. Later
  evidence may revise that successor to record resolution, contradiction, or
  supersession, but cannot silently delete it. Provider output that drops this
  lineage is rejected before persistence. Recency by itself is not a reason to
  forget earlier meeting meaning.
- The authoritative final Discord embed contains clean summary prose without
  inline quotes. The same publication attaches `meeting-summary.md` with the
  complete evidence rendering and `meeting-transcript.md` with the complete
  authoritative transcript.
- A retry that reconciles an already-created separate final message adds the
  localized note `Updated after final processing`. A fresh publication does
  not. Legacy replace-live presentation always uses the initial body because
  its shared physical receipt cannot safely distinguish first finalization from
  replay.
- In separate-message mode, successful final publication replaces the old live
  projection with a localized superseded notice. A missing/deleted live message
  is already retired; transient edit failures are non-fatal best-effort cleanup.

This decision refines the selective-snapshot policy in ADR-0007 and the retained
live-draft consequence in ADR-0016. It does not change the separate durable
identities of live and final projections. The Craig recording, final transcript,
and meeting database remain authoritative evidence; the live transcript and
evidence-backed summaries remain derived artifacts.

## Consequences

- Long meetings preserve their accumulated meaning while live summaries remain
  bounded and provider-neutral.
- Old live drafts no longer compete visually with the authoritative result.
- Discord stays readable, while full evidence remains available for audit.
- Live retirement is best-effort and cannot invalidate a successful final
  publication. Guaranteed cleanup retries require a separate durable reconciler.
