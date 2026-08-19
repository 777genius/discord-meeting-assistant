---
id: ADR-0042
status: accepted
supersedes: [ADR-0013]
superseded_by: []
---

# ADR-0042: Provider-neutral meeting source routing

## Status

Accepted. Supersedes ADR-0013 while retaining its normalized recording and live
audio boundary.

## Context

ADR-0013 removed Discord and Craig vocabulary from recording application and
live-runtime contracts, but deliberately left installation routing
Discord-specific. That remaining core validates Snowflakes and persists
`guildId`, `voiceChannelId`, and `resultsChannelId`, so adding another real
meeting source still requires changing domain and persistence code.

## Decision

Application recording commands continue to identify their origin by opaque
`scopeId` and `roomId`, with provider wire and audio vocabulary mapped by ACLs.

Meeting Source Routing replaces Guild Configuration as the routing owner. Its
deterministic aggregate stores opaque `sourceId`, `roomId`,
`publicationTargetId`, and `configuredByActorId` values. It has no dependency on
Discord, Craig, provider SDKs, clocks, environment, or randomness.

Discord setup maps guild, voice-channel, results-channel, and user Snowflakes to
that contract and performs all Discord validation and permission checks. The
Discord publication-target adapter maps application `scopeId` to routing
`sourceId`. The Craig configuration adapter maps active neutral rooms back to
Craig's versioned guild/channel wire response.

PostgreSQL migrates existing guild installation snapshots atomically to the
neutral schema without changing identity, revision, or route meaning.

## Consequences

- Domain, application, live-runtime, and persistence routing code are provider
  neutral.
- Existing Discord setup and Craig HTTP payloads remain backward compatible.
- A future provider supplies real ACL and composition adapters; no speculative
  provider registry is introduced.
- Provider identifiers remain opaque and are not unified across providers.
- Recording, transcript, summary, and failure-isolation invariants are
  unchanged.
