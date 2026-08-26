---
id: ADR-0055
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0055: Deadline-bound durable participant greetings

## Status

Accepted

## Context

ADR-0051 allowed a greeting command committed inside the five-second join
window to start later during provider or crash recovery. It also admitted a
greeting only after the conversation idle barrier and relied on the producer to
replay a lifecycle event after durable HTTP acceptance. Those choices do not
guarantee an absolute first-audio deadline or durable derived-effect delivery.

Craig owns the actual Discord voice send and its durable command deduplication.
That implementation is external to this repository, so the platform can
strengthen and test the boundary but cannot self-attest the final send.

## Decision

The producer occurrence remains the greeting deadline anchor. Fresh scheduling,
receipt recovery, provider invocation, provider queueing, and the first Discord
send are all fenced by the same exclusive five-second not-after instant. The
runtime rechecks freshness immediately before invocation. A commanded receipt
recovered at or after its original deadline becomes terminal `suppressed/stale`
without a provider call.

The provider-neutral playback request and Craig `playback-start` command carry
the absolute not-after value. Craig session readiness must attest that a queued
start is suppressed at or after that value before any Discord frame is sent.
The Node gateway also rejects an already-expired open and suppresses PCM if the
deadline passes before provider-confirmed start. A late timestamp is evidence of
failure; it cannot make an already-audible late frame acceptable.

Greeting admission does not wait for the conversation-wide idle barrier. It
uses the existing meeting-local supersession/cancellation authority to cancel an
active answer or prior greeting. The sole Craig playback session remains the
overlap fence. A stuck session is bounded by cancellation and the incoming join
deadline; suppression is preferred to overlapping or late audio. Participant
queue order remains deterministic. When all members of an ordinary close burst
have prepared cues, they retain distinct sequential commands; dynamic cohort
rendering remains the bounded fallback when individual prepared cues are absent.

For every actor-qualified V2/V3 incremental human join, HTTP admission writes a
PostgreSQL derived greeting obligation before acknowledging the request. The
event-ID-keyed obligation retains the normalized meeting, participant,
occurrence, not-after instant, and optional trusted-memory observation. Delivery
is marked complete only after the live bridge proves the participant crossed
into durable or terminal greeting receipt state. A missing live owner,
unavailable playback session, or transient finalized-memory/persistence failure
leaves the obligation pending for the singleton 100-millisecond reconciler.

Replay uses the original lifecycle event and stable per-participant receipt
identity. Deadline expiry atomically terminalizes the obligation and any
reserved or commanded receipt as stale, so restart, duplicate delivery, and
reconnect cannot create new late audio. The authoritative recording and every
post-call path remain independent of this derived effect.

The production source remains inside the existing Meeting Platform application,
live-runtime, Meeting Core conversation-contract, Craig contract/adapter, and
PostgreSQL adapter boundaries. The new source files are classified by those
closed roots; no new package or cross-context dependency is introduced.

## Consequences

Ordinary prepared two-participant bursts can start in deterministic order inside
the deadline without overlapping playback. Under hostile transport stalls, one
or more greetings may be durably suppressed rather than becoming audible late.
Known Russian and English names retain their deterministic literal greetings;
unknown participants retain the anonymous greeting without a spoken name.

The repository proves contract carriage, local pre-send suppression, durable
obligation replay/expiry, and idempotent receipt recovery with providerless
tests. Release still requires independent evidence that the external Craig
implementation durably deduplicates the command and enforces not-after before
the actual Discord send. No repository fixture or Craig capability declaration
is sufficient proof of that external behavior.
