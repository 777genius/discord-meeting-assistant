---
id: ADR-0018
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0018: Bound summary output to the provider contract

## Status

Accepted on 2026-08-06.

## Context

Final transcription can split one sentence into several authoritative turns.
Preserving all material details without an explicit cardinality rule can cause a
provider to exceed the compact summary schema, including during bounded repair.

## Decision

- Final summary policy v11 treats adjacent same-speaker fragments as one
  semantic utterance while retaining their existing authoritative turn IDs.
- Every JSON Schema `maxItems` and `maxLength` remains a hard output bound.
- Evidence uses the smallest strongest set allowed by the schema. A workflow
  requiring additional evidence uses separate allowed topic points rather than
  an oversized evidence list.
- Material details are compressed into allowed fields; they are neither dropped
  nor expressed by widening the v4 boundary contract.

## Consequences

- Fragmented STT remains authoritative while provider output stays bounded and
  parseable.
- Policy v11 receives a new deterministic request identity and cannot reuse v10
  provider output.
