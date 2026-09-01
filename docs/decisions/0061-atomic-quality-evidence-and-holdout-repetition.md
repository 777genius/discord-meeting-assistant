---
id: ADR-0061
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0061: Atomic quality evidence and holdout repetition

## Status

Accepted on 2026-08-26. This decision extends ADR-0052 and ADR-0060.

## Context

The production quality runner must close three remaining correctness gaps. A
create-only journal record cannot become visible before all bytes are durable;
gold relevance cannot share locator authority; and the isolated 30-question
holdout must exercise the same three-repetition contract as the main campaign.
The runner also contained unused predecessor sources whose imports no longer
matched the accepted execution model.

## Decision

- Operator composition constructs one immutable role-separated authority policy.
  Gold relevance, locator inventory, main and holdout provider results, release,
  spend, review, repetition, cleanup, artifact custody, and holdout authorization
  use distinct pinned authority roles. Requests carry key references and signed
  documents, never caller-selected public keys.
- Create-only attempt records are written and synchronized under an unpublished
  temporary name, atomically linked to their final name, and directory-synced.
  A crash-left temporary record is not an admitted reservation. Conflicting
  publishers fail closed, while identical publishers converge on one record.
- The durable budget journal charges the exact attempt before an effect. Unknown
  outcomes remain charged, terminal reconciliation never refunds them, and
  restart derives state from durable claims and terminal evidence without a new
  provider effect.
- Main execution remains exactly three repetitions of 240 questions. The isolated
  holdout is exactly three repetitions of the same sealed 30 questions, producing
  90 outcomes under three repetition-scoped spend reservations. Its report and
  cleanup remain non-qualifying for the main campaign.
- Cleanup and final admission remain one production path after exact retention
  reconstruction. Final admission consumes independently signed gold relevance,
  provider and adjudication terminal evidence, the exact cleanup absence receipt,
  and protected-original presence evidence.
- Node cryptography and evidence-envelope custody are adapters. Unused predecessor
  durable-adapter and metric-threshold sources are removed rather than classified
  as speculative production surfaces.

## Consequences

- Structural and provider-free tests can prove cardinality, restart, atomic
  publication, authority separation, retention, and cleanup mechanics, but they
  do not constitute provider E2E evidence or a production GO decision.
- Holdout execution requires three signed spend reservations and fails closed on
  missing, foreign, or provider-inconsistent repetition evidence.
