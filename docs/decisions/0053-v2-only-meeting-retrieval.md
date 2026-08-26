---
id: ADR-0053
status: proposed
supersedes: []
superseded_by: []
---

# ADR-0053: V2-only meeting retrieval composition

## Status

Proposed on 2026-08-26.

## Context

ADR-0049 requires deletion of the downstream generic historical retrieval
engine after Retrieval V2 is available. ADR-0050 made the Retrieval V2 request
durable, while retaining a migration route until the operational drain gate.
The production slice now needs one narrow meeting-owned request and no
constructible generic retrieval fallback.

## Decision

New jobs persist and send exactly one bounded original question. Canonical
speaker IDs, meeting-relative time, record kind, scope, and accepted source
generations are hard filters. The consumer neither decomposes nor weights the
question. The Infinity adapter returns provider-ordered opaque locators and
does not expose or consume remote score, rank, text, fusion, reranking, or
neighbor data.

Meeting Core rehydrates locator evidence from authoritative local sources and
rechecks authorization, retention, generation, and source identity. Local
fallback is bounded exact-token matching with deterministic quotas and order;
it is not semantic retrieval and does not expand neighbors.

Production composition constructs only the V2 route. Persisted protocol-1,
`infinity_locator_v1`, and `legacy_downstream_v1` values remain decodable for
audit and recovery, but fail closed before retrieval. The generic historical
engine and `/v1/search` read adapter are deleted.

## Deployment prerequisite

Code deletion does not prove that the operational drain occurred. Deployment
is blocked until operators produce a checked receipt proving zero nonterminal
or leased old-path jobs, zero unresolved old-path effects, an expired rollback
window, and fully drained old-profile deletion.

## Consequences

- no active legacy generic retrieval engine is constructible;
- remote text and ranking metadata cannot become meeting evidence;
- old job schemas remain safely readable and fail closed;
- the migration ledger records exact retained and deleted symbols.
