---
id: ADR-0059
status: accepted
supersedes: [ADR-0058]
superseded_by: []
---

# ADR-0059: Closed Craig recovery authority

## Status

Accepted on 2026-08-26. This decision supersedes ADR-0058's partial-firewall
recovery and persisted-receipt terminality while carrying forward its exact
preflight, ownership, retained-failure, bounded-admission, and no-Discord rules.

## Context

ADR-0058 authorized exact recovery of a retained Craig Compose project, but its
firewall fence allowed known partial policy to be completed destructively. Its
mutation receipt also lacked Compose's per-service configuration identity, and
an existing recovery receipt could be treated as terminal without proving that
the current host still satisfied the receipt's absence claims. These gaps could
let recovery act outside one closed authority or trust stale terminal evidence.

## Decision

`apps/discord-e2e-actors` remains the feature owner, and the existing
`e2e.discord-actors` Foundation boundary remains the closed source-dependency
classification. This successor records the hardened recovery behavior without
introducing another package or runtime path.

- Before the mutation receipt is created, the effect-free Compose inspection
  obtains `config --hash "*"` for exactly the database, migration, and Craig bot
  services. Service names must be unique and complete and every value must be a
  SHA-256 hash. The receipt closes that per-service config-hash authority.
  Recovery recomputes the exact service set and hashes, and every retained
  container's `com.docker.compose.config-hash` label must match its service's
  retained hash before any stop, firewall removal, or Compose down effect.
- Firewall removal still requires a stopped-bot proof, but its ownership fence
  now accepts only the complete exact installed policy or complete absence.
  Partial, unknown, or duplicate chain, declaration, rule, or dispatch state
  fails closed and is retained for manual diagnosis; recovery never completes
  partial firewall custody by destructive guessing.
- Recovery proves absence across every bound representation. It rechecks the
  receipt's exact container IDs, network ID and name, named volume, and retained
  anonymous volumes; Compose must report no project containers; and independent
  Docker label queries must report no container, network, or volume for the
  project. The exact owned firewall chains, declarations, rules, and dispatches
  must also be absent. No one inventory or persisted receipt substitutes for
  this cross-bound absence proof.
- A create-only recovery receipt is terminal only after revalidation against
  current host state. Revalidation binds the exact campaign input, mutation and
  failure receipts, plan, project, release, network policy, absence targets,
  Compose rendering and service config hashes, prior resource identities,
  project-labeled inventory, and firewall absence. A retained campaign lease
  cannot coexist with terminal recovery. Any mismatch fails closed instead of
  accepting the receipt or repeating mutation against a different authority.

## Consequences

Recovery remains host-side, explicit, and unable to contact Discord or use bot
tokens. Ambiguous partial firewall state requires manual diagnosis, and a prior
success receipt must be re-proved rather than trusted as a historical claim.
The authoritative recording and retained failure evidence remain independent of
recovery, and no recovery failure invalidates or deletes them.
