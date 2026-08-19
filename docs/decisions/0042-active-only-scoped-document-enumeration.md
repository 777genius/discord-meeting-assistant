---
id: ADR-0042
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0042: Active-only scoped document enumeration

## Status

Accepted on 2026-08-19. This decision narrows the public listing contract from
ADR-0041 without changing its exact-scope deletion reconciliation.

## Context

Independent review found that revision 9b5 allowed callers with memory read
authority to request deleted documents through the scoped collection endpoint.
Deletion cleanup needs GET by document ID to observe a tombstone, but collection
enumeration does not need deleted rows and could expose retained metadata.

## Decision

Pin the direct child revision
`15809619e61ae76f45d04176d1b681a78bf41de3`. Public scoped document listing is
active-only in the core query, HTTP contract, OpenAPI schema, and TypeScript SDK.
The SDK rejects any non-active status before transport. Direct GET by document ID
continues to expose deleted lifecycle state for deletion reconciliation.

The package identities are:

- SDK tree `5c08ffaa071b2a4e511ad8096b1fbf828f1e4145`;
- canonical SDK-source archive SHA-256
  `a14b3d0c071b08fcef003436f4f46b52b948f734e8093096abc699c09d5deaa8`;
- complete source bundle SHA-256
  `7589f280963392853e3402c1ce48157930e21fac79490c27275bdfff0ffbbf91`;
- official npm tarball SHA-256
  `a59e128c9c0b38c9e665f1da608cb5df09d25f2d14677d32f1a44d6eefc6efe9`;
- npm integrity
  `sha512-+g8mKVBvJCJWkpmMgUUBjwPZT86Q6KIIwVADy2nLvxfR8n5leA+gHJL/0JU8oYfG08tOlonSLfhPo4JxH+2q5Q==`.

The retained predecessor PostgreSQL and ASGI evidence continues to qualify only
the unchanged active listing and deletion transport. The active-only delta is
qualified by server/OpenAPI tests, the full official SDK verification, and
bidirectional 93/93 parity. It does not qualify production ingest, processing,
dense-profile indexing, or semantic search. Production indexing and search stay
fail-closed until exact-head qualification exists.

## Consequences

Memory readers cannot enumerate tombstones. Cleanup remains able to confirm a
known deletion by ID. The adapter also rejects repeated document identities
across fresh cursor tokens and delegates the cursor length contract to the pinned
official SDK, while retaining page-count, page-size, response-shape, and deadline
bounds.
