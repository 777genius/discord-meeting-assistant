---
id: ADR-0074
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0074: Align focused production and qualification retrieval budgets

Accepted on 2026-09-08. Owner: Meeting Knowledge; Infinity Context adapter owns
qualification provider-input enforcement. This amends the focused deadline
guidance of ADR-0053 and the provider-input contract introduced by ADR-0052;
prior accepted decision bytes remain unchanged.

## Decision and scope

Raise only the default focused locator Retrieval V2 `deadlineMs` and its matching
qualification provider-input contract from 1,000 to 2,000 ms. The existing
Meeting Knowledge application policy and adapter qualification contract retain
their owners and source-dependency classifications; no package or source file is
added. Explicit overrides and all other budgets remain unchanged: 100 candidates,
100 maximum sources, 10 results, zero neighbor radius, 16,000 evidence bytes,
16,384 response bytes, and four maximum evaluation queries. Answer budgets,
models, all qualification thresholds, and retrieval p95 <= 3,000,000 us are
unchanged. This engineering default is not a quality acceptance relaxation.

Official SDK 0.2.4 and the Retrieval V2 wire schema remain unchanged; the existing
wire ceiling admits 2,000 ms. Global operation, transport, and per-request limits
are unchanged. The adapter still shares one monotonic absolute deadline across
capability GET and retrieval POST, limits each request to the remaining budget,
propagates caller cancellation, and rejects late or partial results. Unknown
outcomes remain unknown and must not trigger blind retries or new reservations.

## Exact identity and compatibility

The policy label `meeting-knowledge.locator-retrieval.v2`, wire `schemaVersion: 2`,
and provider-input schema
`meeting_knowledge.semantic_quality_provider_input_contract.v1` remain stable.
The complete budget is already present in the canonical request snapshot and
provider-input contract; no schema or policy-label churn is required. Existing
request snapshots retain their original budget and are never rewritten.

Canonical provider-input SHA-256 changes from
`ca773c4516342ea2e034ba2714fddd5742a80e78761944ea20f5da7a43317bf3`
to
`4db64ccd3e115a253702f803fd1091dc3df754592ca422e46a718057bbcc9931`.
`qualificationExecutionBinding` carries that digest. The scheduler validates the
binding against the current contract, and signed terminal provider accounting
must match it exactly. A valid signature on old 1,000 ms accounting still fails
closed. Retain old receipts as evidence of their original execution; never
relabel or re-sign them as 2,000 ms qualification. New qualification requires
fresh input bindings and execution evidence under the new digest, plus the
existing release and admission checks.

## Supporting controls and limits of the evidence

The owner supplied these synthetic diagnostic observations; they are not newly
executed qualification in this change:

- Main r8 first retrieval timed out at 1,131 ms with zero model reservations.
- Independent official SDK 0.2.4 real loopback used 12 cases. A 350 ms GET plus
  750 ms POST aborted near 1,000 ms: remaining POST time was about 640 ms while
  the wire budget was 1,000 ms. Nine other cases passed; this is not a 12/12 pass
  claim or a populated-query latency distribution.
- Actual backend empty control at 1,000 ms: GET 576.930 ms, remaining POST budget
  357.4 ms, POST abort 357.237 ms, total 1,017.419 ms, unknown outcome.
- A separate new synthetic namespace at 2,000 ms: GET 390.443 ms, POST 434.837 ms,
  total 915.291 ms, valid empty response and completed telemetry.

These controls support removing an overly tight default. They prove neither
retrieval quality nor populated-query p95. Server-stage optimization remains
separate work. Client remaining-time cancellation is distinct from propagating
the remaining absolute deadline into the server's wire budget; this change does
not implement that propagation. No original recording, authoritative transcript,
or meeting database evidence changes.

## Verification

Focused regressions pin production/evaluation parity, unchanged wire and contract
schemas, the 3-second p95 threshold, stale signed accounting rejection, and
bounded shared-deadline/caller cancellation behavior through the official SDK.
Existing qualification and repository gates remain required; synthetic controls
cannot substitute for release-bound qualification.
