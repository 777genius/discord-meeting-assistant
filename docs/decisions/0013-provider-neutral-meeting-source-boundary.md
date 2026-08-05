---
id: ADR-0013
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0013: Provider-neutral meeting source boundary

## Status

Accepted.

## Context

The Meeting Platform application accepted Discord guild/channel identifiers and
Craig RTP/Opus field names. Its live runtime also resolved a Discord publication
target. The source-dependency graph was mechanically clean, but this vocabulary
made another meeting provider require application changes.

## Decision

Application recording commands identify their origin as an opaque `scopeId` and
`roomId`. Inbound provider adapters map their wire identity to that source.
Durability is a consumer-owned port; the Craig implementation is selected in
composition through an outbound anti-corruption adapter.

Live audio is normalized at the inbound edge to mono Opus at 48 kHz with generic
packet sequence, media timestamp, and payload fields. A provider that cannot
produce this format must transcode before calling the application boundary.

Publication routing is resolved once by application coordination from the
normalized source. The derived live runtime receives only the resolved target,
meeting identity, lifecycle time, and normalized audio. Discord guild/channel
mapping remains in the Discord outbound adapter. Guild installation and
configuration remain intentionally Discord-specific bounded-context behavior.

The authoritative recording and durability-before-derived invariants remain
unchanged. Zoom, Google Meet, or another source is added as its own adapter and
composition choice, not as branches in application or domain code.

## Consequences

- A new provider implements source ingestion, canonical audio normalization,
  durability, and publication-target mapping without changing Meeting Core or
  the live runtime.
- Provider identifiers remain opaque outside adapters; cross-provider identity
  unification is not implied.
- The initial canonical live codec is intentionally narrow. Supporting another
  internal codec requires a new decision and compatibility tests.
- Executable architecture rules reject Discord/Craig/RTP identifiers in the
  application boundary and live contracts.
