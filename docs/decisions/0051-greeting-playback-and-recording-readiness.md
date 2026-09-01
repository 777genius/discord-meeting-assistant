---
id: ADR-0051
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0051: Provider-attested greeting and ready-only recording publication

## Status

Accepted

## Context

A durable `attempted` marker before audio avoided duplicate greetings but could
also turn a process crash into a silently lost greeting. Separately, final
Discord publication could expose a possession URL before authoritative speaker
audio existed. Serial greeting admission also has no honest behavior for a
cluster whose individual cues cannot all start inside the producer-anchored
five-second deadline.

## Decision

Greeting playback uses a stable, opaque provider command ID. PostgreSQL records
`reserved -> commanded -> started -> played|suppressed`; `commanded` retains an
expiring recovery lease and is retried with the same command ID, while
provider-attested `started` is terminal for replay. Activation fails if legacy
ambiguous or unattested played greeting attempts exist; migration never derives
provider start from a local completion timestamp. Craig/Pipecat must deduplicate
the stable command for at least five minutes (the durable recovery lease is two
minutes), command and attest first audible output. A duplicate command after
provider start must replay the original `startedAtMs`, never the retry observation
time; absence of any capability disables greeting activation rather than
weakening the claim.

On a reused meeting owner, recovery fences and takes over an active `reserved`
or `commanded` receipt immediately rather than waiting two minutes. A stale
reserved owner cannot durably admit a command after takeover. A commanded owner
may race only by repeating the identical stable provider command, whose required
Craig/Pipecat deduplication is the audible-once fence.

The commanded receipt also retains the bounded locale and literal cohort copy.
Recovery therefore reissues an identical command even if participant lifecycle
events are delivered in a different order after restart. Provider-start and
terminal transitions apply atomically to every receipt sharing that command.
A participant carrying such a recovered command is never attached as a follower
to a newly rendered cohort; its immutable command is retried independently.
The five-second deadline closes only fresh scheduling. A command committed inside
that window remains immediately recoverable after the deadline, including a long
stale restart, and the provider must return its original first-audio timestamp.

The producer occurrence timestamp remains the only anchor for the absolute
five-second join-to-first-audio deadline. A supported join cohort is bounded to
twelve humans and is rendered as one multilingual RU/EN response. At most seven
configured names are spoken; anonymous humans and configured humans beyond that
copy bound are counted in their resolved locale. One command gives every
admitted human the same provider-attested first-audio timestamp. Automation is
excluded before cohort admission. Capability-less V1 lifecycle identifiers have
no actor semantics and are therefore ineligible for proactive V1 greetings; V2
and V3 admit only actors explicitly classified as human. A thirteenth human in
the same open cohort is rejected as `capacity`, with a per-participant terminal
receipt; it is never reported as played.

Before waiting for idle, durable command admission, and provider invocation, the
runtime selects the earliest producer-anchored deadline among every proposed
cohort member. A later high-priority join cannot extend an earlier initial-roster
member's budget. Capacity suppression becomes locally terminal only after its
durable receipt transition succeeds. Batch restoration atomically ignores
already-terminal and commanded receipts, then terminalizes overflow only among
greetings that remain due, so reordered recovery cannot admit a thirteenth fresh
greeting. Every actor-qualified incremental V2/V3 human join runs the same
atomic reconciliation, including while playback is unavailable; no newly queued
join may proceed to playback until that generation commits. Failed persistence
blocks playback and is retried on subsequent ticks and after restart.
The capacity transaction retains each admitted receipt in a meeting-scoped plan,
so completed sequential commands still consume the same twelve-human bound and
concurrent incremental transactions cannot each observe spare capacity.

If named or cohort literal TTS proves zero audio, the same durable attempt makes
one immediate prepared anonymous RU/EN cue attempt. It retains the stable Craig
command identity; ambiguous, partial, or provider-started outcomes never fall
back or replay.

Provider-start attestation persistence receives three immediate internal attempts
with the same command and timestamp. Exhaustion terminalizes the command as
ambiguous and cancels further playback; restart cannot create a second command.

Final summary publication resolves the authoritative recording playback
catalog before rendering. `processing` and `unavailable` never produce a link.
A durable reconciliation obligation retains the final projection identity;
when and only when the catalog reaches `ready`, it performs an idempotent direct
message edit. Workers claim obligations with PostgreSQL `SKIP LOCKED` leases.
Discord exposes no command-id or compare-and-set primitive for message edits, so
the lease cannot honestly prevent an old worker already inside the external call
from overlapping an expiry takeover. The edit is an idempotent replacement of
the same stable message with the same rendered payload; an expired lease is
retryable after restart, and completion remains owner-fenced in PostgreSQL.
`unavailable` terminalizes the obligation without an edit.

## Consequences

Greeting receipts remain per participant even when one bounded cohort command
represents several participants. Completion and abstention logs contain opaque
meeting/participant identifiers, state, reason, and latency only; spoken names
and possession URLs are not logged. Provider harnesses must cover command reuse
before start and no replay after start. Publication harnesses must cover both
`processing -> ready` and `unavailable`.

Craig's meeting-start roster still has no per-participant join occurrence. On
restart, initial-roster recovery can preserve only the supplied meeting-start
occurrence and therefore cannot prove five seconds from an earlier Discord join.
No timestamp is inferred; a future backward-compatible producer field is needed
to remove this bounded limitation.
