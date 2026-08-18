---
id: ADR-0037
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0037: Release-bound Meeting Knowledge qualification

## Status

Accepted on 2026-08-18. This decision extends ADR-0035 without changing its
official SDK, deletion, or local-evidence authority decisions.

## Context

A release label supplied as a Docker argument is not source provenance. A stale
or operator-selected label can otherwise make different source appear to be the
release that passed semantic qualification. A Git commit label also does not
make a qualification reproducible when the checkout is dirty.

Two-hour retrieval needs a separate retained acceptance source. Merely checking
that an injected evidence digest, release revision, and rollout epoch are
well-formed does not prove that the tuple was reviewed. Legacy recording
receipts may also lack authoritative duration, so sparse transcripts cannot be
used to infer that such a meeting was short.

## Decision

- CI and local source builds generate Meeting Platform provenance only from a
  clean Git checkout. The root-owned runtime artifact binds the exact commit,
  Git tree, and SHA-256 of the canonical tree listing. The image does not accept
  release provenance from a Docker argument or runtime environment variable.
- Production startup fails closed when that artifact is absent or malformed.
- The semantic qualification runner rejects a dirty checkout. Its versioned
  manifest binds the exact commit, canonical source-tree SHA-256, frozen corpus
  digest, and a digest over the committed qualification harness sources.
- Two-hour serving consumes a manifest from an immutable configured file. The
  loader hashes the exact bytes and compares the manifest digest, evidence
  digest, release revision, source-tree SHA-256, and rollout epoch with the
  centrally retained acceptance for this release.
- Until a reviewed two-hour manifest is retained in the acceptance registry,
  production cannot activate the gate. A programmatic or environment-authored
  tuple is not acceptance evidence.
- Missing authoritative duration is conservatively long-call ineligible unless
  the independent two-hour qualification is active. A v2-v4 completion receipt
  remains readable, but its absent duration can never bypass this gate.
- These serving decisions do not alter indexing, reconciliation, deletion, or
  the authority of original recordings and final transcripts.

## Consequences

- Reproducing a qualified release requires the same clean source tree and
  committed harness, not only the same operator label.
- A retained manifest is deployable only by the exact release and rollout epoch
  that accepted it.
- Existing short meetings with v5 authoritative duration continue through the
  ordinary path. Legacy unknown-duration meetings remain searchable only after
  independent long-call qualification.
- Local source builds must generate provenance before constructing the image.
