---
id: ADR-0031
status: superseded
supersedes: []
superseded_by: [ADR-0049]
---

# ADR-0031: Infinity Context historical memory

## Status

Accepted on 2026-08-13.

## Context

Meeting Knowledge needs same-room historical recall without making a remote
retrieval service authoritative evidence. The reviewed upstream Infinity
Context revision `897efd211151e9a81a7466fdd6be5cb067ddb8eb` contains the
official TypeScript SDK package, but npm does not publish
`@infinity-context/sdk`. Global and absence questions also cannot use a top-k
search result as proof that every authorized source was inspected.

## Decision

- Meeting Knowledge owns purpose-specific `indexFinalMeeting`, `searchRoom`, and
  `deleteMeeting` ports. The production adapter package is
  `packages/infinity-context-adapter`, owned by the Meeting Knowledge feature.
  It imports the official SDK; no SDK type crosses its port and no custom HTTP
  client or Python sidecar is allowed.
- Development links the official package source through an ignored, sparse
  Git workspace at `vendor/infinity-context/.upstream`. A reviewed preparation
  script fetches and checks out only upstream commit
  `897efd211151e9a81a7466fdd6be5cb067ddb8eb`; the linked package tree is
  `67a744b1accc0d4628c19f28849660bc917b8b62`, and its canonical git-archive
  SHA-256 is
  `1aad93c1c9deea91f0c0ec750b99e91d1092e9d208751e11c6231badd5fbd9d2`.
  The preparation script verifies the commit, tree, canonical archive,
  manifest, and lock digests before the package's own lock and build command
  produce its ESM, CJS, and type exports. Neither SDK implementation nor an
  opaque archive is committed to this repository. This generated source
  workspace is development-only. Production indexing, search, and deletion
  reconciliation fail closed until an approved immutable deployed package for
  exactly that reviewed source and a retained live-service qualification are
  configured.
- A final transcript save transaction creates one narrow historical projection
  intent only when source identity, the accepted final transcript, and a sealed
  human roster are locally admissible. Only accepted final human turns are
  represented. Trusted finalized live turns have no historical or Infinity
  admission surface; ADR-0032 admits them only to a separately fenced transient
  local hot tail. Readable display segments, summaries, automation, questions,
  answers, and model-inferred facts have no admission surface.
- Keyed opaque identities derive the guild space, room scope, meeting thread,
  release, index generation, evidence blocks, documents, locators, and mutation
  IDs. Evidence blocks are deterministic, versioned, turn-aligned, and retain a
  local ordered turn manifest and content hash.
- Historical sync persists desired generation, accepted revision, plan,
  deterministic mutation IDs, remote receipts, fenced lease, retries,
  dead-letter evidence for indexing, supersession, and deletion. An authorized
  deletion has no abandoned terminal state and drains even when indexing and
  serving are disabled. Supersession retains an active provider-write lease
  until its deadline so cleanup cannot race a late committed write. Unknown
  remote outcomes reconcile through official SDK reads under the same mutation
  identity.
- Infinity search returns opaque candidate locators only. Every candidate is
  locally rehydrated and reauthorized against the current desired generation,
  scope, room, transcript, roster, retention, and content hash. Remote text and
  metadata never become citations.
- Focused retrieval is the default for both current and historical questions.
  It uses bounded deterministic query decomposition,
  qualified hybrid candidates, deduplication, neighbor expansion, local
  rehydration, lexical/provider reranking, and evidence budgets. Only canonical
  locally rehydrated blocks may reach synthesis: SDK snippets, remote metadata,
  whole transcripts, and growing transcript prefixes never do. A current
  meeting candidate must bind the current index generation. Outage may use a
  bounded authoritative local scan or abstain.
- Count, absence, universal, broad, exhaustive, and all-item questions route to
  an explicit exhaustive path. It canonicalizes every authorized local block,
  persists a fenced coverage bitmap and structured extracts, performs bounded
  hierarchical reduction, rechecks authorization and current generations, and
  permits synthesis only with complete coverage. Top-k is never completeness
  evidence.

## Consequences

- The local meeting database and accepted final transcript remain authoritative
  through provider outage, stale indexes, and deletion ambiguity.
- SDK or endpoint capability drift disables new external work without affecting
  recording, transcription, summary, publishing, or authorized cleanup.
- Production remains disabled until an immutable SDK artifact and a disposable
  live-service qualification attest the exact endpoint capabilities and release.
