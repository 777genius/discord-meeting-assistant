---
id: ADR-0009
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0009: Self-service Discord guild onboarding

## Status

Accepted.

## Context

The deployed V1 routes every meeting to one results channel from process
configuration. Adding another Discord guild therefore requires an operator even
though Craig lifecycle events already carry the source guild and voice-channel
identities.

Discord recording and meeting intelligence remain separate deployable
components. The current isolated deployment deliberately gives both processes
one official bot identity, so administrators install the product once. A future
deployment may give Craig a distinct bot identity; Discord cannot install two
bot applications through one authorization grant.

## Decision

Introduce a `Guild Installation & Configuration` bounded context with an
executable `/setup-voice-bot` vertical slice.

- The aggregate owns one active configuration per Discord guild: the selected
  voice channel, results channel, configuring user, and optimistic revision.
- Application use cases depend on narrow repository and Discord-verification
  ports. Domain and application code contain no Discord SDK or PostgreSQL types.
- The Discord inbound adapter registers a guild-only `/setup-voice-bot` command, requires
  `Manage Guild` both declaratively and at runtime, validates channel types and
  least-privilege bot access, and publishes a visible configuration check before
  persistence is accepted.
- The public install endpoint redirects to Discord's guild-install authorization
  URL with the union of publishing and voice permissions when both components
  share one bot identity. The wizard still verifies Craig voice access. With a
  distinct Craig identity it provides an explicit second install URL when absent.
- Installation uses `bot` and `applications.commands` scopes without an OAuth
  callback, authorization-code exchange, or persisted Discord user token.
- Composition resolves a meeting publication target from `(guildId,
  voiceChannelId)`. The existing configured target remains a compatibility
  fallback for the private E2E guild while installations migrate.
- Craig reads a bearer-authenticated `{ schemaVersion: 1, channels }` snapshot
  of active `(guildId, voiceChannelId)` pairs from Meeting Platform. The
  boundary deliberately omits results-channel routes, administrator identities,
  revisions, and credentials.
- New meetings publish as direct channel messages. Thread mode remains an
  explicit deployment option and is not widened by onboarding.

## Consequences

- An administrator can install and configure a guild without Developer Portal
  access or operator-managed channel IDs.
- Multi-guild routing no longer leaks into Meeting Core or Discord publishing.
- The current user-facing flow has one application-install step without merging
  the Craig code or process boundary. A distinct-identity deployment has two
  explicit install steps.
- Removing the compatibility fallback requires a later migration proving every
  active guild has a persisted configuration.
