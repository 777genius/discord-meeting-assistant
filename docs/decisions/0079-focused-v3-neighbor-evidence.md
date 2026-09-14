---
id: ADR-0079
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0079: Expand focused V3 evidence with adjacent transcript blocks

Accepted on 2026-09-14. Owner: Meeting Knowledge. The Infinity Context adapter
owns official SDK response custody and maps generic neighbor relations; Meeting
Knowledge owns evidence admission, authoritative PostgreSQL rehydration and
qualification accounting. This amends the focused V3 budget in ADR-0074. Prior
accepted decision bytes remain unchanged.

## Decision and scope

New focused Retrieval V3 requests use seven ranked seeds and neighbor radius one.
Retrieval V2 remains ten ranked results with radius zero. Previously persisted V3
requests with radius zero remain valid and replayable.

The adapter returns ranked seeds and expanded neighbors as separate inventories.
Every neighbor carries an explicit relation containing its seed locator and
distance minus one or plus one. Seed response order and official SDK neighbor
order are preserved. Duplicate seed or neighbor locators are admitted at most
once. Meeting Knowledge interleaves each seed with its neighbors, rehydrates all
admitted locators from the authoritative accepted transcript in PostgreSQL, and
continues to enforce the existing 16,000-byte evidence and 16,384-byte response
ceilings.

Expanded neighbors are evidence context only. Ranked retrieval metrics,
candidate projections and persisted retrievalCandidates contain seeds only.
Selected answer evidence may reference a neighbor only when the exact retained
V3 response bytes reconstruct that neighbor relation. V2 and radius-zero V3
requests reject any expanded neighbor inventory.

## Custody and compatibility

The V3 response digest includes the optional neighbor relation. Canonical
execution reconstructs both ranked seeds and expanded neighbors from retained
official SDK request and response bytes and rejects a runtime projection that
differs from that reconstruction. The final evidence verifier admits selected
turns only from the union of retained seeds and retained expanded neighbors.

No transcript text crosses the Infinity Context boundary. Infinity Context
continues to return opaque locators and generic retrieval provenance; Meeting
Knowledge remains the only owner of transcript authority, authorization,
citation admission and answer selection. The V3 wire schema and official SDK
version remain unchanged.

The canonical qualification provider-input contract keeps schema identifier
meeting_knowledge.semantic_quality_provider_input_contract.v1 and changes its
retrieval budget from ten results with radius zero to seven results with radius
one. Its new SHA-256 is
37822f3223a9c6cc5768264ea67410fe12681b59c84cc35d10b2ed18a3b9ca65.
Existing signed execution bindings and receipts remain evidence of their original
budget and cannot qualify this contract. Qualification requires fresh bindings
and execution evidence.

## Diagnostic basis and limits

A production-bound diagnostic on the private multilingual corpus measured the
current MiniLM deployment at 39.29% ranked Recall@10 and 64.29% complete evidence
recall with the exact seven-seed, radius-one response bound. Retrieval p95 was
581 ms, response p95 was 15,473 bytes, and no request failed. A separate isolated
BGE-M3 diagnostic measured 75.00% complete neighbor evidence recall, but did not
yet reproduce exact final response serialization and is therefore not approved
for production adoption.

The safe diagnostic artifact has SHA-256
fe57637d4482db71d035f27b470676b1b628a852f1c30d203894d704c0a524b1c.
The pre-existing exact safe evidence artifact has SHA-256
36448c76998770ee40ab477f21eea528b22b13ec8b9933bef26bba38e8142c97.
These diagnostics justify the bounded experiment and do not constitute final
quality qualification. Recall@5, MRR@10, final-answer correctness, language
slices and all three canonical repetitions must still pass unchanged thresholds.

## Verification

Focused tests pin V2 and persisted V3 radius-zero compatibility, V3 radius-one
request binding, deterministic neighbor ordering and deduplication, cross-source
rejection, authoritative rehydration, seed-only metric accounting, exact-byte
neighbor reconstruction, selected-evidence membership and PostgreSQL codecs.
Repository changed, fast and complete checks remain required on the exact commit.
