---
id: ADR-0043
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0043: Attach the authoritative transcript to final publication

## Status

Accepted.

## Context

The derived live-caption projection is useful while a meeting is active, but
the authoritative final transcript can exceed Discord embed limits. Repeating a
bounded subset beside the final summary presents incomplete final evidence.

## Decision

Final Discord publication omits the derived live-caption projection, publishes
the accepted evidence-backed summary, and attaches the complete authoritative
transcript as `meeting-transcript.md`.

The attachment preserves speaker attribution and timestamps. Both the default
separate final publication and the compatibility `replace-live` mode remain
idempotent. The authoritative transcript and meeting database remain the source
of truth; the attachment is a rendered transport projection.

## Consequences

- The final Discord message contains a concise summary and complete transcript
  attachment instead of a necessarily bounded final caption preview.
- Every authoritative transcript turn remains available in the attachment.
- Live captions remain derived and replaceable while the meeting is active.
- Other publication adapters may choose a transport-appropriate complete
  transcript representation without changing Meeting Core.
