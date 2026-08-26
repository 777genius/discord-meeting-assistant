---
id: ADR-0057
status: proposed
supersedes: []
superseded_by: []
---

# ADR-0057: Exact-document live-memory reconciliation

## Status

Proposed on 2026-08-26. This proposal narrows ADR-0054 without enabling
production live projection.

## Context

Scoped document listing cannot reconcile one unknown live mutation: a normal
meeting can exceed any safe page cap, and scanning the whole scope for every
turn creates a reconciliation and retirement deadlock. The published official
Infinity SDK 0.2.0 does not expose an exact document operation bound to the
consumer's stable identity, idempotency identity, generation, and scope.

## Proposed decision

- Unknown ingest, processing, and deletion outcomes use only the official
  SDK's exact-document reconciliation contract. Scoped collection listing is
  not a per-document reconciliation mechanism.
- The consumer-owned compatibility seam is
  `packages/infinity-context-adapter/src/infinity-exact-document-compatibility.ts`.
  It carries document ID, mutation idempotency ID, projection generation,
  source type, space, memory scope, and thread. Conflicting fields fail closed.
- There is no handwritten HTTP fallback. Live Infinity projection fails closed
  behind an explicit external-release pin gate until a reviewed official SDK
  release implements `infinity.document-exact-reconciliation.v1` and its
  immutable artifact and service revision are qualified.
- Cursor pagination is reserved for bounded inventory or cleanup that exact
  operations cannot enumerate. It requires deterministic cursor progress,
  page and item bounds, worker backpressure, and one operation deadline.
- Disposable official-contract tests cover 100, 101, and 2,209 documents,
  unknown outcomes, restart, cross-scope conflicts, and retirement to zero.

## Consequences

Unknown outcomes no longer depend on meeting size, and cleanup can make
bounded forward progress. Production remains disabled until the external SDK
release and exact-release qualification gates are satisfied.
