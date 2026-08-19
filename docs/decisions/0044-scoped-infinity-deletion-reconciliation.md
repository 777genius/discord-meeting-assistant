---
id: ADR-0044
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0044: Scoped Infinity deletion reconciliation

## Status

Accepted on 2026-08-19. This decision narrows ADR-0031 and ADR-0043 without
changing their local-authority, scope-isolation, or fail-closed rules.

## Context

The b77 service did not implement collection GET. Replaying document ingest to
recover a missing remote ID is unsafe because ingest itself can enqueue derived
projection work even when `/process` is never called. Thread counters and
known-ID GET alone also cannot prove that duplicate active source documents are
absent.

Upstream revision `9b5c0e38bf46cdabe32698c84e62e1711a8b0aee` adds an
exact-scope, status-filtered, opaque-cursor document listing. Its official SDK
package tree is `74f071f748591a26f1721dfba1c9742f7a8fb9d1`; the canonical
SDK-source Git archive SHA-256 is
`b95264ecd7b94943b718fa99d34aabff387beadcf9ce6cdf5cd72146cddd3091`.
The unmodified official npm tarball SHA-256 is
`8f8015583ba3ccb71b1654d11ad6af111881ceedde68dec52241edc431981dc0`.
These are distinct source and package identities.

## Decision

- Deletion may issue known-ID GET, exact-scope active document listing,
  DELETE-by-ID, and GET-by-ID only. It never ingests or processes a document.
- Every list page binds the exact space, room scope, and meeting thread. Only
  the canonical meeting-evidence source type and persisted source external IDs
  are deletion targets. All matching duplicate IDs are deleted.
- Pagination must reach an explicit terminal cursor. Malformed, repeated,
  empty-progress, oversized, timed-out, or over-bounded cursor chains fail as
  `absence_unverified`.
- A stale, missing, wrong, or foreign known-ID binding is never deletion
  authority. After DELETE and GET verification, a second complete exact-scope
  scan must contain no active target before `verified_absent` is returned.
- Production qualification binds retained manifest SHA-256
  `42807626aa1867c8d9663fa4a8c9ad27cc08c0d2eb93adbcea8f138a3f230c43`,
  PostgreSQL migration evidence SHA-256
  `4331f5ca203cdc6a2b2c654820675a51a355fffc4ad0f900e1f7c33c9e1850ba`,
  SDK-ASGI-PostgreSQL evidence SHA-256
  `63a31a0f2ea0a40b7802612838ea045998a59bda2646236e7a88190923e84487`,
  and API parity baseline SHA-256
  `d7e58a5d8d1ef010c413d2b76a35ac196ee6f5ba7033573fcab100fca040fa97`.
  This transport/deletion qualification does not enable semantic serving.

## Consequences

- Unknown ingest outcomes and lost DELETE responses converge without creating
  new remote content, while crash/restart remains driven by the persisted plan.
- Provider or pagination ambiguity preserves authoritative meeting evidence and
  retries cleanup instead of claiming absence.
- High npm audit findings retained by the official SDK are development-only and
  recorded with qualification evidence; dependency changes remain upstream.

## Rejected alternatives

- Same-mutation compensation ingest: it can enqueue projection before cleanup.
- Thread counters or known IDs as absence proof: neither discovers duplicates.
- Unbounded or partial scope scans: they cannot prove target absence.
