---
id: ADR-0001
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0001: Separate Craig gateway and modular Meeting Core

Status: Accepted

Date: 2026-08-02

## Context

Craig provides mature Discord voice handling and multitrack recording but uses a
different repository and toolchain. Embedding meeting intelligence into its
recording classes would couple business behavior to Discord internals and make
upstream synchronization unsafe.

## Decision

Keep Craig in a separate fork and treat it as an external Voice Gateway. Preserve
its recording path and add only fault-isolated lifecycle and recording-reference
integration. Build Meeting Core in this pnpm repository as a modular monolith.

Meeting Core owns every consumer-facing port. Craig-specific contracts and
mappings live in an anti-corruption adapter. Provider failure cannot block or
invalidate the original recording.

## Consequences

- Craig and Meeting Core can use different package managers without one mixed
  workspace.
- Contract and adapter conformance are mandatory at the repository boundary.
- Deployment has at least two components, but business code remains independent
  from Discord voice internals.
- Upstream Craig changes remain reviewable as a minimal patch set.
