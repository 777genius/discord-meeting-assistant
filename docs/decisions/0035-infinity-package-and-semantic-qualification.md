---
id: ADR-0035
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0035: Separate immutable Infinity package and semantic qualification

## Status

Accepted on 2026-08-15. This decision corrects ADR-0031's package-activation
description and narrows its production qualification consequence without
changing its evidence-authority, topology, rehydration, or exhaustive-coverage
rules.

## Context

ADR-0031 was accepted before the official SDK consumer artifact was retained in
this repository. The repository now intentionally commits
`vendor/infinity-context/artifacts/infinity-context-sdk-0.1.0-897efd21.tgz` and
pins it from `pnpm-workspace.yaml`; npm still does not publish
`@infinity-context/sdk`. The retained r26 disposable-service manifest proves the
official SDK transport, mutations, reconciliation, and deletion path, but uses
`deterministic-mock-non-production-v1` embeddings and explicitly records
`qualifiesProductionSemanticEmbeddingQuality: false`.

Treating that one manifest as a universal activation qualification would let a
non-production embedding profile authorize production search. Conversely,
denying the whole adapter would prevent an already-authorized deletion from
draining.

## Decision

- The consumer dependency is the committed immutable tarball above. Its
  SHA-256 is
  `93ea6c98dec53c886250f3a3a06cb3825da27d1fc5ff73b85ab9633273e6bc1a`
  and its lockfile integrity is
  `sha512-ohD89uSSlW7zT/BqaEufIBZ7EAVcq1LYAWn/rRel8EOyMAnq5DXSh3PqjYXAYJdE9WsHgLWx7Tysy9jAY7XaHw==`.
  The reviewed source remains upstream commit
  `897efd211151e9a81a7466fdd6be5cb067ddb8eb`, package tree
  `67a744b1accc0d4628c19f28849660bc917b8b62`, and canonical archive SHA-256
  `1aad93c1c9deea91f0c0ec750b99e91d1092e9d208751e11c6231badd5fbd9d2`.
  The ignored sparse checkout is only a review and reproducible-rebuild input;
  production package provenance is not waiting on npm publication.
- Immutable SDK/package provenance, official HTTP transport qualification, and
  deletion-drain qualification are one base gate. They may authorize indexing,
  mutation reconciliation, and deletion independently from serving.
- Production semantic search has a separate fail-closed gate. It requires an
  immutable release-pinned embedding-profile attestation whose exact retained
  manifest digest matches this release and whose
  `productionSemanticQualification` is `true`.
- A missing attestation, `false` qualification, mismatched digest,
  deterministic/mock/non-production profile, or the retained r26 manifest can
  never authorize production search. Search denial does not disable deletion.
- One resumable index or delete attempt has a separately bounded overall
  deadline. Every official-SDK request inside it receives a fresh per-request
  deadline composed with caller cancellation. Timers and listeners are cleared
  after settlement. Retry and reconciliation reuse deterministic mutation IDs.

## Consequences

- The immutable official SDK artifact and disposable transport qualification
  are retained and hash-verifiable.
- Production semantic search remains disabled until a non-mock embedding
  profile passes the frozen recall suite and its exact attestation is pinned in
  a reviewed release.
- Authorized deletion continues under disabled indexing, serving, or semantic
  search and after per-attempt timeout through normal durable reconciliation.
