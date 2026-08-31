---
id: ADR-0060
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0060: Authenticated quality-campaign runner boundaries

## Status

Accepted on 2026-08-26. This decision extends ADR-0052.

## Context

ADR-0052 requires production-faithful qualification, but an executable runner
also needs explicit trust, custody, recovery, cleanup, and infrastructure
boundaries. Decoded provider metadata, caller-transitive authority, ambiguous
blind retries, and operator-selected cleanup subsets cannot be qualification
evidence.

## Decision

- Provider and evidence adapters return authenticated raw receipts/envelopes.
  Application reconstruction accepts only locally opened AES-256-GCM bytes and
  exact capability-to-retrieval-to-answer terminal chains. Each terminal binds
  the request, result envelope, release, spend reservation and per-call spend
  receipt, question, repetition, call kind, ordinal, campaign, and terminal
  state. Ambiguous effects use the same-identity status port and are never
  replayed blindly.
- Quality-campaign application sources contain deterministic reconstruction and
  consumer-owned ports only. Filesystem journals/checkpoints/input custody,
  encryption, HTTP, wall clocks, timers, and bounded scheduler mechanics are
  classified as adapters; production assembly is the only concrete selection
  point.
- Cleanup consumes one signed campaign-created complete derived-artifact
  inventory disjoint from protected originals. Deletion outcomes and exact-set
  absence are independently signed. The isolated holdout authorization binds
  its question, locator, derived-artifact, key-namespace, and spend-reservation
  inventories, and holdout retention is non-qualifying.
- Independent adjudicators and the resolver are pinned by role and public-key
  fingerprint. A resolver receives both complete signed conflicting decisions.
- The installed runner has one canonical per-question application use case. Its
  execution packet contains only the question identity, locale, exact text,
  source classification, and an opaque signed scope/topology reference. Gold
  evidence locators, claims, speaker/time authority, and abstention authority
  are admitted only by scoring after a terminal encrypted outcome exists.
- The production execution adapter composes Meeting Knowledge's single original
  query and hard filters, the official Infinity Context SDK (100 candidates,
  10 results, zero neighbors, one SDK attempt), selected-locator-only PostgreSQL
  rehydration, and the Subscription Runtime grounded-answer mapper. Infinity
  exclusively owns fusion, deduplication, and reranking; provider scores remain
  audit provenance and never enter the answer prompt.
- The reusable Subscription Runtime gRPC transport and protobuf contract belong
  to `@discord-meeting/subscription-runtime-adapter`. Meeting Platform consumes
  that adapter and no quality runner may deep-import Meeting Platform source.

## Consequences

- Runner adapters may integrate with launcher-owned release and spend authority
  only through narrow signed contracts; the runner does not duplicate the
  launcher's atomic spend ledger.
- Evidence that is unsealed, unrelated, incomplete, ambiguously terminal, or
  selected by an operator fails closed.
- Holdout evidence is retained and cleaned under isolated custody but never
  changes main qualification.
- Provider-capable qualification composition cannot live in excluded test
  source. Provider-free structural fakes are non-qualifying and must not become
  a second historical engine.
