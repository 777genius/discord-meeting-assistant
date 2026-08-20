---
id: ADR-0048
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0048: Exact-head Infinity deletion qualification

## Status

Accepted on 2026-08-19. This decision extends ADR-0047. It reaffirms that
decision's active-only exact-scope contract and closes the evidence gap between
its qualified revision and the current service revision consumed by this repository.

## Context

ADR-0047 pinned revision
`15809619e61ae76f45d04176d1b681a78bf41de3`. The retained package was later
repinned through `698537f91162b21070b2f43445650a85e8d90737` to
`249245a98bdae6d357c586aa078374c2a9da728c` for CI lifecycle fixes. Runtime
transport attestation already required the final revision, while production
deletion activation still required only the predecessor 9b scoped-document
manifest. That mixed tuple did not prove the exact package and service head
together.

## Decision

Pin the package, deletion service, and composite qualification manifest to
revision `249245a98bdae6d357c586aa078374c2a9da728c`. The composite manifest
retains the immutable 9b live PostgreSQL and SDK-to-ASGI evidence, the
`15809619` active-only evidence, and the exact `249245a9` delta gates.
Production deletion activation must present the composite manifest digest.

Scoped collection enumeration remains active-only. Deletion reconciliation
continues to operate on one exact space, thread, and memory-scope tuple, while
direct lookup by known document ID may observe deleted lifecycle state.

The exact-head identities are:

- root tree `82c2a0d45c9e4ef18aa643ddc0f4a974f0f327a9`;
- SDK tree `a2ed97138f1d52e33aa04de6efe17c4726baf19e`;
- canonical SDK-source archive SHA-256
  `4ce4b9b2319e2015e8a4c9e81263ff23ae024e468bd6ae4523ee8b0ac95eb97c`;
- complete source bundle SHA-256
  `0168c397b761950e9dd5e7d2586516c773287f0bd101d8900cff961608b358bd`;
- official npm tarball SHA-256
  `8727f751aed94769de8e7aec93ea0b927479a4ab501b3b01c31c2472b6cebc7f`;
- npm integrity
  `sha512-V2RCQKfJ3XMiIXQ7B3F+wvGAu9RJeRYGnDaRIVdT890tLvv0asviGpmsyyM5El7JuNjgPKI+TpdygaoKjxYSDw==`;
- composite manifest
  `docs/operations/evidence/2026-08-19-infinity-exact-head-249245a9/qualification.json`;
- composite manifest SHA-256
  `c972c35ceeb6abcb37529961dc0c844243627c80a9a792944dd776db7c6ac74b`.

The exact-head delta passed 86 SDK tests, 116 server tests, bidirectional 93/93
API parity, file-boundary checks, Ruff, typecheck, build, and consumer install.
Those gates compose with the retained predecessor evidence only for official SDK
transport and deletion reconciliation.

Production indexing and semantic search remain fail-closed. This decision does
not claim exact-head ingest, processing, dense-profile, or semantic quality
qualification.

## Consequences

The production deletion tuple is now internally consistent: immutable package,
service revision, and retained qualification manifest all identify the same
exact head. Predecessor evidence remains immutable and auditable as an input,
but cannot independently activate the current service. Runtime hostile-wire
validation and active-only enumeration constraints remain unchanged.
