---
id: ADR-0055
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0055: Exact Craig hosted stack recovery

## Status

Accepted

## Context

The private-guild coordinator owns a disposable Craig Compose project. A failed
provision retained authoritative evidence and its campaign lease, but no
production command could safely distinguish that project from an unrelated
Docker resource and complete cleanup. Repeated failures could therefore retain
an unbounded number of projects and deterministic subnets.

## Decision

`apps/discord-e2e-actors` remains the feature owner and its existing
`e2e.discord-actors` Foundation boundary remains the closed source-dependency
classification for admission, network policy, teardown, recovery, and retained
evidence verification.

- Fresh admission performs one effect-free Craig preflight before artifact
  layout, lease, credential, firewall, or Docker effects. It binds the campaign
  root, canonical credential path, compiled release, canonical Compose digest,
  complete deterministic network plan, readiness timeout, and a compiled
  SHA-256 credential authority. Plaintext credentials remain only in the
  private input and process environment and never enter a receipt.
- The bot source and bridge enter an exact terminal-drop `INPUT` chain before
  the existing `FORWARD` policy. No host-local service is required, so the host
  chain contains no accept rule. The `FORWARD` chain retains only PostgreSQL
  TCP 5432, Discord TCP 443, the compiled UDP range, established return traffic,
  and one terminal drop.
- Firewall uninstall is allowed only after a stopped-bot proof. Its ownership
  fence accepts only the complete exact installed policy or complete absence.
  Partial, unknown, or duplicate chain/dispatch state fails closed for retained
  manual diagnosis and is never completed by destructive guessing.
- Successful teardown independently proves the exact containers, network, and
  volume absent and binds that proof to campaign, project, plan, and release.
- Before the mutation receipt is created, effect-free Compose authority records
  the exact per-service configuration hashes. Recovery recomputes that closed
  authority and requires every retained container label to match its service
  hash before stop, firewall removal, or down.
- A mutated failure retains a strict failure receipt and lease. The explicit
  `recover:craig-stack` command verifies mutation/failure custody, exact Docker
  ownership labels, plan, release, and lease; stops the bot; removes policy and
  resources idempotently; proves absence; removes the retained lease; and emits
  one strict create-only recovery receipt. An existing receipt is terminal only
  after its exact campaign, plan, network, volume, prior container identities,
  project-labeled inventory, and firewall absence are proved again from current
  host state. Fresh campaigns never adopt failed resources.
- Fresh admission stops at eight unrecovered Craig failures. Evidence is not
  deleted; operators must run exact recovery. This bounds resource accumulation
  without weakening retained failure authority.

## Consequences

Recovery needs host-side Docker and iptables authority and is intentionally
separate from Discord execution. It cannot contact Discord, use bot tokens, or
operate on a project whose exact labels and retained identities do not match.
All stack, mutation, lease, teardown, recovery, pass, and cleanup evidence uses
closed schemas and cross-binding digests.
