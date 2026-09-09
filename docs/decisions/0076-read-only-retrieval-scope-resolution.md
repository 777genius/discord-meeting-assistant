---
id: ADR-0076
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0076: Resolve retrieval topology before request identity

Meeting Knowledge owns the consumer scope-resolution port and focused request
preparer in `packages/meeting-core/src/features/meeting-knowledge/application`.
Its bounded resolution helper is
`packages/meeting-core/src/features/meeting-knowledge/application/focused-locator-retrieval-v2-scope.ts`,
classified by the existing closed `core.meeting.knowledge` source root.
Infinity's external space slug and room external reference are not its internal
space and memory-scope IDs. Indexing resolves them; retrieval must do so too.

The Infinity adapter at
`packages/infinity-context-adapter/src/infinity-retrieval-scope-resolution.ts`
uses SDK 0.2.4 `spaces.listSpaces` followed by `spaces.listMemoryScopes`. It never
creates topology and never substitutes an external reference for a missing ID.
Each collection must contain exactly one matching row with a valid internal ID;
the selected memory scope must belong to the selected space. SDK 0.2.4 provides
only a limit, with no cursor or total: a collection of 100 or more cannot prove
completeness and is denied. Unexpected pagination metadata is also denied.
Each response is limited to 65,536 bytes before SDK parsing. Both reads share a
500 ms preparation budget, linked to caller cancellation. The existing 2,000 ms
retrieval request budget and all quality thresholds remain unchanged.

Serving, diagnostic, and canonical factories compose this adapter. Preparation
resolves IDs before the canonical request digest or retrieval reservation exists.
The captured retrieval payload is never rewritten. Serving rehydration verifies
the request identity and IDs against local authority. Each successful preparation
binds exactly one frozen request in the resolver's WeakMap. Later resolutions,
failures, and collection volume cannot replace or evict that authority.

Persisted serving has a separate worker handoff: admission copies the prepared
request, persistence serializes it, and `QuestionBinding` validation clones it
again on lease. The worker's focused request preparer registers that exact frozen
validated request only after the existing authorization, policy, and current
binding fences. This local WeakMap binds request identity, canonical scope/room,
and exact serialized request value; an arbitrary copy has no worker authority.
It is bounded by request lifetime, adds no serialized fields, and does not change
request bytes or their digest. No quality-campaign or composition fixture changes
are required by this handoff.

For that worker-bound request, historical rehydration performs fresh bounded SDK
scope resolution and requires both internal IDs to equal the persisted IDs. A
missing, inactive, changed, or ambiguous mapping denies retrieval. Local worker
scope validation must succeed before those reads; external names alone cannot
authorize a copied request. A failed refresh never falls back to old preparation
authority. Live prepared requests retain their independent identity binding and
the original concurrent-resolution behavior. Historical authorization and local
snapshot/canonical-evidence checks remain mandatory; provider text has no authority.

Canonical and diagnostic execution reserve both metadata GET effects separately
before sending them. Canonical spend identity uses capability ordinals 1 and 2;
ordinal 0 remains the capability endpoint. Encrypted bounded metadata evidence
retains route/request and response digests, byte counts, and observed outcomes,
without names, external references, or response bodies. An interrupted read remains
unknown in its reservation and cannot authorize retrieval. These reads consume
caller deadline time and count toward the existing effect cap; authorization and
quality limits are not expanded implicitly.

The existing `core.meeting.knowledge` and `adapters.infinity-context` boundaries
own these files; the dependency classification exposes the new adapter entrypoint.
Tests use synthetic references deliberately different from IDs and SDK transport
fakes. This change makes no claim of provider-backed recall qualification.
