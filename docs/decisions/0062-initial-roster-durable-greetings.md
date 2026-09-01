---
id: ADR-0062
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0062: Initial-roster durable greetings

## Status

Accepted on 2026-08-27.

## Context

ADR-0055 and ADR-0056 require durable, deadline-bound greetings for qualified
incremental joins and deliberately exclude meeting-start rosters because those
rosters do not prove individual join times. A meeting-start event does,
however, provide a bounded observation that its listed actors are already
present. The human who triggered recording may never produce a later
incremental join, so incremental-only greeting admission can omit that person.

Wire roster order is not business ordering. Letting it determine persistence,
derived participant admission, or greeting delivery would make equivalent
producer events create different observable sequences.

## Decision

`apps/meeting-platform` remains the feature owner, within its existing
application and test source-dependency boundaries. No new package or external
adapter is introduced.

For an accepted V2 or V3 `meeting.started` event, application ingress selects
only actors explicitly classified as human and sorts their actor IDs in
ascending code-point order. That one canonical roster supplies both the stable
per-human greeting obligations and the derived `meeting.started.participantIds`.
Automation and unknown actors remain excluded, and V1 remains excluded because
it has no actor semantics.

Each initial obligation uses
`<start-event-id>:initial:<actor-id>` as its stable identity. It retains the
meeting-start occurrence as a bounded presence observation, canonicalized to
milliseconds, and expires exactly five seconds after that observation. This
does not claim an individual join time. V3 obligations retain the accepted
producer revision and human actor observation. Later qualified
`participant.joined` events keep their existing identities and behavior.

Ingress persists every canonical initial obligation before admitting the
derived meeting start. If any persistence fails, derived start remains
untouched. After all obligations are durable, ingress admits the derived start
with the same canonical roster and delivers each obligation through the
existing terminal-receipt and deadline dispatcher. At or after the five-second
deadline, replay expires the obligation without audio. Completed receipts keep
replay and restart terminal with the same stable command identity.

## Consequences

Equivalent initial rosters have deterministic durable and derived ordering,
including when producer wire order is reversed. The recording remains
authoritative and is accepted before any derived greeting work; greeting
failure cannot invalidate recording or post-call evidence. Initial humans can
receive a proactive greeting only within the existing five-second no-late
boundary, while all ADR-0055 and ADR-0056 recovery and terminality rules remain
unchanged.
