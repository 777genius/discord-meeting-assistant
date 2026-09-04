---
id: ADR-0066
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0066: Two-application self-hosting topology

## Status

Accepted on 2026-09-02 for the public self-hosted Compose topology. This later
decision replaces ADR-0009's one-identity deployment choice without changing
its guild-routing and configuration model.

## Context

Recording and publication have different Discord permissions, credentials,
processes, and custody. A combined official application obscures that boundary
and cannot reproduce a user-owned Craig deployment independently of the
publication bot.

## Decision

- The canonical self-hosted deployment has exactly two official Discord
  applications: one user-owned Craig voice bot and one Meeting Platform
  publication bot.
- Their application IDs and mounted token files are always distinct. Craig does
  not publish Meeting Platform results, and the publication bot does not own the
  Discord voice recording connection.
- Administrators install both applications separately into an operator-owned
  private guild with least privilege. User tokens, self-bots, public guilds, and
  the hosted public Craig service are forbidden.
- Meeting Platform may continue to expose separate installation URLs and to
  verify both identities through the existing guild setup flow.

## Consequences

- Secret rotation, incident containment, and permission review preserve the
  recorder/publication boundary.
- Clean-checkout Compose can build a pinned public Craig source while retaining
  a separately owned publication identity.
- Deployments migrating from the earlier combined identity require a second
  official application and explicit private-guild installation.
