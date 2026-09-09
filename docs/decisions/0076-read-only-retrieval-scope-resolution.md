---
id: ADR-0076
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0076: Resolve retrieval topology before request identity

Meeting Knowledge owns the consumer scope-resolution port and focused request
preparer in `packages/meeting-core/src/features/meeting-knowledge/application`.
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
the request identity and IDs against the same resolver's immutable authority. Each
successful resolution binds exactly one frozen prepared request. A WeakMap keyed
by that request retains authority only while the request is owned; later reads,
failures, and collection volume cannot replace or evict it. Copied requests and
foreign resolver instances fail closed. Binding is out of band and adds no fields
to serialized requests or their hashes. No additional metadata read occurs there.

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
