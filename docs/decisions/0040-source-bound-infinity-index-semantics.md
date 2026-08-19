---
id: ADR-0040
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0040: Source-bound Infinity index semantics and migration

## Status

Accepted on 2026-08-19. This decision extends and narrows ADR-0035 while
preserving its official-SDK provenance, evidence-authority, independent
deletion-drain, and fail-closed production rules. ADR-0037 remains an additional
release-bound serving gate.

## Context

The retained b77 canary proves that the exact official SDK can ingest, process,
search, reconcile, and delete through a disposable live service. Its two RU/EN
semantic probes prove transport and profile wiring only. They do not measure
retrieval quality over the retained real 40-meeting population.

The former durable index profile omitted tokenizer artifact/config hashes, the
maximum input size, and the installed `@huggingface/tokenizers` runtime identity.
Two indexes could therefore share a profile ID while producing different token
windows or embeddings. Changing the ID also requires an explicit migration: an
old index must never be reinterpreted as compatible with the new tuple.

## Decision

- The official consumer remains the immutable b77 SDK artifact at commit
  `b77b490cebbf9d80d4204425df3d795b4866ea19`, package tree
  `ac25c12c4733953bf7a4882d5c2c4476589455f2`, canonical archive SHA-256
  `4d96f50ae01f9000e9ac4c50eaa61b4d875c3a452aed58f7e2efe1d69ee8d08d`,
  and package tarball SHA-256
  `2e4bcced4df632a7953c7ff767a4076ce6cfff1aa4469a40e8b36659f29a90c8`.
- The retained b77 transport receipt is
  `docs/operations/evidence/2026-08-18-infinity-b77-semantic-transport/manifest.json`
  with SHA-256
  `sha256:2ba18c3e7b2297e6103fd0d285bb2db424f0d3ac5ea407b857422e3204925133`.
  It binds the installed b77 source, official SDK, service revision, dense
  multilingual MiniLM profile, concrete TEI instance, Qdrant schema, cleanup,
  and the two transport probes.
- `meeting-knowledge.infinity-index.v2` is the SHA-256 of one canonical semantic
  tuple. The tuple includes the b77 service revision and embedding profile ID;
  deployment instance profile digest; embedding model and serving-runtime
  revisions; maximum input tokens; tokenizer artifact, tokenizer-config, and
  conformance-vector SHA-256 values; and the exact `@huggingface/tokenizers`
  package name, version, lock integrity, manifest SHA-256, runtime SHA-256, and
  tarball SHA-256. Every component is identity-bearing.
- Production constructs this identity only from repository-pinned constants and
  the capability-attested instance digest. Operator labels cannot substitute
  for any component. Local tokenizer construction verifies the same artifact,
  config, conformance vectors, package manifest, and runtime bytes before use.
- A v1-to-v2 identity change creates a different desired profile and enters the
  existing durable profile-rebuild workflow. Serving cannot use the new profile
  until every admitted current meeting has completed the exact v2 rebuild.
  Old-profile documents are superseded and cleaned through fenced durable
  mutations; they are never relabeled or interpreted in place. Failure or an
  ambiguous remote outcome remains retryable/reconcilable under the same
  deterministic mutation identity.
- The retained two-probe receipt does **not** authorize production semantic
  search. Search remains disabled until a reviewed, retained evaluation over
  the real 40-meeting population is committed and release-bound under ADR-0037.
  A synthetic corpus, an operator-authored digest, or a runtime echo cannot fill
  that role.
- External indexing is a derived projection and fails closed on any source,
  receipt, capability, tokenizer, profile, or instance mismatch. The original
  recording, accepted final transcript, and meeting database remain authority.
  An already-authorized deletion continues to drain with serving and indexing
  disabled, but only from its durable local intent and fenced exact identities;
  deletion success never authorizes search.

## Consequences

- A semantic component change deterministically creates a new durable index
  identity and requires a complete rebuild before serving.
- The b77 receipt can qualify exact transport and mutation mechanics without
  being overstated as population-level retrieval evidence.
- Tokenizer/runtime drift, partial migration, and stale remote documents fail
  closed without affecting authoritative meeting evidence or deletion recovery.
