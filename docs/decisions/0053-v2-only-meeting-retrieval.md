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

Focused addressed voice obtains historical candidates only through that same
V2 locator port. Meeting Knowledge concurrently resolves the authoritative
generation-current live hot tail, locally rehydrates both sources, and applies
the fixed live-rank-then-historical-rank interleave up to the existing focused
candidate cap. The combined canonical hash and both generation identities are
recreated before generation, publication and playback. Exhaustive voice keeps
its every-block route and never treats the V2 top-k response as completeness.

Discord custody derives `dactor1.<key-id>.<HMAC>` actor keys under the fixed
`discord-meeting:infinity-actor-key:v1` purpose. A versioned secret keyring has
one active key and may retain prior keys during rotation. New projections use
the active key; alias filters expand through the same keyring. The active key
profile salts only historical index generations, forcing an orderly rebuild
without changing stable room topology. Missing or malformed mapping authority
fails before indexing or retrieval. Snowflakes, names, and aliases cannot
occupy an upstream `actor_keys` field.

Valid provider `available`, `unavailable`, and `unqualified` responses retain
their status. The exact provider reason code crosses the consumer port;
`unavailable` is retryable and `unqualified` is nonretryable. Malformed wire or
capability evidence remains the separately classified adapter failure.

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
- focused voice retains bounded live-plus-historical behavior without a second
  downstream retrieval engine;
- Discord identity rotation is explicit and rebuild-fenced;
- the migration ledger records exact retained and deleted symbols.
