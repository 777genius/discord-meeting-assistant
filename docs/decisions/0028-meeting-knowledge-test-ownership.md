---
id: ADR-0028
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0028: Meeting Knowledge test ownership

## Status

Accepted on 2026-08-13.

## Context

ADR-0027 requires Foundation to own the Meeting Knowledge feature and its test
path. Foundation 0.6.0 correctly owns the production feature, but treats every
governed import as runtime source. Governing the Vitest path would therefore
reject its development-only `vitest` dependency and Meeting Core's intentional
public self-import. Moving either dependency into production would misrepresent
the package architecture.

## Decision

- Foundation continues to own the exact Meeting Knowledge production boundary.
- The repository-local architecture baseline owns the exact
  `packages/meeting-core/test/features/meeting-knowledge` path until Foundation
  has an explicit development-test classification.
- The baseline fails closed when the path is absent, empty, or contains a source
  file outside the `.test.ts` convention.
- Vitest remains development-only and tests continue exercising the package's
  curated public subpath.

## Consequences

- The test path is classified and checked without weakening production
  dependency rules.
- Foundation remains pinned to registry version 0.6.0.
- A future Foundation version with explicit test-source semantics may replace
  the repository-local check through a successor decision.
