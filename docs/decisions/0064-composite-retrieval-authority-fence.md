---
id: ADR-0064
status: accepted
supersedes: [ADR-0050]
superseded_by: []
---

# ADR-0064: Composite retrieval authority fence and candidate isolation

## Status

Accepted on 2026-08-28. This decision supersedes ADR-0050, reconciles ADR-0053,
and leaves ADR-0063 reserved for the live-branch integration decision.

## Decision

Every protocol-2 focused job persists provenance schema 1. It seals the exact
original question, admitted speaker/time hard filters, deterministic
local-current algorithm/profile identity, and—when historical retrieval is
available—the exact Infinity capability/profile and Retrieval V2 request. The
composite profile separately binds bounded lane round-robin, local-first
interleave, deduplication, and candidate policy. Local candidates carry only
their local lane identity; an Infinity fingerprint on that lane is invalid.

One canonical verifier recomputes request and per-result digests, query and
contribution membership, provider and consumer lane identities, rank order,
and composite interleave. It runs on same-run output, after canonical hydration,
during voice historical hydration, and inside the final repeatable-read
persistence/generation fence. Restart first performs closed structural decode;
the canonical verifier then runs with locally rehydrated authority before any
generation can be admitted. Invalid same-run or restarted provenance therefore
cannot reach answer generation.

Historical authority is loaded through one consumer-owned room snapshot port.
Its PostgreSQL adapter cursor-paginates at bounded page/source limits inside one
read-only repeatable-read transaction and returns the current catalog,
generations, plans, and accepted meetings. Page failure, overflow, ambiguous
ownership, cursor failure, or catalog mismatch aborts the attempt. Only
malformed candidate content inside a successful batch may isolate.

Speaker and relative-time admission is `absent | valid | denied`. Only absent
permits an unfiltered lane. Confusable/ambiguous identity, an unknown direct
actor, malformed recognized time, and reversed time deny admission. Both lanes
derive local filtering from the sealed request.

The final transaction locks the question and selected sources, rehydrates and
verifies the exact plan, checks withdrawals and message tombstones, persists
the plan/measurement, and reserves the provider attempt atomically. It is the
last asynchronous checkpoint before generation. Discord create/update/delete
handling is serialized per question. Bounded edit/delete tombstones precede
cancellation and are observed under the admission advisory lock. Fresh question
and referenced bot-message identity, author, content hash, container, and
canonical projection are checked before generation/effect reservation; bounded
startup reconciliation repairs missed events.

Composition fingerprints are SHA-256 hashes of complete canonical versioned
preimages for local, Infinity, and composite profiles. Acceptance rotates the
cutover and question-policy epochs so partial older bindings fail closed.

## Consequences

- provider and local ranking identities cannot be confused;
- batch uncertainty never degrades into partial authority;
- same-run corruption and restart corruption fail before the LLM;
- exhaustive plans and provider attempts share one final evidence transaction;
- focused voice retains verified audit without treating it as evidence text.
